"""Transport and persistence behavior for staging runs."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.application.automation import LOGIN_STATE_EXPRESSION
from naver_blog_assistant.domain import DomainValidationError
from naver_blog_assistant.domain.publishing import (
    PUBLISH_STEP_ORDER,
    PublishRunState,
    PublishStepName,
    PublishStepState,
    aggregate_state,
    assert_step_transition,
)
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver
from naver_blog_assistant.infrastructure.database.engine import create_sqlite_engine
from naver_blog_assistant.infrastructure.database.publish_run_repository import (
    PublishRunNotFoundError,
    SqlitePublishRunRepository,
)
from naver_blog_assistant.infrastructure.database.schema import metadata

DRAFTS = "/api/v1/drafts"
READY = {
    "stage": "ready",
    "titleSelector": "#title",
    "bodySelector": "#body",
    "editorRootSelector": "#editor-root",
    "imageInputSelector": "#file",
    "imageCaptionSelector": "#caption",
    "saveSelector": "#save",
    "tagInputSelector": "#tags",
    "restoreCancelSelector": None,
    "blockActionSelectors": {},
}


@pytest.fixture
def repository(tmp_path: Path) -> Iterator[SqlitePublishRunRepository]:
    engine: Engine = create_sqlite_engine(f"sqlite:///{tmp_path / 'runs.db'}")
    metadata.create_all(engine)
    yield SqlitePublishRunRepository(engine)
    engine.dispose()


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    driver = FakeBrowserDriver(
        page_results={LOGIN_STATE_EXPRESSION: "authenticated"},
        page_probe_results={
            "probeEditor": READY,
            "readEditorText": "합성 제목",
            "readEditorBlocks": [[{"type": "paragraph", "text": "문단입니다."}]],
            "probeEditorSave": [
                {"saved": False, "savedCount": 1, "diagnosis": None},
                {"saved": True, "savedCount": 2, "diagnosis": None},
            ],
        },
    )
    settings = ApiSettings(
        database_url=f"sqlite:///{tmp_path / 'staging.db'}",
        generator_mode="fake",
        app_environment="test",
        rate_limit_requests=200,
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
    )
    with TestClient(create_app(settings, browser_driver=driver)) as test_client:
        test_client.post("/api/v1/automation/session/launch")
        yield test_client


def prepared_draft(client: TestClient) -> str:
    client.put(
        "/api/v1/discovery/automation-settings",
        json={"enabled": True, "own_blog_id": "example", "hour": 9, "minute": 0},
    )
    created = client.post(
        DRAFTS, json={"title": "합성 초안", "seed_text": "메모입니다.", "category_no": 7}
    ).json()
    client.put(
        f"{DRAFTS}/{created['id']}/body",
        json={"title": "합성 제목", "blocks": [{"type": "paragraph", "text": "문단입니다."}]},
    )
    return str(created["id"])


class TestStepMachine:
    def test_the_aggregate_state_never_guesses_an_unknown_outcome(self) -> None:
        def steps(states: list[PublishStepState]) -> tuple[Any, ...]:
            from naver_blog_assistant.domain.publishing import PublishStep

            return tuple(
                PublishStep(
                    name=name,
                    position=index,
                    state=state,
                    result_code=None
                    if state in {PublishStepState.PENDING, PublishStepState.RUNNING}
                    else "code",
                )
                for index, (name, state) in enumerate(zip(PUBLISH_STEP_ORDER, states, strict=True))
            )

        assert aggregate_state(steps([PublishStepState.SUCCEEDED] * 5)) is PublishRunState.SUCCEEDED
        assert (
            aggregate_state(
                steps(
                    [
                        PublishStepState.SUCCEEDED,
                        PublishStepState.SUCCEEDED,
                        PublishStepState.SKIPPED,
                        PublishStepState.SKIPPED,
                        PublishStepState.UNCONFIRMED,
                    ]
                )
            )
            is PublishRunState.UNCONFIRMED
        )
        assert (
            aggregate_state(
                steps(
                    [
                        PublishStepState.FAILED,
                        PublishStepState.PENDING,
                        PublishStepState.PENDING,
                        PublishStepState.PENDING,
                        PublishStepState.PENDING,
                    ]
                )
            )
            is PublishRunState.RUNNING
        )

    @pytest.mark.parametrize(
        ("current", "following"),
        [
            (PublishStepState.SUCCEEDED, PublishStepState.RUNNING),
            (PublishStepState.FAILED, PublishStepState.SUCCEEDED),
            (PublishStepState.UNCONFIRMED, PublishStepState.RUNNING),
            (PublishStepState.RUNNING, PublishStepState.PENDING),
            (PublishStepState.RUNNING, PublishStepState.RUNNING),
            (PublishStepState.PENDING, PublishStepState.PENDING),
        ],
    )
    def test_a_forbidden_transition_is_rejected(
        self, current: PublishStepState, following: PublishStepState
    ) -> None:
        with pytest.raises(DomainValidationError):
            assert_step_transition(current, following)

    @pytest.mark.parametrize(
        ("current", "following"),
        [
            (PublishStepState.PENDING, PublishStepState.RUNNING),
            (PublishStepState.PENDING, PublishStepState.SKIPPED),
            (PublishStepState.RUNNING, PublishStepState.SUCCEEDED),
            (PublishStepState.RUNNING, PublishStepState.UNCONFIRMED),
        ],
    )
    def test_an_allowed_transition_is_accepted(
        self, current: PublishStepState, following: PublishStepState
    ) -> None:
        assert_step_transition(current, following)


class TestRepository:
    def test_starting_twice_returns_the_same_run(
        self, repository: SqlitePublishRunRepository
    ) -> None:
        draft_id, revision_id = uuid4(), uuid4()

        first = repository.start(draft_id=draft_id, revision_id=revision_id)
        second = repository.start(draft_id=draft_id, revision_id=revision_id)

        assert first.id == second.id
        assert first.pending_steps == PUBLISH_STEP_ORDER

    def test_a_recorded_step_cannot_be_repeated(
        self, repository: SqlitePublishRunRepository
    ) -> None:
        run = repository.start(draft_id=uuid4(), revision_id=uuid4())
        repository.transition_step(
            run.id, PublishStepName.TITLE, PublishStepState.SUCCEEDED, result_code="title_filled"
        )

        with pytest.raises(DomainValidationError):
            repository.transition_step(run.id, PublishStepName.TITLE, PublishStepState.RUNNING)

    def test_the_run_state_follows_its_steps(self, repository: SqlitePublishRunRepository) -> None:
        run = repository.start(draft_id=uuid4(), revision_id=uuid4())
        for name in PUBLISH_STEP_ORDER:
            repository.transition_step(run.id, name, PublishStepState.RUNNING)
            updated = repository.transition_step(
                run.id, name, PublishStepState.SUCCEEDED, result_code="done"
            )

        assert updated.state is PublishRunState.SUCCEEDED
        assert updated.pending_steps == ()

    def test_an_interrupted_step_becomes_unconfirmed(
        self, repository: SqlitePublishRunRepository
    ) -> None:
        run = repository.start(draft_id=uuid4(), revision_id=uuid4())
        repository.transition_step(run.id, PublishStepName.SAVE, PublishStepState.RUNNING)

        resolved = repository.resolve_interrupted(run.id, result_code="interrupted")

        assert resolved.step(PublishStepName.SAVE).state is PublishStepState.UNCONFIRMED
        assert resolved.state is PublishRunState.RUNNING

    def test_an_unknown_run_is_reported(self, repository: SqlitePublishRunRepository) -> None:
        with pytest.raises(PublishRunNotFoundError):
            repository.get(uuid4())

    def test_a_revision_without_a_run_reports_none(
        self, repository: SqlitePublishRunRepository
    ) -> None:
        assert repository.for_revision(uuid4(), uuid4()) is None


class TestStagingApi:
    def test_a_staging_run_is_accepted_and_streamed(self, client: TestClient) -> None:
        draft_id = prepared_draft(client)

        started = client.post(f"{DRAFTS}/{draft_id}/stage")

        assert started.status_code == 202, started.text
        body = started.json()
        assert [step["name"] for step in body["steps"]] == [
            "title",
            "body",
            "images",
            "tags",
            "save",
        ]

        events = client.get(f"{DRAFTS}/{draft_id}/stage/events")
        assert events.status_code == 200
        assert events.headers["content-type"].startswith("text/event-stream")
        assert "event: step_completed" in events.text or "event: run_snapshot" in events.text
        assert "requested_range_start" in events.text

    def test_staging_without_a_body_is_refused(self, client: TestClient) -> None:
        client.put(
            "/api/v1/discovery/automation-settings",
            json={"enabled": True, "own_blog_id": "example", "hour": 9, "minute": 0},
        )
        created = client.post(
            DRAFTS, json={"title": "합성 초안", "seed_text": "메모입니다."}
        ).json()

        response = client.post(f"{DRAFTS}/{created['id']}/stage")

        assert response.status_code == 422
        assert response.json()["code"] == "no_active_revision"

    def test_staging_without_a_saved_blog_id_is_refused(self, client: TestClient) -> None:
        created = client.post(
            DRAFTS, json={"title": "합성 초안", "seed_text": "메모입니다."}
        ).json()
        client.put(
            f"{DRAFTS}/{created['id']}/body",
            json={"title": "제목", "blocks": [{"type": "paragraph", "text": "문단"}]},
        )

        response = client.post(f"{DRAFTS}/{created['id']}/stage")

        assert response.status_code == 422
        assert response.json()["code"] == "blog_id_missing"

    def test_staging_an_unknown_draft_is_not_found(self, client: TestClient) -> None:
        response = client.post(f"{DRAFTS}/11111111-1111-4111-8111-111111111111/stage")

        assert response.status_code == 404

    def test_the_stream_closes_for_a_draft_without_a_run(self, client: TestClient) -> None:
        draft_id = prepared_draft(client)

        response = client.get(f"{DRAFTS}/{draft_id}/stage/events")

        assert response.status_code == 200
        assert response.text == ""
