"""Preference resolution, plan derivation, and closing-phrase behavior."""

from __future__ import annotations

import pytest

from naver_blog_assistant.application.automation import (
    MAX_COMMENT_CODE_POINTS,
    GenerationKeyRegistry,
    GenerationOptions,
    PlanGeneration,
    apply_closing_phrase,
    closing_phrase,
)
from naver_blog_assistant.application.settings import ReadAppSetting, SaveAppSetting
from naver_blog_assistant.domain import (
    AppSetting,
    AppSettingKind,
    ArticleExtraction,
    CommentLength,
    CommentMood,
    DomainValidationError,
    PersonalizationMode,
    Relationship,
    SpeechStyle,
)

BODY = "합성 본문입니다. 충분히 긴 문장을 포함한 테스트 본문입니다."


class FakeSettings:
    def __init__(self) -> None:
        self.records: dict[AppSettingKind, AppSetting] = {}

    def get(self, kind: AppSettingKind) -> AppSetting | None:
        return self.records.get(kind)

    def save(self, setting: AppSetting) -> AppSetting:
        self.records[setting.kind] = setting
        return setting


def extraction(*, body: str = BODY, title: str = "합성 제목") -> ArticleExtraction:
    return ArticleExtraction(
        source_url="https://blog.naver.com/example/223456789012",
        title=title,
        body=body,
        original_length=len(body),
    )


def planner(repository: FakeSettings | None = None) -> tuple[PlanGeneration, FakeSettings]:
    store = repository if repository is not None else FakeSettings()
    return PlanGeneration(ReadAppSetting(store), GenerationKeyRegistry()), store


def test_unset_options_fall_back_to_the_default_profile() -> None:
    plan_generation, _ = planner()

    preferences, personalization = plan_generation.effective_preferences(GenerationOptions())

    assert preferences.relationship is Relationship.FRIENDLY
    assert preferences.speech is SpeechStyle.HONORIFIC
    assert preferences.length is CommentLength.MEDIUM
    assert preferences.mood is CommentMood.WARM
    assert personalization is PersonalizationMode.OFF


def test_unset_options_fall_back_to_the_saved_profile() -> None:
    plan_generation, store = planner()
    SaveAppSetting(store).execute(
        AppSettingKind.GENERATION_PROFILE,
        {
            "relationship_level": "close",
            "speech_style": "banmal",
            "comment_length": "long",
            "comment_mood": "lively",
            "personalization_mode": "completed_examples",
        },
    )

    preferences, personalization = plan_generation.effective_preferences(GenerationOptions())

    assert preferences.relationship is Relationship.CLOSE
    assert preferences.speech is SpeechStyle.BANMAL
    assert preferences.length is CommentLength.LONG
    assert personalization is PersonalizationMode.COMPLETED_EXAMPLES


def test_explicit_overrides_win_over_the_saved_profile() -> None:
    plan_generation, store = planner()
    SaveAppSetting(store).execute(
        AppSettingKind.GENERATION_PROFILE,
        {
            "relationship_level": "close",
            "speech_style": "honorific",
            "comment_length": "long",
            "comment_mood": "lively",
            "personalization_mode": "off",
        },
    )

    preferences, _ = plan_generation.effective_preferences(
        GenerationOptions(comment_length="short", comment_mood="calm")
    )

    assert preferences.length is CommentLength.SHORT
    assert preferences.mood is CommentMood.CALM
    assert preferences.relationship is Relationship.CLOSE


def test_an_unknown_override_is_rejected() -> None:
    plan_generation, _ = planner()

    with pytest.raises(ValueError):
        plan_generation.effective_preferences(GenerationOptions(comment_length="huge"))


def test_an_invalid_combination_is_rejected() -> None:
    plan_generation, _ = planner()

    with pytest.raises(DomainValidationError, match="banmal"):
        plan_generation.execute(
            extraction(), GenerationOptions(relationship_level="new", speech_style="banmal")
        )


def test_the_plan_binds_the_digest_to_the_effective_options() -> None:
    plan_generation, _ = planner()

    default_plan = plan_generation.execute(extraction(), GenerationOptions())
    other_plan = plan_generation.execute(extraction(), GenerationOptions(comment_length="short"))

    assert default_plan.request_hash != other_plan.request_hash
    assert default_plan.post.title == "합성 제목"


def test_the_same_request_reuses_the_same_key() -> None:
    plan_generation, _ = planner()
    plan = plan_generation.execute(extraction(), GenerationOptions())

    first = plan_generation.key_for(plan, GenerationOptions())
    second = plan_generation.key_for(plan, GenerationOptions())

    assert first == second
    assert first[0] == 1


def test_an_explicit_replacement_issues_a_new_key() -> None:
    plan_generation, _ = planner()
    plan = plan_generation.execute(extraction(), GenerationOptions())
    first = plan_generation.key_for(plan, GenerationOptions())

    replacement = plan_generation.key_for(plan, GenerationOptions(replace=True))

    assert replacement[0] == 2
    assert replacement[1] != first[1]


def test_a_changed_body_changes_the_key() -> None:
    plan_generation, _ = planner()
    first = plan_generation.execute(extraction(), GenerationOptions())
    changed = extraction(body=f"{BODY} 추가 문장입니다.")
    second = plan_generation.execute(changed, GenerationOptions(replace=False))

    assert plan_generation.key_for(first, GenerationOptions()) != plan_generation.key_for(
        second, GenerationOptions()
    )


class TestClosingPhrase:
    def test_the_saved_phrase_is_returned(self) -> None:
        store = FakeSettings()
        SaveAppSetting(store).execute(AppSettingKind.CLOSING_PHRASE, {"phrase": "감사합니다"})

        assert closing_phrase(ReadAppSetting(store)) == "감사합니다"

    def test_the_default_phrase_is_empty(self) -> None:
        assert closing_phrase(ReadAppSetting(FakeSettings())) == ""

    def test_an_empty_phrase_only_trims_the_comment(self) -> None:
        assert apply_closing_phrase("좋은 글이네요.  ", "") == "좋은 글이네요."

    def test_the_phrase_is_appended_once(self) -> None:
        assert apply_closing_phrase("좋은 글이네요.", "감사합니다") == "좋은 글이네요. 감사합니다"

    def test_an_already_appended_phrase_is_not_duplicated(self) -> None:
        assert (
            apply_closing_phrase("좋은 글이네요. 감사합니다", "감사합니다")
            == "좋은 글이네요. 감사합니다"
        )

    def test_the_combined_comment_is_bounded(self) -> None:
        comment = "가" * MAX_COMMENT_CODE_POINTS

        combined = apply_closing_phrase(comment, "감사합니다")

        assert len(combined) == MAX_COMMENT_CODE_POINTS
