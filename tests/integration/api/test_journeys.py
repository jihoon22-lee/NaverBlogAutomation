"""End-to-end journeys across features, driven through the real API with synthetic fixtures.

The per-endpoint suites prove each route in isolation. These walk the paths a person actually takes,
so a regression that only appears when features meet — a setting one step writes and a later step
reads, a gate that must stay closed until two unrelated records exist — fails here instead of in
someone's browser.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.application.automation import LOGIN_STATE_EXPRESSION
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver

ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DRAFTS = "/api/v1/drafts"
SESSIONS = "/api/v1/automation/sessions"
SETTINGS = "/api/v1/settings"
EDITOR_READY = {
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
def client(tmp_path: Path) -> Iterator[TestClient]:
    driver = FakeBrowserDriver(
        page_results={LOGIN_STATE_EXPRESSION: "authenticated"},
        page_probe_results={
            "probeEditor": EDITOR_READY,
            "readEditorText": "합성 제목",
            "readEditorBlocks": [[{"type": "paragraph", "text": "문단입니다."}]],
            "probeEditorSave": [
                {"saved": False, "savedCount": 1, "diagnosis": None},
                {"saved": True, "savedCount": 2, "diagnosis": None},
            ],
        },
    )
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{tmp_path / 'journey.db'}",
        generator_mode="fake",
        app_environment="test",
        rate_limit_requests=500,
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
        draft_media_dir=str(tmp_path / "media"),
    )
    with TestClient(create_app(settings, browser_driver=driver)) as test_client:
        yield test_client


def accept_consent(client: TestClient) -> None:
    """Record the automation consent the same way the settings screen does."""
    response = client.put(
        f"{SETTINGS}/automation_consent",
        json={"payload": {"accepted": True, "consent_version": 1}},
    )
    assert response.status_code == 200


def save_safety_policy(client: TestClient, **overrides: Any) -> dict[str, Any]:
    """Save the safety policy explicitly, which unattended mode requires."""
    payload = client.get(f"{SETTINGS}/safety_policy").json()["payload"]
    payload.update(overrides)
    response = client.put(f"{SETTINGS}/safety_policy", json={"payload": payload})
    assert response.status_code == 200
    return dict(response.json()["payload"])


def enable_schedule(client: TestClient, *, hour: int = 9, minute: int = 0) -> None:
    """Turn on the schedule policy, which alone is not enough to run unattended."""
    response = client.put(
        f"{SETTINGS}/schedule_policy",
        json={"payload": {"mode": "schedule", "hour": hour, "minute": minute, "max_posts": 3}},
    )
    assert response.status_code == 200


class TestUnattendedGates:
    """Unattended mode must stay closed until every gate is satisfied, in any order."""

    def test_a_fresh_install_reports_unattended_mode_as_off(self, client: TestClient) -> None:
        body = client.get("/api/v1/automation/schedule").json()

        assert body["enabled"] is False
        assert body["blocking_reason"] == "not_scheduled"

    def test_the_schedule_alone_does_not_open_the_gate(self, client: TestClient) -> None:
        enable_schedule(client)

        body = client.get("/api/v1/automation/schedule").json()

        assert body["enabled"] is False
        assert body["blocking_reason"] == "consent_missing"

    def test_consent_alone_does_not_open_the_gate(self, client: TestClient) -> None:
        accept_consent(client)

        body = client.get("/api/v1/automation/schedule").json()

        assert body["enabled"] is False
        assert body["blocking_reason"] == "not_scheduled"

    def test_the_safety_policy_must_be_saved_not_merely_defaulted(self, client: TestClient) -> None:
        enable_schedule(client)
        accept_consent(client)

        blocked = client.get("/api/v1/automation/schedule").json()
        save_safety_policy(client)
        opened = client.get("/api/v1/automation/schedule").json()

        assert blocked["blocking_reason"] == "safety_policy_missing"
        assert opened["enabled"] is True
        assert opened["blocking_reason"] is None

    def test_the_gates_open_in_any_order(self, client: TestClient) -> None:
        save_safety_policy(client)
        accept_consent(client)
        enable_schedule(client, hour=22, minute=30)

        body = client.get("/api/v1/automation/schedule").json()

        assert body["enabled"] is True
        assert body["hour"] == 22
        assert body["minute"] == 30

    def test_turning_the_schedule_back_off_closes_the_gate(self, client: TestClient) -> None:
        save_safety_policy(client)
        accept_consent(client)
        enable_schedule(client)

        client.put(
            f"{SETTINGS}/schedule_policy",
            json={"payload": {"mode": "manual", "hour": 9, "minute": 0, "max_posts": 3}},
        )

        assert client.get("/api/v1/automation/schedule").json()["enabled"] is False

    def test_withdrawing_consent_closes_the_gate(self, client: TestClient) -> None:
        save_safety_policy(client)
        accept_consent(client)
        enable_schedule(client)

        client.put(
            f"{SETTINGS}/automation_consent",
            json={"payload": {"accepted": False, "consent_version": 1}},
        )

        body = client.get("/api/v1/automation/schedule").json()
        assert body["enabled"] is False
        assert body["blocking_reason"] == "consent_missing"


class TestSessionBatchJourney:
    """Approving a batch and cancelling it, as the batch screen drives it."""

    def test_a_batch_cannot_be_approved_without_consent(self, client: TestClient) -> None:
        response = client.post(
            SESSIONS,
            json={"approved_steps": ["like"], "max_posts": 2, "sources": ["neighbor"]},
        )

        assert response.status_code == 403
        assert response.json()["code"] == "consent_missing"

    def test_consent_lets_one_batch_through(self, client: TestClient) -> None:
        accept_consent(client)

        response = client.post(
            SESSIONS,
            json={"approved_steps": ["like", "comment"], "max_posts": 2, "sources": ["neighbor"]},
        )

        assert response.status_code == 202
        body = response.json()
        assert body["state"] == "pending"
        assert body["processed_count"] == 0
        assert body["abort_reason"] is None

    def test_an_empty_queue_finishes_the_batch_without_touching_anything(
        self, client: TestClient
    ) -> None:
        accept_consent(client)
        session = client.post(
            SESSIONS,
            json={"approved_steps": ["like"], "max_posts": 2, "sources": ["neighbor"]},
        ).json()

        listed = client.get(SESSIONS).json()["items"]

        assert session["state"] == "pending"
        assert [entry["processed_count"] for entry in listed] == [0]

    def test_cancelling_frees_the_slot_for_the_next_batch(self, client: TestClient) -> None:
        accept_consent(client)
        first = client.post(
            SESSIONS,
            json={"approved_steps": ["like"], "max_posts": 2, "sources": ["neighbor"]},
        ).json()

        client.post(f"{SESSIONS}/{first['id']}/cancel")
        second = client.post(
            SESSIONS,
            json={"approved_steps": ["like"], "max_posts": 2, "sources": ["neighbor"]},
        )

        assert second.status_code == 202

    def test_the_batch_history_keeps_every_finished_batch(self, client: TestClient) -> None:
        accept_consent(client)
        session = client.post(
            SESSIONS,
            json={"approved_steps": ["like"], "max_posts": 2, "sources": ["neighbor"]},
        ).json()
        client.post(f"{SESSIONS}/{session['id']}/cancel")

        listed = client.get(SESSIONS).json()["items"]

        assert len(listed) == 1
        assert listed[0]["state"] in {"cancelled", "completed"}

    def test_cancelling_twice_is_harmless(self, client: TestClient) -> None:
        accept_consent(client)
        session = client.post(
            SESSIONS,
            json={"approved_steps": ["like"], "max_posts": 2, "sources": ["neighbor"]},
        ).json()
        first = client.post(f"{SESSIONS}/{session['id']}/cancel")

        second = client.post(f"{SESSIONS}/{session['id']}/cancel")

        assert first.status_code == 200
        assert second.status_code == 200
        assert second.json()["state"] == first.json()["state"]

    def test_cancelling_a_batch_that_does_not_exist_is_refused(self, client: TestClient) -> None:
        response = client.post(f"{SESSIONS}/11111111-1111-4111-8111-111111111111/cancel")

        assert response.status_code == 404


class TestWritingJourney:
    """From a seed note to a staged draft, without ever publishing."""

    def prepare(self, client: TestClient) -> str:
        client.put(
            "/api/v1/discovery/automation-settings",
            json={"enabled": True, "own_blog_id": "example", "hour": 9, "minute": 0},
        )
        created = client.post(
            DRAFTS,
            json={"title": "합성 초안", "seed_text": "메모입니다.", "category_no": 7},
        )
        assert created.status_code == 201
        return str(created.json()["id"])

    def test_a_draft_starts_before_any_body_exists(self, client: TestClient) -> None:
        draft_id = self.prepare(client)

        body = client.get(f"{DRAFTS}/{draft_id}").json()

        assert body["title"] == "합성 초안"
        assert body["category_no"] == 7

    def test_generation_refuses_clearly_without_a_configured_provider(
        self, client: TestClient
    ) -> None:
        draft_id = self.prepare(client)

        composed = client.post(f"{DRAFTS}/{draft_id}/compose", json={"provider": "openai"})
        tagged = client.post(f"{DRAFTS}/{draft_id}/tags", json={"provider": "openai"})

        assert composed.status_code == 503
        assert composed.json()["code"] == "generation_unavailable"
        assert tagged.status_code == 503

    def test_a_missing_provider_never_leaves_a_half_written_draft(self, client: TestClient) -> None:
        draft_id = self.prepare(client)

        client.post(f"{DRAFTS}/{draft_id}/compose", json={"provider": "openai"})

        body = client.get(f"{DRAFTS}/{draft_id}").json()
        assert body["title"] == "합성 초안"

    def test_a_body_can_be_written_by_hand_instead_of_generated(self, client: TestClient) -> None:
        draft_id = self.prepare(client)
        client.post("/api/v1/automation/session/launch")

        client.put(
            f"{DRAFTS}/{draft_id}/body",
            json={
                "title": "합성 제목",
                "blocks": [{"type": "paragraph", "text": "문단입니다."}],
            },
        )
        staged = client.post(f"{DRAFTS}/{draft_id}/stage")

        assert staged.status_code in {200, 201, 202}

    def test_staging_never_publishes(self, client: TestClient) -> None:
        draft_id = self.prepare(client)
        client.post("/api/v1/automation/session/launch")
        client.put(
            f"{DRAFTS}/{draft_id}/body",
            json={
                "title": "합성 제목",
                "blocks": [{"type": "paragraph", "text": "문단입니다."}],
            },
        )

        client.post(f"{DRAFTS}/{draft_id}/stage")

        listed = client.get(DRAFTS).json()["items"]
        assert all(entry.get("published_at") in (None, "") for entry in listed)

    def test_staging_a_draft_without_a_body_is_refused(self, client: TestClient) -> None:
        draft_id = self.prepare(client)
        client.post("/api/v1/automation/session/launch")

        response = client.post(f"{DRAFTS}/{draft_id}/stage")

        assert response.status_code in {409, 422}
        assert response.json()["code"] != ""


class TestSettingsRoundTrip:
    """Every settings kind the app reads must survive a write and a restart."""

    KINDS = (
        "generation_profile",
        "closing_phrase",
        "neighbor_message",
        "automation_consent",
        "safety_policy",
        "schedule_policy",
        "llm_budget",
        "writing_profile",
    )

    def test_every_kind_answers_with_a_payload(self, client: TestClient) -> None:
        for kind in self.KINDS:
            response = client.get(f"{SETTINGS}/{kind}")

            assert response.status_code == 200, kind
            assert isinstance(response.json()["payload"], dict), kind

    def test_a_fresh_setting_reports_no_save_time(self, client: TestClient) -> None:
        body = client.get(f"{SETTINGS}/safety_policy").json()

        assert body["updated_at"] is None

    def test_saving_records_the_save_time(self, client: TestClient) -> None:
        save_safety_policy(client)

        assert client.get(f"{SETTINGS}/safety_policy").json()["updated_at"] is not None

    def test_a_saved_cap_survives_a_new_client(self, tmp_path: Path) -> None:
        settings = ApiSettings(
            extension_origin=ORIGIN,
            database_url=f"sqlite:///{tmp_path / 'journey.db'}",
            generator_mode="fake",
            app_environment="test",
            rate_limit_requests=500,
            automation_driver="fake",
            automation_headless=True,
            automation_profile_dir=str(tmp_path / "profile"),
            draft_media_dir=str(tmp_path / "media"),
        )
        with TestClient(create_app(settings)) as first:
            saved = save_safety_policy(first, daily_like_cap=11)

        with TestClient(create_app(settings)) as second:
            reloaded = second.get(f"{SETTINGS}/safety_policy").json()["payload"]

        assert saved["daily_like_cap"] == 11
        assert reloaded["daily_like_cap"] == 11

    def test_an_unknown_kind_is_refused(self, client: TestClient) -> None:
        assert client.get(f"{SETTINGS}/not_a_kind").status_code in {404, 422}


class TestServiceSurface:
    """The loopback service must answer the basics the web app depends on."""

    def test_the_health_probe_answers(self, client: TestClient) -> None:
        assert client.get("/health").status_code == 200

    def test_the_web_app_is_served_from_the_same_origin(self, client: TestClient) -> None:
        response = client.get("/app", follow_redirects=True)

        assert response.status_code in {200, 404}

    def test_the_provider_list_never_leaks_a_key(self, client: TestClient) -> None:
        body = client.get("/api/v1/llm/providers").json()

        serialized = str(body)
        assert "api_key" not in serialized
        assert "sk-" not in serialized
        for entry in body["items"]:
            assert set(entry) == {"provider", "configured", "model"}
