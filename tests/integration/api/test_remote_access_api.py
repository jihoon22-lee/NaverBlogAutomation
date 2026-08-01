"""Integration tests for trusted-LAN device pairing and request protection."""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from naver_blog_assistant.api import ApiSettings, create_app

LAN_HOST = "192.168.50.10"
TABLET_HOST = "192.168.50.20"


async def _exercise_lan_pairing(app) -> None:
    local_transport = ASGITransport(app=app, client=("127.0.0.1", 51000))
    tablet_transport = ASGITransport(app=app, client=(TABLET_HOST, 51001))
    base_url = f"http://{LAN_HOST}:8765"
    async with (
        AsyncClient(transport=local_transport, base_url=base_url) as desktop,
        AsyncClient(transport=tablet_transport, base_url=base_url) as tablet,
    ):
        before_pairing = await tablet.get("/api/v1/status")
        pairing_code = await desktop.post("/api/v1/remote/pairing-code")
        app_shell = await tablet.get("/app/")
        paired = await tablet.post(
            "/api/v1/remote/pair",
            json={"code": pairing_code.json()["code"], "device_name": "Galaxy Tab"},
        )
        status = await tablet.get("/api/v1/status")
        missing_csrf = await tablet.post("/api/v1/recommendations", json={})
        csrf_token = tablet.cookies.get("nba_csrf")
        csrf_checked = await tablet.post(
            "/api/v1/recommendations",
            json={},
            headers={"X-NBA-CSRF": csrf_token or ""},
        )
        remote_management = await tablet.get("/api/v1/remote/devices")
        desktop_devices = await desktop.get("/api/v1/remote/devices")
        revoked = await desktop.delete(
            f"/api/v1/remote/devices/{desktop_devices.json()['items'][0]['id']}"
        )
        after_revoke = await tablet.get("/api/v1/status")

    assert before_pairing.status_code == 401
    assert before_pairing.json()["code"] == "remote_pairing_required"
    assert pairing_code.status_code == 200
    assert app_shell.status_code == 200
    assert paired.status_code == 200
    assert "HttpOnly" in paired.headers["set-cookie"]
    assert status.status_code == 200
    assert missing_csrf.status_code == 403
    assert missing_csrf.json()["code"] == "csrf_invalid"
    assert csrf_checked.status_code == 422
    assert remote_management.status_code == 403
    assert desktop_devices.status_code == 200
    assert desktop_devices.json()["items"][0]["device_name"] == "Galaxy Tab"
    assert revoked.status_code == 204
    assert after_revoke.status_code == 401


def test_private_lan_requires_pairing_but_keeps_the_spa_and_desktop_management_available(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "naver_blog_assistant.api.factory.private_ipv4_addresses",
        lambda: {LAN_HOST},
    )
    app = create_app(
        ApiSettings(
            database_url=f"sqlite:///{tmp_path / 'remote.db'}",
            generator_mode="fake",
            app_environment="test",
            automation_driver="fake",
            webapp_access_mode="lan",
        )
    )
    try:
        asyncio.run(_exercise_lan_pairing(app))
    finally:
        app.state.database_engine.dispose()


def test_local_mode_refuses_to_issue_a_useless_tablet_pairing_code(tmp_path: Path) -> None:
    app = create_app(
        ApiSettings(
            database_url=f"sqlite:///{tmp_path / 'local.db'}",
            generator_mode="fake",
            app_environment="test",
            automation_driver="fake",
        )
    )
    with TestClient(app) as client:
        response = client.post("/api/v1/remote/pairing-code")

    assert response.status_code == 409
    assert response.json()["code"] == "remote_pairing_disabled"
