"""Tests for the loopback-only process launcher."""

from unittest.mock import Mock

import pytest

from naver_blog_assistant.api import __main__ as launcher


def test_launcher_rejects_non_loopback_binding(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_HOST", "0.0.0.0")

    with pytest.raises(RuntimeError, match="127.0.0.1"):
        launcher.main()


@pytest.mark.parametrize("port", ["not-a-port", "8766"])
def test_launcher_rejects_non_contract_port(monkeypatch: pytest.MonkeyPatch, port: str) -> None:
    monkeypatch.setenv("API_PORT", port)

    with pytest.raises(RuntimeError, match="API_PORT"):
        launcher.main()


def test_launcher_starts_composed_app_on_fixed_address(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_HOST", "127.0.0.1")
    monkeypatch.setenv("API_PORT", "8765")
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("COMMENT_GENERATOR_MODE", "fake")
    monkeypatch.setenv(
        "CHROME_EXTENSION_ORIGIN",
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    app = object()
    create_app = Mock(return_value=app)
    run = Mock()
    monkeypatch.setattr(launcher, "create_app", create_app)
    monkeypatch.setattr(launcher.uvicorn, "run", run)

    launcher.main()

    create_app.assert_called_once()
    run.assert_called_once_with(app, host="127.0.0.1", port=8765)
