"""Tests for redacted local setup diagnostics."""

from __future__ import annotations

import io
import stat
import urllib.error
from pathlib import Path

import pytest
from scripts import check_local_setup


def configure_fake_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_HOST", "127.0.0.1")
    monkeypatch.setenv("API_PORT", "8765")
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("COMMENT_GENERATOR_MODE", "fake")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///data/app.db")


def repository_fixture(root: Path) -> None:
    (root / "data").mkdir()
    environment = root / ".env.local"
    environment.write_text("synthetic configuration\n", encoding="utf-8")
    environment.chmod(0o600)
    dist = root / "client" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")
    (dist / "app.js").write_text("export {};", encoding="utf-8")
    (dist / "app.css").write_text("body {}", encoding="utf-8")


def test_diagnostics_pass_fake_setup_without_requiring_a_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure_fake_environment(monkeypatch)
    repository_fixture(tmp_path)
    monkeypatch.setattr(
        check_local_setup,
        "_tool_version",
        lambda command, expected: check_local_setup.CheckResult(command, True, str(expected)),
    )
    checks = check_local_setup.collect_checks(
        root=tmp_path,
        environment_file=tmp_path / ".env.local",
    )

    assert checks
    assert all(result.ok for result in checks)
    assert all("OPENAI_API_KEY" not in result.detail for result in checks)


def test_diagnostics_never_display_api_key_value(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "must-not-appear"
    monkeypatch.setenv("COMMENT_GENERATOR_MODE", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", secret)

    result = check_local_setup._api_key_check()

    assert result.ok
    assert secret not in result.detail
    assert "not retained" in result.detail


def test_diagnostics_reject_an_empty_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COMMENT_GENERATOR_MODE", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "")

    result = check_local_setup._api_key_check()

    assert not result.ok
    assert result.detail == "missing or empty"


def test_diagnostics_reports_optional_naver_search_without_disclosing_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client_id = "private-client-id"
    client_secret = "private-client-secret"
    monkeypatch.setenv("NAVER_SEARCH_CLIENT_ID", client_id)
    monkeypatch.setenv("NAVER_SEARCH_CLIENT_SECRET", client_secret)

    result = check_local_setup._naver_search_api_check()

    assert result.ok
    assert client_id not in result.detail
    assert client_secret not in result.detail


def test_environment_permission_check_rejects_broad_posix_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / ".env.local"
    path.write_text("synthetic\n", encoding="utf-8")
    path.chmod(0o644)
    monkeypatch.setattr(check_local_setup.os, "name", "posix")

    result = check_local_setup._environment_file_check(path)

    assert not result.ok
    assert stat.S_IMODE(path.stat().st_mode) == 0o644


def test_external_environment_check_requires_private_parent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    parent = tmp_path / "config"
    parent.mkdir(mode=0o755)
    parent.chmod(0o755)
    path = parent / "env"
    path.write_text("synthetic\n", encoding="utf-8")
    path.chmod(0o600)
    monkeypatch.setattr(check_local_setup.os, "name", "posix")

    result = check_local_setup._environment_file_check(path, require_private_parent=True)

    assert not result.ok
    assert "parent mode" in result.detail


def test_live_origin_boundary_accepts_only_the_expected_rejection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = (
        b'{"type":"about:blank","title":"Origin forbidden","status":403,'
        b'"detail":"This browser origin is not allowed to access the local API.",'
        b'"code":"origin_forbidden","request_id":"00000000-0000-4000-8000-000000000001"}'
    )
    error = urllib.error.HTTPError(
        "http://127.0.0.1:8765/health",
        403,
        "Forbidden",
        {},
        io.BytesIO(payload),
    )

    def reject_foreign_origin(request: object, timeout: int) -> object:
        del request, timeout
        raise error

    monkeypatch.setattr(check_local_setup.urllib.request, "urlopen", reject_foreign_origin)

    result = check_local_setup._origin_boundary_check()

    assert result == check_local_setup.CheckResult(
        "API Origin boundary", True, "foreign browser Origin is rejected"
    )


def test_require_api_checks_health_and_origin_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure_fake_environment(monkeypatch)
    repository_fixture(tmp_path)
    monkeypatch.setattr(
        check_local_setup,
        "_tool_version",
        lambda command, expected: check_local_setup.CheckResult(command, True, str(expected)),
    )
    monkeypatch.setattr(
        check_local_setup,
        "_health_check",
        lambda: check_local_setup.CheckResult("API health", True, "healthy"),
    )
    monkeypatch.setattr(
        check_local_setup,
        "_origin_boundary_check",
        lambda: check_local_setup.CheckResult("API Origin boundary", True, "rejected"),
    )

    checks = check_local_setup.collect_checks(
        root=tmp_path,
        environment_file=tmp_path / ".env.local",
        require_api=True,
    )

    assert [result.name for result in checks[-2:]] == ["API health", "API Origin boundary"]
