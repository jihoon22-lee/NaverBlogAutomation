"""Transport behavior for the versioned settings endpoints."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.domain import DEFAULT_SETTING_PAYLOADS, AppSettingKind

ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{tmp_path / 'settings.db'}",
        generator_mode="fake",
        app_environment="test",
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def default_payload(kind: AppSettingKind) -> dict[str, Any]:
    return dict(DEFAULT_SETTING_PAYLOADS[kind])


@pytest.mark.parametrize("kind", [kind.value for kind in AppSettingKind])
def test_every_kind_reads_its_default_before_saving(client: TestClient, kind: str) -> None:
    response = client.get(f"/api/v1/settings/{kind}")

    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == kind
    assert body["schema_version"] == 1
    assert body["updated_at"] is None
    assert isinstance(body["payload"], dict)


def test_an_unknown_kind_is_not_found(client: TestClient) -> None:
    response = client.get("/api/v1/settings/unknown_kind")

    assert response.status_code == 404
    assert response.json()["code"] == "setting_not_found"


def test_saving_returns_the_stored_record_with_a_timestamp(client: TestClient) -> None:
    response = client.put(
        "/api/v1/settings/closing_phrase", json={"payload": {"phrase": "  감사합니다  "}}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["payload"] == {"phrase": "감사합니다"}
    assert body["updated_at"] is not None


def test_a_saved_record_is_returned_on_the_next_read(client: TestClient) -> None:
    client.put("/api/v1/settings/neighbor_message", json={"payload": {"message": "합성 메시지"}})

    body = client.get("/api/v1/settings/neighbor_message").json()

    assert body["payload"] == {"message": "합성 메시지"}
    assert body["updated_at"] is not None


def test_saving_replaces_the_previous_record(client: TestClient) -> None:
    client.put("/api/v1/settings/closing_phrase", json={"payload": {"phrase": "첫"}})
    client.put("/api/v1/settings/closing_phrase", json={"payload": {"phrase": "둘"}})

    assert client.get("/api/v1/settings/closing_phrase").json()["payload"] == {"phrase": "둘"}


def test_every_kind_accepts_its_documented_default(client: TestClient) -> None:
    for kind in AppSettingKind:
        response = client.put(
            f"/api/v1/settings/{kind.value}", json={"payload": default_payload(kind)}
        )
        assert response.status_code == 200, kind.value


@pytest.mark.parametrize(
    ("kind", "payload", "fragment"),
    [
        ("closing_phrase", {"phrase": "가" * 51}, "50"),
        ("neighbor_message", {"message": "가" * 501}, "500"),
        ("generation_profile", {"relationship_level": "unknown"}, "settings field"),
        ("automation_consent", {"accepted": "yes", "consent_version": 1}, "boolean"),
        ("safety_policy", {"daily_like_cap": 0}, "settings field"),
        ("schedule_policy", {"mode": "unattended", "hour": 1, "minute": 0, "max_posts": 1}, "mode"),
        ("browser_profile", {"headless": "true", "channel": "chrome"}, "headless"),
    ],
)
def test_invalid_payloads_are_rejected(
    client: TestClient, kind: str, payload: dict[str, Any], fragment: str
) -> None:
    response = client.put(f"/api/v1/settings/{kind}", json={"payload": payload})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "invalid_setting"
    assert fragment in body["detail"]


def test_saving_an_unknown_kind_is_not_found(client: TestClient) -> None:
    response = client.put("/api/v1/settings/unknown_kind", json={"payload": {}})

    assert response.status_code == 404
    assert response.json()["code"] == "setting_not_found"


def test_a_missing_payload_field_fails_validation(client: TestClient) -> None:
    response = client.put("/api/v1/settings/closing_phrase", json={})

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"


def test_an_unexpected_request_field_is_rejected(client: TestClient) -> None:
    response = client.put(
        "/api/v1/settings/closing_phrase", json={"payload": {"phrase": ""}, "extra": 1}
    )

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"


def test_a_non_object_payload_is_rejected(client: TestClient) -> None:
    response = client.put("/api/v1/settings/closing_phrase", json={"payload": "text"})

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"


def test_settings_survive_a_restart(tmp_path: Path) -> None:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{tmp_path / 'settings.db'}",
        generator_mode="fake",
        app_environment="test",
        automation_driver="fake",
        automation_headless=True,
    )
    with TestClient(create_app(settings)) as first:
        first.put("/api/v1/settings/closing_phrase", json={"payload": {"phrase": "유지"}})
    with TestClient(create_app(settings)) as second:
        body = second.get("/api/v1/settings/closing_phrase").json()

    assert body["payload"] == {"phrase": "유지"}


def test_existing_endpoints_keep_working_after_settings_are_saved(client: TestClient) -> None:
    client.put(
        "/api/v1/settings/generation_profile",
        json={"payload": default_payload(AppSettingKind.GENERATION_PROFILE)},
    )

    assert client.get("/api/v1/status").status_code == 200
    assert client.get("/api/v1/recommendations").status_code == 200
    assert client.get("/api/v1/discovery/queue", params={"source": "neighbor"}).status_code == 200
