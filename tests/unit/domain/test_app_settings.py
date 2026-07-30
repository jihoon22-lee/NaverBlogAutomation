"""Validation rules for versioned web app settings."""

from __future__ import annotations

from typing import Any

import pytest

from naver_blog_assistant.domain import (
    CONSENT_VERSION,
    DEFAULT_SETTING_PAYLOADS,
    MAX_CLOSING_PHRASE_CODE_POINTS,
    MAX_NEIGHBOR_MESSAGE_CODE_POINTS,
    SETTING_SCHEMA_VERSIONS,
    AppSetting,
    AppSettingKind,
    DomainValidationError,
    default_setting,
    normalize_setting_payload,
)


def profile(**changes: Any) -> dict[str, Any]:
    return {**DEFAULT_SETTING_PAYLOADS[AppSettingKind.GENERATION_PROFILE], **changes}


def policy(**changes: Any) -> dict[str, Any]:
    return {**DEFAULT_SETTING_PAYLOADS[AppSettingKind.SAFETY_POLICY], **changes}


def schedule(**changes: Any) -> dict[str, Any]:
    return {**DEFAULT_SETTING_PAYLOADS[AppSettingKind.SCHEDULE_POLICY], **changes}


@pytest.mark.parametrize("kind", list(AppSettingKind))
def test_every_kind_has_a_valid_default(kind: AppSettingKind) -> None:
    setting = default_setting(kind)

    assert setting.kind is kind
    assert setting.schema_version == SETTING_SCHEMA_VERSIONS[kind]
    assert setting.updated_at is None


@pytest.mark.parametrize("kind", list(AppSettingKind))
def test_defaults_round_trip_through_validation(kind: AppSettingKind) -> None:
    payload = dict(DEFAULT_SETTING_PAYLOADS[kind])

    assert normalize_setting_payload(kind, payload) == normalize_setting_payload(kind, payload)


def test_a_record_rejects_a_future_schema_version() -> None:
    with pytest.raises(DomainValidationError, match="newer schema version"):
        AppSetting(kind=AppSettingKind.CLOSING_PHRASE, schema_version=99, payload={"phrase": ""})


def test_a_record_rejects_a_non_positive_schema_version() -> None:
    with pytest.raises(DomainValidationError, match="schema_version"):
        AppSetting(kind=AppSettingKind.CLOSING_PHRASE, schema_version=0, payload={"phrase": ""})


def test_a_record_rejects_a_non_enum_kind() -> None:
    invalid: Any = "closing_phrase"

    with pytest.raises(DomainValidationError, match="AppSettingKind"):
        AppSetting(kind=invalid, schema_version=1, payload={})


class TestGenerationProfile:
    def test_valid_options_are_normalized(self) -> None:
        payload = normalize_setting_payload(
            AppSettingKind.GENERATION_PROFILE,
            profile(relationship_level="close", speech_style="banmal"),
        )

        assert payload["relationship_level"] == "close"
        assert payload["speech_style"] == "banmal"

    def test_banmal_requires_a_close_relationship(self) -> None:
        with pytest.raises(DomainValidationError, match="banmal"):
            normalize_setting_payload(
                AppSettingKind.GENERATION_PROFILE,
                profile(relationship_level="friendly", speech_style="banmal"),
            )

    @pytest.mark.parametrize(
        "changes",
        [
            {"relationship_level": "unknown"},
            {"speech_style": "formal"},
            {"comment_length": "extra-long"},
            {"comment_mood": "electric"},
            {"personalization_mode": "always"},
            {"relationship_level": None},
            {"comment_length": 3},
        ],
    )
    def test_unknown_options_are_rejected(self, changes: dict[str, Any]) -> None:
        with pytest.raises(DomainValidationError, match="unknown option"):
            normalize_setting_payload(AppSettingKind.GENERATION_PROFILE, profile(**changes))

    def test_an_unexpected_field_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="unexpected settings field"):
            normalize_setting_payload(AppSettingKind.GENERATION_PROFILE, profile(extra="value"))

    def test_a_missing_field_is_rejected(self) -> None:
        payload = profile()
        del payload["comment_mood"]

        with pytest.raises(DomainValidationError, match="missing settings field"):
            normalize_setting_payload(AppSettingKind.GENERATION_PROFILE, payload)


class TestClosingPhrase:
    def test_whitespace_is_trimmed(self) -> None:
        payload = normalize_setting_payload(
            AppSettingKind.CLOSING_PHRASE, {"phrase": "  감사합니다  "}
        )

        assert payload == {"phrase": "감사합니다"}

    def test_the_maximum_length_is_accepted(self) -> None:
        phrase = "가" * MAX_CLOSING_PHRASE_CODE_POINTS

        payload = normalize_setting_payload(AppSettingKind.CLOSING_PHRASE, {"phrase": phrase})

        assert len(payload["phrase"]) == MAX_CLOSING_PHRASE_CODE_POINTS

    def test_one_code_point_over_the_limit_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="50 code points"):
            normalize_setting_payload(
                AppSettingKind.CLOSING_PHRASE,
                {"phrase": "가" * (MAX_CLOSING_PHRASE_CODE_POINTS + 1)},
            )

    def test_a_non_string_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="must be a string"):
            normalize_setting_payload(AppSettingKind.CLOSING_PHRASE, {"phrase": 1})

    def test_emoji_count_as_code_points(self) -> None:
        payload = normalize_setting_payload(
            AppSettingKind.CLOSING_PHRASE, {"phrase": "고맙습니다 🙂"}
        )

        assert "🙂" in payload["phrase"]


class TestNeighborMessage:
    def test_the_maximum_length_is_accepted(self) -> None:
        message = "가" * MAX_NEIGHBOR_MESSAGE_CODE_POINTS

        payload = normalize_setting_payload(AppSettingKind.NEIGHBOR_MESSAGE, {"message": message})

        assert len(payload["message"]) == MAX_NEIGHBOR_MESSAGE_CODE_POINTS

    def test_one_code_point_over_the_limit_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="500 code points"):
            normalize_setting_payload(
                AppSettingKind.NEIGHBOR_MESSAGE,
                {"message": "가" * (MAX_NEIGHBOR_MESSAGE_CODE_POINTS + 1)},
            )


class TestAutomationConsent:
    def test_accepted_consent_requires_the_current_version(self) -> None:
        payload = normalize_setting_payload(
            AppSettingKind.AUTOMATION_CONSENT,
            {"accepted": True, "consent_version": CONSENT_VERSION},
        )

        assert payload["accepted"] is True

    def test_an_outdated_accepted_consent_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="re-accepted"):
            normalize_setting_payload(
                AppSettingKind.AUTOMATION_CONSENT,
                {"accepted": True, "consent_version": CONSENT_VERSION + 1},
            )

    def test_a_withdrawn_consent_may_keep_an_old_version(self) -> None:
        payload = normalize_setting_payload(
            AppSettingKind.AUTOMATION_CONSENT, {"accepted": False, "consent_version": 1}
        )

        assert payload["accepted"] is False

    @pytest.mark.parametrize("value", ["yes", 1, None])
    def test_a_non_boolean_acceptance_is_rejected(self, value: Any) -> None:
        with pytest.raises(DomainValidationError, match="accepted must be a boolean"):
            normalize_setting_payload(
                AppSettingKind.AUTOMATION_CONSENT,
                {"accepted": value, "consent_version": CONSENT_VERSION},
            )

    @pytest.mark.parametrize("value", [0, -1, True, "1"])
    def test_an_invalid_consent_version_is_rejected(self, value: Any) -> None:
        with pytest.raises(DomainValidationError, match="consent_version"):
            normalize_setting_payload(
                AppSettingKind.AUTOMATION_CONSENT, {"accepted": False, "consent_version": value}
            )


class TestSafetyPolicy:
    def test_hours_are_deduplicated_and_sorted(self) -> None:
        payload = normalize_setting_payload(
            AppSettingKind.SAFETY_POLICY, policy(allowed_hours=[22, 9, 9, 10])
        )

        assert payload["allowed_hours"] == [9, 10, 22]

    @pytest.mark.parametrize("hours", [[], [24], [-1], ["9"], [True]])
    def test_invalid_hours_are_rejected(self, hours: list[Any]) -> None:
        with pytest.raises(DomainValidationError):
            normalize_setting_payload(AppSettingKind.SAFETY_POLICY, policy(allowed_hours=hours))

    def test_hours_must_be_a_list(self) -> None:
        with pytest.raises(DomainValidationError, match="non-empty list"):
            normalize_setting_payload(AppSettingKind.SAFETY_POLICY, policy(allowed_hours=9))

    @pytest.mark.parametrize("cap", [0, -1, 201, True, "5", 1.5])
    def test_invalid_caps_are_rejected(self, cap: Any) -> None:
        with pytest.raises(DomainValidationError, match="daily_like_cap"):
            normalize_setting_payload(AppSettingKind.SAFETY_POLICY, policy(daily_like_cap=cap))

    @pytest.mark.parametrize("ratio", [-0.1, 1.1, "0.5", True])
    def test_an_out_of_range_jitter_is_rejected(self, ratio: Any) -> None:
        with pytest.raises(DomainValidationError, match="jitter_ratio"):
            normalize_setting_payload(AppSettingKind.SAFETY_POLICY, policy(jitter_ratio=ratio))

    @pytest.mark.parametrize("ratio", [0, 1, 0.25])
    def test_boundary_jitter_values_are_accepted(self, ratio: Any) -> None:
        payload = normalize_setting_payload(
            AppSettingKind.SAFETY_POLICY, policy(jitter_ratio=ratio)
        )

        assert payload["jitter_ratio"] == float(ratio)

    def test_an_interval_above_an_hour_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="min_interval_seconds"):
            normalize_setting_payload(
                AppSettingKind.SAFETY_POLICY, policy(min_interval_seconds=3_601)
            )


class TestSchedulePolicy:
    @pytest.mark.parametrize("mode", ["manual", "session", "schedule"])
    def test_supported_modes_are_accepted(self, mode: str) -> None:
        payload = normalize_setting_payload(AppSettingKind.SCHEDULE_POLICY, schedule(mode=mode))

        assert payload["mode"] == mode

    def test_an_unknown_mode_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="mode must be"):
            normalize_setting_payload(AppSettingKind.SCHEDULE_POLICY, schedule(mode="unattended"))

    @pytest.mark.parametrize("minute", [-1, 60, "0", True])
    def test_an_invalid_minute_is_rejected(self, minute: Any) -> None:
        with pytest.raises(DomainValidationError, match="minute"):
            normalize_setting_payload(AppSettingKind.SCHEDULE_POLICY, schedule(minute=minute))

    @pytest.mark.parametrize("hour", [-1, 24, "9"])
    def test_an_invalid_hour_is_rejected(self, hour: Any) -> None:
        with pytest.raises(DomainValidationError, match="hour"):
            normalize_setting_payload(AppSettingKind.SCHEDULE_POLICY, schedule(hour=hour))

    def test_the_post_cap_is_bounded(self) -> None:
        with pytest.raises(DomainValidationError, match="max_posts"):
            normalize_setting_payload(AppSettingKind.SCHEDULE_POLICY, schedule(max_posts=51))


class TestBrowserProfile:
    def test_a_blank_channel_selects_bundled_chromium(self) -> None:
        payload = normalize_setting_payload(
            AppSettingKind.BROWSER_PROFILE, {"headless": True, "channel": "  "}
        )

        assert payload == {"headless": True, "channel": ""}

    def test_a_non_boolean_headless_flag_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="headless"):
            normalize_setting_payload(
                AppSettingKind.BROWSER_PROFILE, {"headless": "true", "channel": "chrome"}
            )

    def test_an_overlong_channel_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="channel"):
            normalize_setting_payload(
                AppSettingKind.BROWSER_PROFILE, {"headless": False, "channel": "c" * 33}
            )
