"""Desktop runtime configuration remains write-only at the API boundary."""

import zipfile
from io import BytesIO
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.api.errors import ApiError
from naver_blog_assistant.api.routers.runtime_configuration import (
    register_runtime_configuration_routes,
)
from naver_blog_assistant.application.runtime_configuration import RuntimeConfiguration
from naver_blog_assistant.domain import BrowserLoginState, BrowserSessionState, BrowserSessionStatus

ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


def test_runtime_configuration_never_echoes_a_secret_and_requests_a_supervised_restart(
    tmp_path: Path, monkeypatch
) -> None:
    private_environment = tmp_path / "env"
    private_environment.write_text("# preserve me\nCUSTOM_VALUE=keep\n", encoding="utf-8")
    private_environment.chmod(0o600)
    marker = tmp_path / "restart"
    monkeypatch.setenv("NBA_RUNTIME_CONFIG_FILE", str(private_environment))
    monkeypatch.setenv("NBA_SUPERVISOR_RESTART_FILE", str(marker))
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{tmp_path / 'runtime.db'}",
        generator_mode="fake",
        app_environment="test",
        automation_driver="fake",
    )

    with TestClient(create_app(settings)) as client:
        saved = client.patch(
            "/api/v1/runtime/configuration",
            json={
                "openai_api_key": {"replace": "private-value"},
                "openai_model": "gpt-test",
                "digest_email_from": "sender@example.test",
                "digest_email_to": "recipient@example.test",
            },
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["ai"]["providers"][0]["configured"] is True
        assert saved.json()["smtp"]["digest_email_from"] == "sender@example.test"
        assert saved.json()["smtp"]["digest_email_to"] == "recipient@example.test"
        assert "private-value" not in saved.text
        assert client.get("/api/v1/runtime/configuration").json()["restart_required"] is True

        lan = client.patch("/api/v1/runtime/configuration", json={"access_mode": "lan"})
        assert lan.status_code == 200, lan.text
        assert lan.json()["network"]["access_mode"] == "lan"

        restarted = client.post("/api/v1/runtime/restart")
        assert restarted.status_code == 200, restarted.text
        assert marker.read_text(encoding="ascii") == "restart\n"
        assert restarted.json()["restart_required"] is False

    stored = private_environment.read_text(encoding="utf-8")
    assert "# preserve me" in stored
    assert "CUSTOM_VALUE=keep" in stored
    assert "OPENAI_API_KEY=private-value" in stored
    assert "API_HOST=0.0.0.0" in stored
    assert "API_PORT=8765" in stored


def test_runtime_restart_refuses_while_an_automation_task_is_active(tmp_path: Path) -> None:
    private_environment = tmp_path / "env"
    private_environment.write_text("# private\n", encoding="utf-8")
    private_environment.chmod(0o600)
    marker = tmp_path / "restart"
    app = FastAPI()

    @app.middleware("http")
    async def local_desktop(request: Request, call_next):  # type: ignore[no-untyped-def]
        request.state.is_local_client = True
        return await call_next(request)

    @app.exception_handler(ApiError)
    async def api_error(_: Request, error: ApiError) -> JSONResponse:
        return JSONResponse(status_code=error.status, content={"code": error.code})

    register_runtime_configuration_routes(
        app,
        configuration=RuntimeConfiguration(
            private_environment,
            environment={},
            launcher_restart_available=True,
        ),
        browser_status=lambda: BrowserSessionStatus(
            state=BrowserSessionState.STOPPED,
            login=BrowserLoginState.UNKNOWN,
            driver="fake",
            headless=True,
            profile_dir="",
            open_pages=0,
        ),
        restart_allowed=lambda: False,
        restart_marker=marker,
        problem_metadata=lambda *_: {},
    )

    with TestClient(app) as client:
        saved = client.patch("/api/v1/runtime/configuration", json={"openai_model": "gpt-test"})
        assert saved.status_code == 200, saved.text
        blocked = client.post("/api/v1/runtime/restart")

    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["code"] == "restart_busy"
    assert not marker.exists()


def test_runtime_data_export_and_recoverable_reset_are_desktop_only(
    tmp_path: Path, monkeypatch
) -> None:
    private_environment = tmp_path / "env"
    private_environment.write_text("OPENAI_API_KEY=private-value\n", encoding="utf-8")
    private_environment.chmod(0o600)
    marker = tmp_path / "restart"
    database = tmp_path / "runtime-data.db"
    monkeypatch.setenv("NBA_RUNTIME_CONFIG_FILE", str(private_environment))
    monkeypatch.setenv("NBA_SUPERVISOR_RESTART_FILE", str(marker))
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{database}",
        generator_mode="fake",
        app_environment="test",
        automation_driver="fake",
    )

    with TestClient(create_app(settings)) as client:
        metadata = client.get("/api/v1/runtime/data")
        assert metadata.status_code == 200, metadata.text
        assert metadata.json()["database_location"] == str(database.resolve())
        assert metadata.json()["database_file_count"] >= 1
        assert metadata.json()["media_file_count"] == 0
        assert metadata.json()["reset_available"] is True

        launched = client.post("/api/v1/automation/session/launch")
        assert launched.status_code == 200, launched.text
        blocked_export = client.post("/api/v1/runtime/data/export")
        assert blocked_export.status_code == 409, blocked_export.text
        assert blocked_export.json()["code"] == "restart_busy"
        closed = client.post("/api/v1/automation/session/close")
        assert closed.status_code == 200, closed.text

        exported = client.post("/api/v1/runtime/data/export")
        assert exported.status_code == 200, exported.text
        assert exported.headers["content-type"].startswith("application/zip")
        assert b"private-value" not in exported.content
        with zipfile.ZipFile(BytesIO(exported.content)) as archive:
            assert "database.sqlite3" in archive.namelist()

        refused = client.post("/api/v1/runtime/data/reset", json={"confirmation": "no"})
        assert refused.status_code == 422, refused.text
        reset = client.post("/api/v1/runtime/data/reset", json={"confirmation": "RESET LOCAL DATA"})
        assert reset.status_code == 202, reset.text
        assert Path(reset.json()["backup_location"]).is_dir()
        assert marker.read_text(encoding="ascii") == "reset\n"
