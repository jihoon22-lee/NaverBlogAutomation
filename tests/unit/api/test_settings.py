"""Tests for safe API configuration and generator selection."""

import pytest

from naver_blog_assistant.api import ApiSettings

ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


def test_environment_defaults_to_real_generator_not_fake(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHROME_EXTENSION_ORIGIN", ORIGIN)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("COMMENT_GENERATOR_MODE", raising=False)

    settings = ApiSettings.from_environment()

    assert settings.generator_mode == "openai"
    assert settings.app_environment == "production"
    assert settings.openai_model == "gpt-5.6-terra"
    assert settings.openai_reasoning_effort == "low"
    assert settings.openai_timeout_seconds < settings.generation_timeout_seconds


def test_provider_timeout_must_finish_before_outer_timeout() -> None:
    with pytest.raises(ValueError, match="below GENERATION_TIMEOUT_SECONDS"):
        ApiSettings(
            extension_origin=ORIGIN,
            openai_api_key="test-key",
            generation_timeout_seconds=10,
            openai_timeout_seconds=10,
        )


def test_fake_generator_requires_explicit_non_production_environment() -> None:
    with pytest.raises(ValueError, match="forbidden"):
        ApiSettings(extension_origin=ORIGIN, generator_mode="fake")


@pytest.mark.parametrize(
    "origin",
    ["", "http://example.com", "chrome-extension://invalid"],
)
def test_extension_origin_must_be_one_exact_chrome_origin(origin: str) -> None:
    with pytest.raises(ValueError, match="CHROME_EXTENSION_ORIGIN"):
        ApiSettings(extension_origin=origin, openai_api_key="test-key")


def test_openai_mode_requires_key() -> None:
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        ApiSettings(extension_origin=ORIGIN)


def test_api_key_is_hidden_from_settings_repr() -> None:
    settings = ApiSettings(extension_origin=ORIGIN, openai_api_key="private-test-key")

    assert "private-test-key" not in repr(settings)
