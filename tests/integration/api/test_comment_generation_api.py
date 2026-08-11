"""Transport behavior for web app comment generation."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.application.automation import LOGIN_STATE_EXPRESSION
from naver_blog_assistant.domain import LlmProvider
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver
from naver_blog_assistant.infrastructure.browser.page_scripts import _CALL_EXPRESSION
from naver_blog_assistant.infrastructure.llm import FakeStructuredClient, ProviderRegistry

COMMENTS = "/api/v1/automation/comments"
REFINE = "/api/v1/recommendations/{recommendation_id}/refine"
SESSION = "/api/v1/automation/session"
POST_URL = "https://blog.naver.com/example/223456789012"
BODY = "전시에서 인상 깊었던 작품과 관람 동선을 자세하게 정리한 합성 본문입니다."


def capture(**changes: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "body": BODY,
        "canonicalUrl": None,
        "documentUrl": POST_URL,
        "originalLength": len(BODY),
        "selectorConfidence": 500,
        "selectorKind": "modern",
        "title": "합성 전시 후기",
    }
    payload.update(changes)
    return payload


@pytest.fixture
def driver() -> FakeBrowserDriver:
    return FakeBrowserDriver(
        page_results={
            LOGIN_STATE_EXPRESSION: "authenticated",
            _CALL_EXPRESSION: {"installed": True, "value": capture()},
        }
    )


@pytest.fixture
def client(tmp_path: Path, driver: FakeBrowserDriver) -> Iterator[TestClient]:
    settings = ApiSettings(
        database_url=f"sqlite:///{tmp_path / 'comments.db'}",
        generator_mode="fake",
        app_environment="test",
        rate_limit_requests=50,
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
    )
    with TestClient(create_app(settings, browser_driver=driver)) as test_client:
        test_client.post(f"{SESSION}/launch")
        yield test_client


def test_generation_returns_three_candidates_and_the_capture(client: TestClient) -> None:
    response = client.post(COMMENTS, json={"url": POST_URL})

    assert response.status_code == 200
    body = response.json()
    assert body["attempt"] == 1
    assert body["replayed"] is False
    assert body["extraction"]["title"] == "합성 전시 후기"
    assert len(body["recommendation"]["candidates"]) == 3
    assert {candidate["tone"] for candidate in body["recommendation"]["candidates"]} == {
        "warm",
        "curious",
        "supportive",
    }


def test_the_default_profile_is_echoed_in_the_recommendation(client: TestClient) -> None:
    body = client.post(COMMENTS, json={"url": POST_URL}).json()["recommendation"]

    assert body["relationship_level"] == "friendly"
    assert body["speech_style"] == "honorific"
    assert body["comment_length"] == "medium"
    assert body["comment_mood"] == "warm"


def test_a_saved_profile_is_applied_without_request_options(client: TestClient) -> None:
    client.put(
        "/api/v1/settings/generation_profile",
        json={
            "payload": {
                "relationship_level": "polite",
                "speech_style": "honorific",
                "comment_length": "short",
                "comment_mood": "calm",
                "personalization_mode": "off",
            }
        },
    )

    body = client.post(COMMENTS, json={"url": POST_URL}).json()["recommendation"]

    assert body["relationship_level"] == "polite"
    assert body["comment_length"] == "short"
    assert body["comment_mood"] == "calm"


def test_request_options_override_the_saved_profile(client: TestClient) -> None:
    body = client.post(COMMENTS, json={"url": POST_URL, "comment_length": "long"}).json()

    assert body["recommendation"]["comment_length"] == "long"


def test_a_duplicate_request_replays_the_stored_result(client: TestClient) -> None:
    first = client.post(COMMENTS, json={"url": POST_URL}).json()

    response = client.post(COMMENTS, json={"url": POST_URL})
    second = response.json()

    assert second["replayed"] is True
    assert response.headers["Idempotency-Replayed"] == "true"
    assert second["recommendation"]["id"] == first["recommendation"]["id"]
    assert second["attempt"] == 1


def test_a_replacement_attempt_creates_a_new_recommendation(client: TestClient) -> None:
    first = client.post(COMMENTS, json={"url": POST_URL}).json()

    second = client.post(COMMENTS, json={"url": POST_URL, "replace": True}).json()

    assert second["attempt"] == 2
    assert second["replayed"] is False
    assert second["recommendation"]["id"] != first["recommendation"]["id"]


def test_changed_options_generate_a_separate_recommendation(client: TestClient) -> None:
    first = client.post(COMMENTS, json={"url": POST_URL}).json()

    second = client.post(COMMENTS, json={"url": POST_URL, "comment_mood": "lively"}).json()

    assert second["replayed"] is False
    assert second["recommendation"]["id"] != first["recommendation"]["id"]


def test_changed_options_do_not_disturb_the_original_replay(client: TestClient) -> None:
    first = client.post(COMMENTS, json={"url": POST_URL}).json()
    client.post(COMMENTS, json={"url": POST_URL, "comment_mood": "lively"})

    replay = client.post(COMMENTS, json={"url": POST_URL}).json()

    assert replay["replayed"] is True
    assert replay["recommendation"]["id"] == first["recommendation"]["id"]


def test_generation_requires_a_live_session(tmp_path: Path, driver: FakeBrowserDriver) -> None:
    settings = ApiSettings(
        database_url=f"sqlite:///{tmp_path / 'no-session.db'}",
        generator_mode="fake",
        app_environment="test",
        automation_driver="fake",
        automation_headless=True,
    )
    with TestClient(create_app(settings, browser_driver=driver)) as client:
        response = client.post(COMMENTS, json={"url": POST_URL})

    assert response.status_code == 409
    assert response.json()["code"] == "browser_session_not_running"


@pytest.mark.parametrize(
    "url", ["https://cafe.naver.com/example/1", "http://blog.naver.com/example/1", "not-a-url"]
)
def test_unsupported_urls_report_a_stable_code(client: TestClient, url: str) -> None:
    response = client.post(COMMENTS, json={"url": url})

    assert response.status_code == 422
    assert response.json()["code"] == "unsupported_url"


def test_a_short_article_is_rejected_before_generation(
    client: TestClient, driver: FakeBrowserDriver
) -> None:
    driver.contexts[0].open_tabs[0].results[_CALL_EXPRESSION] = {
        "installed": True,
        "value": capture(body="짧음"),
    }

    response = client.post(COMMENTS, json={"url": POST_URL})

    assert response.status_code == 422
    assert response.json()["code"] == "short_article"


@pytest.mark.parametrize(
    "payload",
    [
        {"url": POST_URL, "comment_length": "huge"},
        {"url": POST_URL, "speech_style": "formal"},
        {"url": POST_URL, "relationship_level": None, "unexpected": 1},
        {},
    ],
)
def test_invalid_requests_fail_validation(client: TestClient, payload: dict[str, Any]) -> None:
    response = client.post(COMMENTS, json=payload)

    assert response.status_code == 422
    assert response.json()["code"] in {"invalid_request", "invalid_generation_options"}


def test_banmal_outside_a_close_relationship_is_rejected(client: TestClient) -> None:
    response = client.post(
        COMMENTS, json={"url": POST_URL, "relationship_level": "new", "speech_style": "banmal"}
    )

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_generation_options"


def test_the_recommendation_is_visible_in_history(client: TestClient) -> None:
    created = client.post(COMMENTS, json={"url": POST_URL}).json()["recommendation"]

    history = client.get("/api/v1/recommendations").json()["items"]

    assert any(item["id"] == created["id"] for item in history)


def test_the_stored_recommendation_can_be_reviewed(client: TestClient) -> None:
    created = client.post(COMMENTS, json={"url": POST_URL}).json()["recommendation"]
    candidate = created["candidates"][0]["id"]

    response = client.patch(
        f"/api/v1/recommendations/{created['id']}",
        json={"selected_candidate_id": candidate, "review_status": "approved"},
    )

    assert response.status_code == 200
    assert response.json()["review_status"] == "approved"


def test_the_response_never_exposes_the_full_body(client: TestClient) -> None:
    body = client.post(COMMENTS, json={"url": POST_URL}).json()

    assert len(body["extraction"]["preview"]) <= 1_200
    assert "body" not in body["extraction"]
    assert "body" not in body["recommendation"]


def test_refinement_requires_a_configured_structured_provider(client: TestClient) -> None:
    recommendation = client.post(COMMENTS, json={"url": POST_URL}).json()["recommendation"]

    response = client.post(
        REFINE.format(recommendation_id=recommendation["id"]),
        json={
            "current_comment": recommendation["candidates"][0]["comment"],
            "preset": "natural",
            "provider": "openai",
        },
        headers={"Idempotency-Key": "00000000-0000-4000-8000-000000000090"},
    )

    assert response.status_code == 503
    assert response.json()["code"] == "generation_unavailable"


def test_refinement_rejects_an_oversized_provider_model_before_calling_a_provider(
    client: TestClient,
) -> None:
    recommendation = client.post(COMMENTS, json={"url": POST_URL}).json()["recommendation"]

    response = client.post(
        REFINE.format(recommendation_id=recommendation["id"]),
        json={
            "current_comment": recommendation["candidates"][0]["comment"],
            "preset": "natural",
            "provider": "openai",
            "model": "x" * 101,
        },
        headers={"Idempotency-Key": "00000000-0000-4000-8000-000000000092"},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"


def test_refinement_returns_a_bounded_provider_result_and_replays_the_same_key(
    tmp_path: Path,
    driver: FakeBrowserDriver,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    structured = FakeStructuredClient(
        payloads=[{"comment": "전시 동선이 특히 인상 깊었다는 마음이 잘 전해집니다."}]
    )
    registry = ProviderRegistry(
        api_keys={LlmProvider.OPENAI: "test-key"},
        factories={LlmProvider.OPENAI: lambda _key, _model: structured},
    )
    monkeypatch.setattr(
        "naver_blog_assistant.api.factory._configured_registry", lambda _settings: registry
    )
    settings = ApiSettings(
        database_url=f"sqlite:///{tmp_path / 'refinement.db'}",
        generator_mode="fake",
        app_environment="test",
        rate_limit_requests=50,
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
    )
    key = "00000000-0000-4000-8000-000000000091"
    with TestClient(create_app(settings, browser_driver=driver)) as test_client:
        test_client.post(f"{SESSION}/launch")
        recommendation = test_client.post(COMMENTS, json={"url": POST_URL}).json()["recommendation"]
        payload = {
            "current_comment": recommendation["candidates"][0]["comment"],
            "preset": "specific",
            "provider": "openai",
        }
        first = test_client.post(
            REFINE.format(recommendation_id=recommendation["id"]),
            json=payload,
            headers={"Idempotency-Key": key},
        )
        replay = test_client.post(
            REFINE.format(recommendation_id=recommendation["id"]),
            json=payload,
            headers={"Idempotency-Key": key},
        )
        conflict = test_client.post(
            REFINE.format(recommendation_id=recommendation["id"]),
            json={**payload, "preset": "warmer"},
            headers={"Idempotency-Key": key},
        )

    assert first.status_code == 200
    assert first.json()["text"] == "전시 동선이 특히 인상 깊었다는 마음이 잘 전해집니다."
    assert replay.status_code == 200
    assert replay.headers["Idempotency-Replayed"] == "true"
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "idempotency_conflict"
    assert len(structured.calls) == 1
    assert POST_URL not in structured.calls[0][1]
    assert BODY not in structured.calls[0][1]
