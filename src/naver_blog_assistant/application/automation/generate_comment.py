"""Generate comment candidates for one extracted post using stored settings.

The web app posts a URL, not an article body: the service extracts the post, applies the saved
generation profile for any option the user did not override, derives its own idempotency key, and
returns the stored recommendation. The article body stays in memory for the duration of the request.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from naver_blog_assistant.application.automation.generation_keys import GenerationKeyRegistry
from naver_blog_assistant.application.settings import ReadAppSetting
from naver_blog_assistant.domain import (
    AppSettingKind,
    ArticleExtraction,
    CapturedPost,
    CommentLength,
    CommentMood,
    GenerationPreferences,
    PersonalizationMode,
    Relationship,
    SpeechStyle,
)

MAX_COMMENT_CODE_POINTS: Final = 500


@dataclass(frozen=True, slots=True)
class GenerationOptions:
    """Per-request overrides; unset values fall back to the saved profile."""

    relationship_level: str | None = None
    speech_style: str | None = None
    comment_length: str | None = None
    comment_mood: str | None = None
    personalization_mode: str | None = None
    replace: bool = False


@dataclass(frozen=True, slots=True)
class GenerationPlan:
    """Everything the generation use case needs, resolved from settings and overrides."""

    extraction: ArticleExtraction
    personalization_mode: PersonalizationMode
    post: CapturedPost
    preferences: GenerationPreferences
    request_hash: str


class PlanGeneration:
    """Resolve preferences and the server-owned idempotency key for one extraction."""

    def __init__(self, read_setting: ReadAppSetting, keys: GenerationKeyRegistry) -> None:
        self._read_setting = read_setting
        self._keys = keys

    def effective_preferences(
        self, options: GenerationOptions
    ) -> tuple[GenerationPreferences, PersonalizationMode]:
        """Merge the saved profile with explicit overrides."""
        profile = self._read_setting.execute(AppSettingKind.GENERATION_PROFILE).payload
        preferences = GenerationPreferences(
            relationship=Relationship(options.relationship_level or profile["relationship_level"]),
            speech=SpeechStyle(options.speech_style or profile["speech_style"]),
            length=CommentLength(options.comment_length or profile["comment_length"]),
            mood=CommentMood(options.comment_mood or profile["comment_mood"]),
        )
        personalization = PersonalizationMode(
            options.personalization_mode or profile["personalization_mode"]
        )
        return preferences, personalization

    def execute(self, extraction: ArticleExtraction, options: GenerationOptions) -> GenerationPlan:
        """Return the resolved plan for one extraction."""
        preferences, personalization = self.effective_preferences(options)
        post = CapturedPost(
            source_url=extraction.source_url,
            title=extraction.title,
            body=extraction.body,
        )
        return GenerationPlan(
            extraction=extraction,
            personalization_mode=personalization,
            post=post,
            preferences=preferences,
            request_hash=post.request_hash_for(preferences, personalization),
        )

    def key_for(self, plan: GenerationPlan, options: GenerationOptions) -> tuple[int, str]:
        """Return the attempt number and key for ``plan``, honoring an explicit replacement."""
        attempt = (
            self._keys.replace(plan.request_hash)
            if options.replace
            else self._keys.current(plan.request_hash)
        )
        return attempt.attempt, str(attempt.key)


def closing_phrase(read_setting: ReadAppSetting) -> str:
    """Return the saved closing phrase, which never reaches the provider."""
    return str(read_setting.execute(AppSettingKind.CLOSING_PHRASE).payload["phrase"])


def apply_closing_phrase(comment: str, phrase: str) -> str:
    """Append the closing phrase locally, bounded to the stored comment limit."""
    trimmed = comment.rstrip()
    if not phrase:
        return trimmed
    if trimmed.endswith(phrase):
        return trimmed
    combined = f"{trimmed} {phrase}".strip()
    return combined[:MAX_COMMENT_CODE_POINTS]
