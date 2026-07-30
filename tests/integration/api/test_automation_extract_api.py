"""Transport behavior for the article extraction endpoint."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.application.automation import LOGIN_STATE_EXPRESSION
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver
from naver_blog_assistant.infrastructure.browser.page_scripts import _CALL_EXPRESSION

ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
EXTRACT = "/api/v1/automation/extract"
SESSION = "/api/v1/automation/session"
POST_URL = "https://blog.naver.com/example/223456789012"
BODY = "합성 본문입니다. 충분히 긴 문장을 포함한 테스트 본문입니다."


def capture(**changes: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "body": BODY,
        "canonicalUrl": None,
        "documentUrl": POST_URL,
        "originalLength": len(BODY),
        "selectorConfidence": 500,
        "selectorKind": "modern",
        "title": "합성 제목",
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
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{tmp_path / 'automation.db'}",
        generator_mode="fake",
        app_environment="test",
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
    )
    with TestClient(create_app(settings, browser_driver=driver)) as test_client:
        yield test_client


def test_extraction_returns_a_bounded_preview(client: TestClient) -> None:
    client.post(f"{SESSION}/launch")

    response = client.post(EXTRACT, json={"url": POST_URL})

    assert response.status_code == 200
    body = response.json()
    assert body["source_url"] == POST_URL
    assert body["title"] == "합성 제목"
    assert body["selector_kind"] == "modern"
    assert body["truncated"] is False
    assert body["preview"].startswith("합성 본문")
    assert set(body) == {
        "source_url",
        "title",
        "selector_kind",
        "original_length",
        "transmitted_length",
        "truncated",
        "preview",
    }


def test_extraction_requires_a_live_session(client: TestClient) -> None:
    response = client.post(EXTRACT, json={"url": POST_URL})

    assert response.status_code == 409
    assert response.json()["code"] == "browser_session_not_running"


@pytest.mark.parametrize(
    "url",
    [
        "https://cafe.naver.com/example/1",
        "http://blog.naver.com/example/1",
        "not-a-url",
        "https://blog.naver.com/example/%00",
    ],
)
def test_unsupported_urls_report_a_stable_code(client: TestClient, url: str) -> None:
    client.post(f"{SESSION}/launch")

    response = client.post(EXTRACT, json={"url": url})

    assert response.status_code == 422
    assert response.json()["code"] == "unsupported_url"


def test_a_missing_url_fails_validation(client: TestClient) -> None:
    client.post(f"{SESSION}/launch")

    response = client.post(EXTRACT, json={})

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"


def test_an_unknown_field_is_rejected(client: TestClient) -> None:
    client.post(f"{SESSION}/launch")

    response = client.post(EXTRACT, json={"url": POST_URL, "unexpected": 1})

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"


def test_an_empty_article_reports_a_stable_code(
    client: TestClient, driver: FakeBrowserDriver
) -> None:
    client.post(f"{SESSION}/launch")
    driver.contexts[0].open_tabs[0].results[_CALL_EXPRESSION] = {
        "installed": True,
        "value": None,
    }

    response = client.post(EXTRACT, json={"url": POST_URL})

    assert response.status_code == 422
    assert response.json()["code"] == "empty_article"


def test_a_short_article_reports_a_stable_code(
    client: TestClient, driver: FakeBrowserDriver
) -> None:
    client.post(f"{SESSION}/launch")
    driver.contexts[0].open_tabs[0].results[_CALL_EXPRESSION] = {
        "installed": True,
        "value": capture(body="짧음"),
    }

    response = client.post(EXTRACT, json={"url": POST_URL})

    assert response.status_code == 422
    assert response.json()["code"] == "short_article"


def test_a_navigation_failure_reports_extraction_failed(
    client: TestClient, driver: FakeBrowserDriver
) -> None:
    client.post(f"{SESSION}/launch")
    driver.contexts[0].open_tabs[0].navigation_failure = "net::ERR_ABORTED"

    response = client.post(EXTRACT, json={"url": POST_URL})

    assert response.status_code == 422
    assert response.json()["code"] == "extraction_failed"


def test_a_missing_page_bundle_reports_service_unavailable(
    tmp_path: Path, driver: FakeBrowserDriver, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Missing:
        def read_text(self, encoding: str) -> str:
            raise FileNotFoundError(encoding)

    monkeypatch.setattr(
        "naver_blog_assistant.infrastructure.browser.page_scripts.files",
        lambda _: type("_Resource", (), {"joinpath": lambda self, name: _Missing()})(),
    )
    # An uninstalled bundle makes the runner load the source, which is what fails here.
    driver.page_results[_CALL_EXPRESSION] = {"installed": False, "value": None}
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{tmp_path / 'missing-bundle.db'}",
        generator_mode="fake",
        app_environment="test",
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
    )
    with TestClient(create_app(settings, browser_driver=driver)) as client:
        client.post(f"{SESSION}/launch")
        response = client.post(EXTRACT, json={"url": POST_URL})

    assert response.status_code == 503
    assert response.json()["code"] == "browser_unavailable"


def test_the_response_never_contains_the_full_body(
    client: TestClient, driver: FakeBrowserDriver
) -> None:
    client.post(f"{SESSION}/launch")
    long_body = "가" * 5_000
    driver.contexts[0].open_tabs[0].results[_CALL_EXPRESSION] = {
        "installed": True,
        "value": capture(body=long_body, originalLength=5_000),
    }

    body = client.post(EXTRACT, json={"url": POST_URL}).json()

    assert len(body["preview"]) == 1_200
    assert body["transmitted_length"] == 5_000
