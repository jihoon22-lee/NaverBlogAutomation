"""Transport behavior for the provider fan-out endpoint."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.application.automation import LOGIN_STATE_EXPRESSION
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver

FANOUT = "/api/v1/automation/comments/fanout"
POST_URL = "https://blog.naver.com/example/223456789012"
BODY = "전시에서 인상 깊었던 작품과 관람 동선을 자세하게 정리한 합성 본문입니다."

CAPTURE = {
    "body": BODY,
    "canonicalUrl": None,
    "documentUrl": POST_URL,
    "originalLength": len(BODY),
    "selectorConfidence": 500,
    "selectorKind": "modern",
    "title": "합성 전시 후기",
}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    driver = FakeBrowserDriver(
        page_results={LOGIN_STATE_EXPRESSION: "authenticated"},
        page_probe_results={"captureArticle": CAPTURE},
    )
    settings = ApiSettings(
        database_url=f"sqlite:///{tmp_path / 'fanout.db'}",
        generator_mode="fake",
        app_environment="test",
        rate_limit_requests=50,
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
    )
    with TestClient(create_app(settings, browser_driver=driver)) as test_client:
        test_client.post("/api/v1/automation/session/launch")
        yield test_client


def request_body(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"url": POST_URL, "providers": [{"provider": "openai"}]}
    payload.update(overrides)
    return payload


def test_fake_mode_reports_no_configured_provider(client: TestClient) -> None:
    response = client.post(FANOUT, json=request_body())

    assert response.status_code == 503
    assert response.json()["code"] == "generation_unavailable"


def test_a_duplicate_provider_is_rejected(client: TestClient) -> None:
    response = client.post(
        FANOUT,
        json=request_body(providers=[{"provider": "openai"}, {"provider": "openai"}]),
    )

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"


def test_an_empty_provider_list_is_rejected(client: TestClient) -> None:
    response = client.post(FANOUT, json=request_body(providers=[]))

    assert response.status_code == 422


def test_more_than_three_providers_are_rejected(client: TestClient) -> None:
    response = client.post(
        FANOUT,
        json=request_body(
            providers=[
                {"provider": "openai"},
                {"provider": "gemini"},
                {"provider": "anthropic"},
                {"provider": "openai"},
            ]
        ),
    )

    assert response.status_code == 422


def test_an_unknown_provider_is_rejected(client: TestClient) -> None:
    response = client.post(FANOUT, json=request_body(providers=[{"provider": "mistral"}]))

    assert response.status_code == 422


def test_an_unknown_field_is_rejected(client: TestClient) -> None:
    response = client.post(FANOUT, json=request_body(unexpected=True))

    assert response.status_code == 422


def test_an_unsupported_url_is_rejected(client: TestClient) -> None:
    response = client.post(FANOUT, json=request_body(url="https://cafe.naver.com/example/1"))

    assert response.status_code == 422
