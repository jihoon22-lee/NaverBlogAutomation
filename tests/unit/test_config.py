"""Tests for environment-backed configuration."""

import pytest

from naver_blog_assistant.config import Settings


def test_settings_require_openai_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(RuntimeError, match="OPENAI_API_KEY is not configured"):
        Settings.from_environment()


def test_settings_load_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///test.db")

    settings = Settings.from_environment()

    assert settings.openai_api_key == "test-key"
    assert settings.database_url == "sqlite:///test.db"


def test_settings_use_default_database(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("DATABASE_URL", raising=False)

    settings = Settings.from_environment()

    assert settings.database_url == "sqlite:///data/naver_blog_assistant.db"
