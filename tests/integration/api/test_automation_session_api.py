"""Transport behavior for the browser session endpoints."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.application.automation import LOGIN_STATE_EXPRESSION
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver

ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SESSION = "/api/v1/automation/session"


@pytest.fixture
def driver() -> FakeBrowserDriver:
    return FakeBrowserDriver(page_results={LOGIN_STATE_EXPRESSION: "authenticated"})


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


def test_status_reports_a_stopped_session_before_launch(client: TestClient) -> None:
    response = client.get(SESSION)

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "stopped"
    assert body["login"] == "unknown"
    assert body["driver"] == "fake"
    assert body["headless"] is True
    assert body["open_pages"] == 0


def test_launch_reports_a_ready_and_authenticated_session(client: TestClient) -> None:
    response = client.post(f"{SESSION}/launch")

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "ready"
    assert body["login"] == "authenticated"
    assert body["open_pages"] == 1


def test_second_launch_conflicts_with_a_stable_problem_code(client: TestClient) -> None:
    client.post(f"{SESSION}/launch")

    response = client.post(f"{SESSION}/launch")

    assert response.status_code == 409
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "browser_session_already_running"


def test_close_without_a_session_reports_not_running(client: TestClient) -> None:
    response = client.post(f"{SESSION}/close")

    assert response.status_code == 409
    assert response.json()["code"] == "browser_session_not_running"


def test_close_returns_the_session_to_stopped(client: TestClient) -> None:
    client.post(f"{SESSION}/launch")

    response = client.post(f"{SESSION}/close")

    assert response.status_code == 200
    assert response.json()["state"] == "stopped"
    assert client.get(SESSION).json()["login"] == "unknown"


def test_focus_requires_a_live_session(client: TestClient) -> None:
    response = client.post(f"{SESSION}/focus")

    assert response.status_code == 409
    assert response.json()["code"] == "browser_session_not_running"


def test_focus_raises_the_window_on_a_live_session(
    client: TestClient, driver: FakeBrowserDriver
) -> None:
    client.post(f"{SESSION}/launch")

    response = client.post(f"{SESSION}/focus")

    assert response.status_code == 200
    assert driver.contexts[0].front_requests == 1


def test_screenshot_streams_png_bytes_without_caching(client: TestClient) -> None:
    client.post(f"{SESSION}/launch")

    response = client.get(f"{SESSION}/screenshot")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "no-store"
    assert response.content.startswith(b"\x89PNG")


def test_screenshot_requires_a_live_session(client: TestClient) -> None:
    response = client.get(f"{SESSION}/screenshot")

    assert response.status_code == 409
    assert response.json()["code"] == "browser_session_not_running"


def test_screenshot_failure_maps_to_a_bad_gateway_problem(
    client: TestClient, driver: FakeBrowserDriver
) -> None:
    client.post(f"{SESSION}/launch")
    driver.contexts[0].open_tabs[0].screenshot_failure = "capture rejected"

    response = client.get(f"{SESSION}/screenshot")

    assert response.status_code == 502
    assert response.json()["code"] == "browser_operation_failed"


def test_refresh_query_re_observes_the_login_state(
    client: TestClient, driver: FakeBrowserDriver
) -> None:
    client.post(f"{SESSION}/launch")
    driver.contexts[0].open_tabs[0].results[LOGIN_STATE_EXPRESSION] = "anonymous"

    response = client.get(SESSION, params={"refresh": True})

    assert response.status_code == 200
    assert response.json()["login"] == "anonymous"


def test_refresh_query_requires_a_live_session(client: TestClient) -> None:
    response = client.get(SESSION, params={"refresh": True})

    assert response.status_code == 409
    assert response.json()["code"] == "browser_session_not_running"


def test_invalid_refresh_query_is_rejected(client: TestClient) -> None:
    response = client.get(SESSION, params={"refresh": "maybe"})

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"


def test_unavailable_driver_reports_service_unavailable(tmp_path: Path) -> None:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{tmp_path / 'automation.db'}",
        generator_mode="fake",
        app_environment="test",
        automation_driver="fake",
        automation_headless=True,
    )
    failing = FakeBrowserDriver(launch_failure="chrome channel missing")
    with TestClient(create_app(settings, browser_driver=failing)) as client:
        response = client.post(f"{SESSION}/launch")

    assert response.status_code == 503
    assert response.json()["code"] == "browser_unavailable"


def test_session_response_never_exposes_page_content_or_cookies(client: TestClient) -> None:
    client.post(f"{SESSION}/launch")

    body = client.get(SESSION).json()

    assert set(body) == {
        "state",
        "login",
        "driver",
        "headless",
        "profile_dir",
        "open_pages",
        "detail",
    }
