"""Versioned web app settings owned by the local service.

The extension keeps using `chrome.storage.local`; these records exist so the unattended
scheduler can read the same preferences the web app writes. Every payload is validated here
rather than trusted from transport, and each kind carries its own schema version.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, Final

from naver_blog_assistant.domain.llm import DEFAULT_MODELS, LlmProvider, ModelSelection
from naver_blog_assistant.domain.models import (
    CommentLength,
    CommentMood,
    DomainValidationError,
    PersonalizationMode,
    Relationship,
    SpeechStyle,
)

MAX_CLOSING_PHRASE_CODE_POINTS: Final = 50
MAX_NEIGHBOR_MESSAGE_CODE_POINTS: Final = 500
CONSENT_VERSION: Final = 1


class AppSettingKind(StrEnum):
    """Settings records the web app may store."""

    GENERATION_PROFILE = "generation_profile"
    CLOSING_PHRASE = "closing_phrase"
    NEIGHBOR_MESSAGE = "neighbor_message"
    AUTOMATION_CONSENT = "automation_consent"
    SAFETY_POLICY = "safety_policy"
    SCHEDULE_POLICY = "schedule_policy"
    BROWSER_PROFILE = "browser_profile"
    LLM_PROVIDERS = "llm_providers"
    LLM_BUDGET = "llm_budget"


SETTING_SCHEMA_VERSIONS: Final[dict[AppSettingKind, int]] = {
    AppSettingKind.GENERATION_PROFILE: 1,
    AppSettingKind.CLOSING_PHRASE: 1,
    AppSettingKind.NEIGHBOR_MESSAGE: 1,
    AppSettingKind.AUTOMATION_CONSENT: 1,
    AppSettingKind.SAFETY_POLICY: 1,
    AppSettingKind.SCHEDULE_POLICY: 1,
    AppSettingKind.BROWSER_PROFILE: 1,
    AppSettingKind.LLM_PROVIDERS: 1,
    AppSettingKind.LLM_BUDGET: 1,
}


@dataclass(frozen=True, slots=True)
class AppSetting:
    """One stored settings record."""

    kind: AppSettingKind
    schema_version: int
    payload: dict[str, Any]
    updated_at: datetime | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.kind, AppSettingKind):
            raise DomainValidationError("kind must be an AppSettingKind")
        if self.schema_version < 1:
            raise DomainValidationError("schema_version must be positive")
        if self.schema_version > SETTING_SCHEMA_VERSIONS[self.kind]:
            raise DomainValidationError(
                "the stored record uses a newer schema version than this build supports"
            )


def normalize_setting_payload(kind: AppSettingKind, payload: dict[str, Any]) -> dict[str, Any]:
    """Return a validated payload for ``kind``, rejecting unknown or malformed values."""
    validator = _VALIDATORS.get(kind)
    if validator is None:
        raise DomainValidationError(f"{kind.value} has no payload validator")
    return validator(payload)


def _require_exact_keys(payload: dict[str, Any], expected: frozenset[str]) -> None:
    unexpected = set(payload) - expected
    if unexpected:
        raise DomainValidationError(f"unexpected settings field: {sorted(unexpected)[0]}")
    missing = expected - set(payload)
    if missing:
        raise DomainValidationError(f"missing settings field: {sorted(missing)[0]}")


def _bounded_text(value: Any, *, field: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise DomainValidationError(f"{field} must be a string")
    normalized = value.strip()
    if len(normalized) > maximum:
        raise DomainValidationError(f"{field} must not exceed {maximum} code points")
    return normalized


def _generation_profile(payload: dict[str, Any]) -> dict[str, Any]:
    _require_exact_keys(
        payload,
        frozenset(
            {
                "relationship_level",
                "speech_style",
                "comment_length",
                "comment_mood",
                "personalization_mode",
            }
        ),
    )
    try:
        relationship = Relationship(payload["relationship_level"])
        speech = SpeechStyle(payload["speech_style"])
        length = CommentLength(payload["comment_length"])
        mood = CommentMood(payload["comment_mood"])
        personalization = PersonalizationMode(payload["personalization_mode"])
    except (TypeError, ValueError) as error:
        raise DomainValidationError("generation profile contains an unknown option") from error
    if speech is SpeechStyle.BANMAL and relationship is not Relationship.CLOSE:
        raise DomainValidationError("banmal is allowed only for a close relationship")
    return {
        "relationship_level": relationship.value,
        "speech_style": speech.value,
        "comment_length": length.value,
        "comment_mood": mood.value,
        "personalization_mode": personalization.value,
    }


def _closing_phrase(payload: dict[str, Any]) -> dict[str, Any]:
    _require_exact_keys(payload, frozenset({"phrase"}))
    return {
        "phrase": _bounded_text(
            payload["phrase"], field="phrase", maximum=MAX_CLOSING_PHRASE_CODE_POINTS
        )
    }


def _neighbor_message(payload: dict[str, Any]) -> dict[str, Any]:
    _require_exact_keys(payload, frozenset({"message"}))
    return {
        "message": _bounded_text(
            payload["message"], field="message", maximum=MAX_NEIGHBOR_MESSAGE_CODE_POINTS
        )
    }


def _automation_consent(payload: dict[str, Any]) -> dict[str, Any]:
    _require_exact_keys(payload, frozenset({"accepted", "consent_version"}))
    accepted = payload["accepted"]
    version = payload["consent_version"]
    if not isinstance(accepted, bool):
        raise DomainValidationError("accepted must be a boolean")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise DomainValidationError("consent_version must be a positive integer")
    if accepted and version != CONSENT_VERSION:
        raise DomainValidationError("consent must be re-accepted for the current version")
    return {"accepted": accepted, "consent_version": version}


def _safety_policy(payload: dict[str, Any]) -> dict[str, Any]:
    _require_exact_keys(
        payload,
        frozenset(
            {
                "daily_like_cap",
                "daily_comment_cap",
                "daily_neighbor_cap",
                "min_interval_seconds",
                "jitter_ratio",
                "allowed_hours",
                "max_consecutive_failures",
            }
        ),
    )
    caps = {
        key: _positive_int(payload[key], field=key, maximum=200)
        for key in ("daily_like_cap", "daily_comment_cap", "daily_neighbor_cap")
    }
    interval = _positive_int(
        payload["min_interval_seconds"], field="min_interval_seconds", maximum=3_600
    )
    jitter = payload["jitter_ratio"]
    if not isinstance(jitter, int | float) or isinstance(jitter, bool):
        raise DomainValidationError("jitter_ratio must be a number")
    if not 0 <= float(jitter) <= 1:
        raise DomainValidationError("jitter_ratio must be between 0 and 1")
    hours = payload["allowed_hours"]
    if not isinstance(hours, list) or not hours:
        raise DomainValidationError("allowed_hours must be a non-empty list")
    normalized_hours = sorted({_hour(value) for value in hours})
    failures = _positive_int(
        payload["max_consecutive_failures"], field="max_consecutive_failures", maximum=20
    )
    return {
        **caps,
        "min_interval_seconds": interval,
        "jitter_ratio": float(jitter),
        "allowed_hours": normalized_hours,
        "max_consecutive_failures": failures,
    }


def _schedule_policy(payload: dict[str, Any]) -> dict[str, Any]:
    _require_exact_keys(payload, frozenset({"mode", "hour", "minute", "max_posts"}))
    mode = payload["mode"]
    if mode not in {"manual", "session", "schedule"}:
        raise DomainValidationError("mode must be manual, session, or schedule")
    hour = _hour(payload["hour"])
    minute = payload["minute"]
    if not isinstance(minute, int) or isinstance(minute, bool) or not 0 <= minute <= 59:
        raise DomainValidationError("minute must be between 0 and 59")
    return {
        "mode": mode,
        "hour": hour,
        "minute": minute,
        "max_posts": _positive_int(payload["max_posts"], field="max_posts", maximum=50),
    }


def _browser_profile(payload: dict[str, Any]) -> dict[str, Any]:
    _require_exact_keys(payload, frozenset({"headless", "channel"}))
    headless = payload["headless"]
    if not isinstance(headless, bool):
        raise DomainValidationError("headless must be a boolean")
    return {
        "headless": headless,
        "channel": _bounded_text(payload["channel"], field="channel", maximum=32),
    }


def _llm_providers(payload: dict[str, Any]) -> dict[str, Any]:
    _require_exact_keys(payload, frozenset({"default_provider", "models"}))
    try:
        default = LlmProvider(payload["default_provider"])
    except (TypeError, ValueError) as error:
        raise DomainValidationError("default_provider is not a known provider") from error
    models = payload["models"]
    if not isinstance(models, dict) or not models:
        raise DomainValidationError("models must be a non-empty object")
    normalized: dict[str, str] = {}
    for name, model in models.items():
        try:
            provider = LlmProvider(name)
        except (TypeError, ValueError) as error:
            raise DomainValidationError(f"{name} is not a known provider") from error
        selection = ModelSelection(provider=provider, model=_model_name(model))
        normalized[provider.value] = selection.model
    if default.value not in normalized:
        raise DomainValidationError("default_provider must appear in models")
    return {"default_provider": default.value, "models": dict(sorted(normalized.items()))}


def _llm_budget(payload: dict[str, Any]) -> dict[str, Any]:
    _require_exact_keys(payload, frozenset({"daily_call_cap", "per_request_provider_cap"}))
    return {
        "daily_call_cap": _positive_int(
            payload["daily_call_cap"], field="daily_call_cap", maximum=1_000
        ),
        "per_request_provider_cap": _positive_int(
            payload["per_request_provider_cap"], field="per_request_provider_cap", maximum=3
        ),
    }


def _model_name(value: Any) -> str:
    if not isinstance(value, str):
        raise DomainValidationError("model must be a string")
    return value.strip()


def _positive_int(value: Any, *, field: str, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise DomainValidationError(f"{field} must be an integer")
    if not 1 <= value <= maximum:
        raise DomainValidationError(f"{field} must be between 1 and {maximum}")
    return value


def _hour(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 23:
        raise DomainValidationError("hour values must be between 0 and 23")
    return value


_VALIDATORS: Final[dict[AppSettingKind, Any]] = {
    AppSettingKind.GENERATION_PROFILE: _generation_profile,
    AppSettingKind.CLOSING_PHRASE: _closing_phrase,
    AppSettingKind.NEIGHBOR_MESSAGE: _neighbor_message,
    AppSettingKind.AUTOMATION_CONSENT: _automation_consent,
    AppSettingKind.SAFETY_POLICY: _safety_policy,
    AppSettingKind.SCHEDULE_POLICY: _schedule_policy,
    AppSettingKind.BROWSER_PROFILE: _browser_profile,
    AppSettingKind.LLM_PROVIDERS: _llm_providers,
    AppSettingKind.LLM_BUDGET: _llm_budget,
}

DEFAULT_SETTING_PAYLOADS: Final[dict[AppSettingKind, dict[str, Any]]] = {
    AppSettingKind.GENERATION_PROFILE: {
        "relationship_level": Relationship.FRIENDLY.value,
        "speech_style": SpeechStyle.HONORIFIC.value,
        "comment_length": CommentLength.MEDIUM.value,
        "comment_mood": CommentMood.WARM.value,
        "personalization_mode": PersonalizationMode.OFF.value,
    },
    AppSettingKind.CLOSING_PHRASE: {"phrase": ""},
    AppSettingKind.NEIGHBOR_MESSAGE: {"message": ""},
    AppSettingKind.AUTOMATION_CONSENT: {"accepted": False, "consent_version": CONSENT_VERSION},
    AppSettingKind.SAFETY_POLICY: {
        "daily_like_cap": 20,
        "daily_comment_cap": 20,
        "daily_neighbor_cap": 5,
        "min_interval_seconds": 90,
        "jitter_ratio": 0.4,
        "allowed_hours": list(range(9, 23)),
        "max_consecutive_failures": 3,
    },
    AppSettingKind.SCHEDULE_POLICY: {"mode": "manual", "hour": 10, "minute": 0, "max_posts": 5},
    AppSettingKind.BROWSER_PROFILE: {"headless": False, "channel": "chrome"},
    AppSettingKind.LLM_PROVIDERS: {
        "default_provider": LlmProvider.OPENAI.value,
        "models": {provider.value: model for provider, model in DEFAULT_MODELS.items()},
    },
    AppSettingKind.LLM_BUDGET: {"daily_call_cap": 60, "per_request_provider_cap": 3},
}


def default_setting(kind: AppSettingKind) -> AppSetting:
    """Return the documented default record for ``kind``."""
    return AppSetting(
        kind=kind,
        schema_version=SETTING_SCHEMA_VERSIONS[kind],
        payload=normalize_setting_payload(kind, dict(DEFAULT_SETTING_PAYLOADS[kind])),
    )
