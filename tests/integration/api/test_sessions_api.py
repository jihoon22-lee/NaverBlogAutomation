"""Session batch persistence and transport."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.domain import (
    DiscoverySource,
    DomainValidationError,
    EngagementStepName,
    SessionState,
    SessionTrigger,
)
from naver_blog_assistant.infrastructure.database.engine import create_sqlite_engine
from naver_blog_assistant.infrastructure.database.schema import metadata
from naver_blog_assistant.infrastructure.database.session_repository import (
    SessionAlreadyRunningError,
    SessionNotFoundError,
    SqliteSessionRepository,
)

ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SESSIONS = "/api/v1/automation/sessions"


@pytest.fixture
def repository(tmp_path: Path) -> Iterator[SqliteSessionRepository]:
    engine: Engine = create_sqlite_engine(f"sqlite:///{tmp_path / 'sessions.db'}")
    metadata.create_all(engine)
    yield SqliteSessionRepository(engine)
    engine.dispose()


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{tmp_path / 'api.db'}",
        generator_mode="fake",
        app_environment="test",
        rate_limit_requests=200,
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def approval(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "approved_steps": ["like", "comment"],
        "sources": ["neighbor"],
        "max_posts": 3,
    }
    payload.update(overrides)
    return payload


def create(repository: SqliteSessionRepository) -> Any:
    return repository.create(
        trigger=SessionTrigger.SESSION,
        approved_steps=[EngagementStepName.LIKE, EngagementStepName.COMMENT],
        max_posts=3,
        sources=[DiscoverySource.NEIGHBOR],
    )


class TestRepository:
    def test_a_session_round_trips(self, repository: SqliteSessionRepository) -> None:
        created = create(repository)

        stored = repository.get(created.id)

        assert stored.state is SessionState.PENDING
        assert stored.approved_steps == (EngagementStepName.LIKE, EngagementStepName.COMMENT)
        assert stored.sources == (DiscoverySource.NEIGHBOR,)
        assert stored.created_at is not None

    def test_only_one_session_may_be_active(self, repository: SqliteSessionRepository) -> None:
        created = create(repository)

        with pytest.raises(SessionAlreadyRunningError) as error:
            create(repository)
        assert error.value.session_id == created.id

    def test_a_finished_session_frees_the_slot(self, repository: SqliteSessionRepository) -> None:
        first = create(repository)
        repository.transition(first.id, SessionState.RUNNING)
        repository.transition(first.id, SessionState.COMPLETED)

        second = create(repository)

        assert second.id != first.id
        assert repository.active() is not None

    def test_transitions_record_their_timestamps(self, repository: SqliteSessionRepository) -> None:
        created = create(repository)

        running = repository.transition(created.id, SessionState.RUNNING)
        finished = repository.transition(created.id, SessionState.COMPLETED)

        assert running.started_at is not None
        assert finished.finished_at is not None

    def test_a_backward_transition_is_refused(self, repository: SqliteSessionRepository) -> None:
        created = create(repository)
        repository.transition(created.id, SessionState.RUNNING)
        repository.transition(created.id, SessionState.COMPLETED)

        with pytest.raises(DomainValidationError):
            repository.transition(created.id, SessionState.RUNNING)

    def test_an_abort_records_its_reason(self, repository: SqliteSessionRepository) -> None:
        created = create(repository)
        repository.transition(created.id, SessionState.RUNNING)

        aborted = repository.transition(
            created.id, SessionState.ABORTED, abort_reason="captcha_required"
        )

        assert aborted.abort_reason == "captcha_required"

    def test_processed_posts_are_counted(self, repository: SqliteSessionRepository) -> None:
        created = create(repository)

        repository.record_processed(created.id)
        updated = repository.record_processed(created.id)

        assert updated.processed_count == 2
        assert updated.remaining == 1

    def test_recent_sessions_come_newest_first(self, repository: SqliteSessionRepository) -> None:
        first = create(repository)
        repository.transition(first.id, SessionState.CANCELLED)
        second = create(repository)

        recent = repository.recent(limit=5)

        assert {session.id for session in recent} == {first.id, second.id}

    def test_an_unknown_session_is_reported(self, repository: SqliteSessionRepository) -> None:
        with pytest.raises(SessionNotFoundError):
            repository.get(uuid4())

    def test_no_active_session_reports_none(self, repository: SqliteSessionRepository) -> None:
        assert repository.active() is None


class TestApi:
    def test_an_approval_is_accepted(self, client: TestClient) -> None:
        response = client.post(SESSIONS, json=approval())

        assert response.status_code == 202, response.text
        body = response.json()
        assert body["trigger"] == "session"
        assert body["approved_steps"] == ["like", "comment"]
        assert body["processed_count"] == 0

    def test_a_finished_session_frees_the_slot(self, client: TestClient) -> None:
        first = client.post(SESSIONS, json=approval())
        assert first.status_code == 202

        second = client.post(SESSIONS, json=approval())

        assert second.status_code == 202, second.text
        assert second.json()["id"] != first.json()["id"]
        assert client.get(f"{SESSIONS}/{first.json()['id']}").json()["state"] == "completed"

    @pytest.mark.parametrize(
        "payload",
        [
            approval(approved_steps=[]),
            approval(approved_steps=["like", "like"]),
            approval(approved_steps=["share"]),
            approval(sources=[]),
            approval(sources=["neighbor", "neighbor"]),
            approval(sources=["cafe"]),
            approval(max_posts=0),
            approval(max_posts=51),
            approval(unexpected=True),
        ],
    )
    def test_an_invalid_approval_is_rejected(
        self, client: TestClient, payload: dict[str, Any]
    ) -> None:
        assert client.post(SESSIONS, json=payload).status_code == 422

    def test_a_session_can_be_read_and_listed(self, client: TestClient) -> None:
        created = client.post(SESSIONS, json=approval()).json()

        fetched = client.get(f"{SESSIONS}/{created['id']}")
        listed = client.get(SESSIONS, params={"limit": 5})

        assert fetched.status_code == 200
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["items"]] == [created["id"]]

    def test_cancelling_reports_the_session(self, client: TestClient) -> None:
        created = client.post(SESSIONS, json=approval()).json()

        response = client.post(f"{SESSIONS}/{created['id']}/cancel")

        assert response.status_code == 200
        assert response.json()["state"] in {"cancelled", "completed", "running"}

    def test_an_unknown_session_is_not_found(self, client: TestClient) -> None:
        unknown = "11111111-1111-4111-8111-111111111111"

        assert client.get(f"{SESSIONS}/{unknown}").status_code == 404
        assert client.post(f"{SESSIONS}/{unknown}/cancel").status_code == 404

    def test_the_event_stream_closes_for_an_unknown_session(self, client: TestClient) -> None:
        unknown = "11111111-1111-4111-8111-111111111111"

        response = client.get(f"{SESSIONS}/{unknown}/events")

        assert response.status_code == 200
        assert response.text == ""

    def test_the_event_stream_reports_the_session(self, client: TestClient) -> None:
        created = client.post(SESSIONS, json=approval()).json()

        response = client.get(f"{SESSIONS}/{created['id']}/events")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert "event:" in response.text

    @pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 51}])
    def test_invalid_list_parameters_are_rejected(
        self, client: TestClient, params: dict[str, Any]
    ) -> None:
        assert client.get(SESSIONS, params=params).status_code == 422


class TestScheduleStatus:
    def test_it_reports_the_saved_policy_and_what_blocks_it(self, client: TestClient) -> None:
        response = client.get("/api/v1/automation/schedule")

        assert response.status_code == 200
        body = response.json()
        assert body["mode"] == "manual"
        assert body["enabled"] is False
        assert body["blocking_reason"] == "not_scheduled"
        assert body["max_posts"] >= 1

    def test_consent_alone_does_not_enable_it(self, client: TestClient) -> None:
        client.put(
            "/api/v1/settings/schedule_policy",
            json={"payload": {"mode": "schedule", "hour": 9, "minute": 0, "max_posts": 3}},
        )

        body = client.get("/api/v1/automation/schedule").json()

        assert body["mode"] == "schedule"
        assert body["enabled"] is False
        assert body["blocking_reason"] == "consent_missing"

    def test_it_asks_for_a_saved_safety_policy_last(self, client: TestClient) -> None:
        client.put(
            "/api/v1/settings/schedule_policy",
            json={"payload": {"mode": "schedule", "hour": 9, "minute": 0, "max_posts": 3}},
        )
        client.put(
            "/api/v1/settings/automation_consent",
            json={"payload": {"accepted": True, "consent_version": 1}},
        )

        body = client.get("/api/v1/automation/schedule").json()

        assert body["enabled"] is False
        assert body["blocking_reason"] == "safety_policy_missing"

    def test_saving_every_gate_enables_it(self, client: TestClient) -> None:
        client.put(
            "/api/v1/settings/schedule_policy",
            json={"payload": {"mode": "schedule", "hour": 9, "minute": 0, "max_posts": 3}},
        )
        client.put(
            "/api/v1/settings/automation_consent",
            json={"payload": {"accepted": True, "consent_version": 1}},
        )
        safety = client.get("/api/v1/settings/safety_policy").json()["payload"]
        client.put("/api/v1/settings/safety_policy", json={"payload": safety})

        body = client.get("/api/v1/automation/schedule").json()

        assert body["enabled"] is True
        assert body["blocking_reason"] is None


class TestCreatedOn:
    def test_no_session_means_no_run_today(self, repository: SqliteSessionRepository) -> None:
        assert repository.created_on(date(2026, 8, 1), SessionTrigger.SCHEDULE) is False

    def test_a_session_created_today_is_reported(self, repository: SqliteSessionRepository) -> None:
        session = repository.create(**approval_kwargs(trigger=SessionTrigger.SCHEDULE))
        assert session.created_at is not None

        assert repository.created_on(session.created_at.date(), SessionTrigger.SCHEDULE) is True

    def test_another_trigger_does_not_count(self, repository: SqliteSessionRepository) -> None:
        session = repository.create(**approval_kwargs(trigger=SessionTrigger.SESSION))
        assert session.created_at is not None

        assert repository.created_on(session.created_at.date(), SessionTrigger.SCHEDULE) is False

    def test_another_day_does_not_count(self, repository: SqliteSessionRepository) -> None:
        repository.create(**approval_kwargs(trigger=SessionTrigger.SCHEDULE))

        assert repository.created_on(date(2000, 1, 1), SessionTrigger.SCHEDULE) is False


def approval_kwargs(*, trigger: SessionTrigger) -> dict[str, Any]:
    """Build the minimum arguments the repository needs to create a session."""
    return {
        "trigger": trigger,
        "approved_steps": [EngagementStepName.LIKE],
        "max_posts": 2,
        "sources": [DiscoverySource.NEIGHBOR],
    }
