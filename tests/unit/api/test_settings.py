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
    assert settings.openai_max_output_tokens == 3_000
    assert settings.openai_timeout_seconds < settings.generation_timeout_seconds


def test_provider_timeout_must_finish_before_outer_timeout() -> None:
    with pytest.raises(ValueError, match="below GENERATION_TIMEOUT_SECONDS"):
        ApiSettings(
            extension_origin=ORIGIN,
            openai_api_key="test-key",
            generation_timeout_seconds=10,
            openai_timeout_seconds=10,
        )


@pytest.mark.parametrize("timeout", [float("nan"), float("inf"), 0, -1])
def test_provider_timeout_must_be_positive_and_finite(timeout: float) -> None:
    with pytest.raises(ValueError, match="positive finite"):
        ApiSettings(
            extension_origin=ORIGIN,
            openai_api_key="test-key",
            openai_timeout_seconds=timeout,
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


@pytest.mark.parametrize("database_url", ["", "not a URL", "postgresql://localhost/app"])
def test_database_url_must_use_sqlite_without_echoing_its_value(database_url: str) -> None:
    with pytest.raises(ValueError, match="DATABASE_URL") as captured:
        ApiSettings(
            extension_origin=ORIGIN,
            database_url=database_url,
            openai_api_key="test-key",
        )

    if database_url:
        assert database_url not in str(captured.value)


def test_api_key_is_hidden_from_settings_repr() -> None:
    settings = ApiSettings(extension_origin=ORIGIN, openai_api_key="private-test-key")

    assert "private-test-key" not in repr(settings)


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        ("MAX_REQUEST_BYTES", "many", "MAX_REQUEST_BYTES must be an integer"),
        ("GENERATION_TIMEOUT_SECONDS", "soon", "GENERATION_TIMEOUT_SECONDS must be a number"),
        ("OPENAI_MAX_OUTPUT_TOKENS", "many", "OPENAI_MAX_OUTPUT_TOKENS must be an integer"),
    ],
)
def test_environment_reports_actionable_numeric_errors(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str, message: str
) -> None:
    monkeypatch.setenv("CHROME_EXTENSION_ORIGIN", ORIGIN)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv(name, value)

    with pytest.raises(ValueError, match=message):
        ApiSettings.from_environment()


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        ("MAX_REQUEST_BYTES", "0", "request and timeout limits"),
        ("GENERATION_TIMEOUT_SECONDS", "0", "request and timeout limits"),
        ("OPENAI_TIMEOUT_SECONDS", "0", "positive finite"),
        ("OPENAI_MAX_OUTPUT_TOKENS", "0", "model and output token"),
        ("RATE_LIMIT_REQUESTS", "0", "RATE_LIMIT_REQUESTS"),
        ("RATE_LIMIT_WINDOW_SECONDS", "0", "RATE_LIMIT_REQUESTS"),
    ],
)
def test_environment_rejects_nonpositive_limits(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str, message: str
) -> None:
    monkeypatch.setenv("CHROME_EXTENSION_ORIGIN", ORIGIN)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv(name, value)

    with pytest.raises(ValueError, match=message):
        ApiSettings.from_environment()


def test_secretless_validation_rejects_an_empty_key_without_exposing_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHROME_EXTENSION_ORIGIN", ORIGIN)
    monkeypatch.setenv("OPENAI_API_KEY", "")

    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        ApiSettings.validate_environment_without_secrets()
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        ApiSettings.from_environment()


@pytest.mark.parametrize(
    ("requests", "window"),
    [(0, 60), (10, 0), (10, float("nan"))],
)
def test_rate_limit_settings_must_be_positive(requests: int, window: float) -> None:
    with pytest.raises(ValueError, match="RATE_LIMIT_REQUESTS"):
        ApiSettings(
            extension_origin=ORIGIN,
            openai_api_key="test-key",
            rate_limit_requests=requests,
            rate_limit_window_seconds=window,
        )
