"""Tests for serving the local web app from the same loopback origin."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from naver_blog_assistant.api.routers.spa import (
    APP_MOUNT_PATH,
    register_app_mount,
    resolve_app_directory,
)

INDEX = "<!doctype html><html lang='ko'><body><main id='workspace'></main></body></html>"


def build_assets(root: Path) -> Path:
    directory = root / "client" / "dist"
    directory.mkdir(parents=True)
    (directory / "index.html").write_text(INDEX, encoding="utf-8")
    (directory / "app.js").write_text("export const app = 1;\n", encoding="utf-8")
    (directory / "service-worker.js").write_text("self.addEventListener('fetch', () => {});\n")
    return directory


def test_the_built_app_directory_is_resolved(tmp_path: Path) -> None:
    build_assets(tmp_path)

    assert resolve_app_directory(tmp_path) == tmp_path / "client" / "dist"


def test_a_missing_directory_resolves_to_none(tmp_path: Path) -> None:
    assert resolve_app_directory(tmp_path) is None


def test_a_directory_without_an_index_resolves_to_none(tmp_path: Path) -> None:
    (tmp_path / "client" / "dist").mkdir(parents=True)

    assert resolve_app_directory(tmp_path) is None


def test_mounting_serves_the_app_shell(tmp_path: Path) -> None:
    app = FastAPI()

    assert register_app_mount(app, directory=build_assets(tmp_path)) is True
    with TestClient(app) as client:
        response = client.get(f"{APP_MOUNT_PATH}/")

    assert response.status_code == 200
    assert "workspace" in response.text


def test_mounting_serves_the_bundle(tmp_path: Path) -> None:
    app = FastAPI()
    register_app_mount(app, directory=build_assets(tmp_path))

    with TestClient(app) as client:
        response = client.get(f"{APP_MOUNT_PATH}/app.js")

    assert response.status_code == 200
    assert "export const app" in response.text


def test_mounting_serves_the_static_service_worker(tmp_path: Path) -> None:
    app = FastAPI()
    register_app_mount(app, directory=build_assets(tmp_path))

    with TestClient(app) as client:
        response = client.get(f"{APP_MOUNT_PATH}/service-worker.js")

    assert response.status_code == 200
    assert "addEventListener" in response.text


def test_an_unknown_asset_is_not_found(tmp_path: Path) -> None:
    app = FastAPI()
    register_app_mount(app, directory=build_assets(tmp_path))

    with TestClient(app) as client:
        response = client.get(f"{APP_MOUNT_PATH}/missing.js")

    assert response.status_code == 404


def test_mounting_is_skipped_without_built_assets(monkeypatch: pytest.MonkeyPatch) -> None:
    app = FastAPI()
    monkeypatch.setattr("naver_blog_assistant.api.routers.spa.resolve_app_directory", lambda: None)

    assert register_app_mount(app) is False
    assert not [route for route in app.routes if getattr(route, "name", "") == "webapp"]


def test_the_app_mount_path_is_stable() -> None:
    assert APP_MOUNT_PATH == "/app"
