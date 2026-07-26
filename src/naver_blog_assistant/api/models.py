"""Pydantic transport models matching the checked-in OpenAPI contract."""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from difflib import SequenceMatcher
from itertools import combinations
from typing import Annotated, Literal, Self, cast
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from naver_blog_assistant.domain import (
    CommentLength,
    CommentMood,
    DigestSettings,
    DiscoveredPost,
    GenerationPreferences,
    ImportedDiscoveryPost,
    NeighborBlog,
    PersonalizationMode,
    Recommendation,
    Relationship,
    ReviewStatus,
    SavedSearch,
    SpeechStyle,
    comment_length_bounds,
)

ShortText = Annotated[str, StringConstraints(min_length=1, max_length=300)]
CommentText = Annotated[str, StringConstraints(min_length=1, max_length=500)]
TopicText = Annotated[str, StringConstraints(min_length=1, max_length=80)]
QualityWarning = Literal[
    "length_target_missed",
    "candidate_roles_blurred",
    "candidates_too_similar",
]


class StrictModel(BaseModel):
    """Reject undeclared fields so clients cannot silently send stale data."""

    model_config = ConfigDict(extra="forbid")


class HealthResponse(StrictModel):
    status: Literal["ok"] = "ok"


class ServiceStatusResponse(StrictModel):
    status: Literal["ready"]
    api_version: str
    app_environment: Literal["production", "development", "test"]
    database: Literal["ready"]
    generator_mode: Literal["openai", "fake"]
    generator_model: ShortText


class CreateRecommendationRequest(StrictModel):
    source_url: Annotated[
        str,
        StringConstraints(min_length=1, max_length=2048),
        Field(json_schema_extra={"format": "uri"}),
    ]
    title: ShortText
    body: Annotated[str, StringConstraints(min_length=20, max_length=100_000)]
    relationship_level: Literal["new", "polite", "friendly", "close"] = "friendly"
    speech_style: Literal["honorific", "banmal"] = "honorific"
    comment_length: Literal["short", "medium", "long"] = "medium"
    comment_mood: Literal["calm", "warm", "lively"] = "warm"
    personalization_mode: Literal["off", "completed_examples"] = "completed_examples"

    @field_validator("source_url", "title", "body", mode="before")
    @classmethod
    def normalize_whitespace(cls, value: object) -> object:
        """Normalize browser-extracted whitespace before validation and hashing."""
        if isinstance(value, str):
            return re.sub(r"\s+", " ", value).strip()
        return value

    @model_validator(mode="after")
    def validate_preference_combination(self) -> Self:
        if self.speech_style == "banmal" and self.relationship_level != "close":
            raise ValueError("banmal is allowed only when relationship_level is close")
        return self

    def to_generation_preferences(self) -> GenerationPreferences:
        """Map public transport names to the internal provenance value object."""
        return GenerationPreferences(
            relationship=Relationship(self.relationship_level),
            speech=SpeechStyle(self.speech_style),
            length=CommentLength(self.comment_length),
            mood=CommentMood(self.comment_mood),
        )

    def to_personalization_mode(self) -> PersonalizationMode:
        return PersonalizationMode(self.personalization_mode)


class CommentCandidateResponse(StrictModel):
    id: UUID
    tone: Literal["warm", "curious", "supportive"]
    comment: CommentText
    referenced_detail: ShortText


class RecommendationResponse(StrictModel):
    id: UUID
    source_url: Annotated[
        str,
        StringConstraints(min_length=1, max_length=2048),
        Field(json_schema_extra={"format": "uri"}),
    ]
    title: ShortText
    summary: Annotated[str, StringConstraints(min_length=1, max_length=800)]
    topics: Annotated[list[TopicText], Field(min_length=1, max_length=5)]
    candidates: Annotated[list[CommentCandidateResponse], Field(min_length=3, max_length=3)]
    selected_candidate_id: UUID | None = None
    edited_comment: CommentText | None = None
    review_status: ReviewStatus
    created_at: datetime
    updated_at: datetime | None = None
    relationship_level: Literal["new", "polite", "friendly", "close"]
    speech_style: Literal["honorific", "banmal"]
    comment_length: Literal["short", "medium", "long"]
    comment_mood: Literal["calm", "warm", "lively"]
    quality_warnings: Annotated[
        list[QualityWarning], Field(max_length=3, json_schema_extra={"uniqueItems": True})
    ]
    personalization_applied: bool
    personalization_mode: Literal["off", "completed_examples"]
    personalization_sample_count: Annotated[int, Field(ge=0, le=5)]
    personalization_eligible: bool

    @classmethod
    def from_domain(cls, recommendation: Recommendation) -> Self:
        """Hide persistence-only hashes, excerpts, and optimistic-lock versions."""
        return cls(
            id=recommendation.id,
            source_url=recommendation.source_url,
            title=recommendation.title,
            summary=recommendation.summary,
            topics=list(recommendation.topics),
            candidates=[
                CommentCandidateResponse(
                    id=candidate.id,
                    tone=candidate.tone.value,
                    comment=candidate.comment,
                    referenced_detail=candidate.referenced_detail,
                )
                for candidate in recommendation.candidates
            ],
            selected_candidate_id=recommendation.selected_candidate_id,
            edited_comment=recommendation.edited_comment,
            review_status=recommendation.review_status,
            created_at=recommendation.created_at,
            updated_at=recommendation.updated_at,
            relationship_level=recommendation.preferences.relationship.value,
            speech_style=recommendation.preferences.speech.value,
            comment_length=recommendation.preferences.length.value,
            comment_mood=recommendation.preferences.mood.value,
            quality_warnings=_quality_warnings(recommendation),
            personalization_applied=(
                recommendation.personalization_mode is PersonalizationMode.COMPLETED_EXAMPLES
                and recommendation.personalization_sample_count > 0
            ),
            personalization_sample_count=recommendation.personalization_sample_count,
            personalization_mode=recommendation.personalization_mode.value,
            personalization_eligible=recommendation.personalization_eligible,
        )


class RecommendationHistoryItemResponse(StrictModel):
    id: UUID
    source_url: Annotated[
        str,
        StringConstraints(min_length=1, max_length=2048),
        Field(json_schema_extra={"format": "uri"}),
    ]
    title: ShortText
    review_status: ReviewStatus
    comment: CommentText | None
    created_at: datetime
    updated_at: datetime | None
    personalization_eligible: bool

    @classmethod
    def from_domain(cls, recommendation: Recommendation) -> Self:
        comment = recommendation.edited_comment
        if comment is None and recommendation.selected_candidate_id is not None:
            comment = next(
                candidate.comment
                for candidate in recommendation.candidates
                if candidate.id == recommendation.selected_candidate_id
            )
        return cls(
            id=recommendation.id,
            source_url=recommendation.source_url,
            title=recommendation.title,
            review_status=recommendation.review_status,
            comment=comment,
            created_at=recommendation.created_at,
            updated_at=recommendation.updated_at,
            personalization_eligible=recommendation.personalization_eligible,
        )


class RecommendationHistoryResponse(StrictModel):
    items: Annotated[list[RecommendationHistoryItemResponse], Field(max_length=50)]


DiscoveryUrl = Annotated[
    str,
    StringConstraints(min_length=1, max_length=2048),
    Field(json_schema_extra={"format": "uri"}),
]


class NeighborRequest(StrictModel):
    name: Annotated[str, StringConstraints(min_length=1, max_length=120)]
    blog_url: DiscoveryUrl
    blog_id: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    enabled: bool = True


class NeighborResponse(StrictModel):
    id: UUID
    name: Annotated[str, StringConstraints(min_length=1, max_length=120)]
    blog_url: DiscoveryUrl
    blog_id: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    enabled: bool
    feed_status: Literal["ready", "unavailable", "unknown"]
    last_checked_at: datetime | None
    created_at: datetime

    @classmethod
    def from_domain(cls, neighbor: NeighborBlog) -> Self:
        return cls(
            id=neighbor.id,
            name=neighbor.name,
            blog_url=neighbor.blog_url,
            blog_id=neighbor.blog_id,
            enabled=neighbor.enabled,
            feed_status=cast(Literal["ready", "unavailable", "unknown"], neighbor.feed_status),
            last_checked_at=neighbor.last_checked_at,
            created_at=neighbor.created_at,
        )


class NeighborListResponse(StrictModel):
    items: list[NeighborResponse]


class SavedSearchRequest(StrictModel):
    query: Annotated[str, StringConstraints(min_length=1, max_length=120)]
    excluded_terms: Annotated[
        list[Annotated[str, StringConstraints(min_length=1, max_length=60)]], Field(max_length=20)
    ] = []
    freshness_days: Annotated[int, Field(ge=1, le=90)] = 14
    enabled: bool = True


class SavedSearchResponse(StrictModel):
    id: UUID
    query: Annotated[str, StringConstraints(min_length=1, max_length=120)]
    excluded_terms: list[Annotated[str, StringConstraints(min_length=1, max_length=60)]]
    freshness_days: Annotated[int, Field(ge=1, le=90)]
    enabled: bool
    created_at: datetime

    @classmethod
    def from_domain(cls, search: SavedSearch) -> Self:
        return cls(
            id=search.id,
            query=search.query,
            excluded_terms=list(search.excluded_terms),
            freshness_days=search.freshness_days,
            enabled=search.enabled,
            created_at=search.created_at,
        )


class SavedSearchListResponse(StrictModel):
    items: list[SavedSearchResponse]


class DiscoveryPostImport(StrictModel):
    source_url: DiscoveryUrl
    title: ShortText
    publisher_name: Annotated[str, StringConstraints(min_length=1, max_length=120)] | None = None
    published_at: datetime | None = None

    def to_domain(self) -> ImportedDiscoveryPost:
        return ImportedDiscoveryPost(
            source_url=self.source_url,
            title=self.title,
            publisher_name=self.publisher_name,
            published_at=self.published_at,
        )


class DiscoveryImportRequest(StrictModel):
    source: Literal["neighbor", "search"]
    neighbor_id: UUID | None = None
    search_id: UUID | None = None
    posts: Annotated[list[DiscoveryPostImport], Field(min_length=1, max_length=50)]

    @model_validator(mode="after")
    def validate_source_owner(self) -> Self:
        if self.source == "neighbor" and (self.neighbor_id is None or self.search_id is not None):
            raise ValueError("neighbor imports require only neighbor_id")
        if self.source == "search" and (self.search_id is None or self.neighbor_id is not None):
            raise ValueError("search imports require only search_id")
        return self


class DiscoveryImportResponse(StrictModel):
    imported_count: Annotated[int, Field(ge=0, le=50)]


class DiscoveryPostResponse(StrictModel):
    id: UUID
    source: Literal["neighbor", "search"]
    state: Literal["queued", "opened", "completed", "skipped", "unavailable"]
    source_url: DiscoveryUrl
    title: ShortText
    publisher_name: Annotated[str, StringConstraints(min_length=1, max_length=120)] | None
    published_at: datetime | None
    neighbor_id: UUID | None
    search_id: UUID | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_domain(cls, post: DiscoveredPost) -> Self:
        return cls(
            id=post.id,
            source=post.source.value,
            state=post.state.value,
            source_url=post.source_url,
            title=post.title,
            publisher_name=post.publisher_name,
            published_at=post.published_at,
            neighbor_id=post.neighbor_id,
            search_id=post.search_id,
            created_at=post.created_at,
            updated_at=post.updated_at,
        )


class DiscoveryQueueResponse(StrictModel):
    items: list[DiscoveryPostResponse]


class DiscoveryPostStateRequest(StrictModel):
    state: Literal["queued", "opened", "completed", "skipped", "unavailable"]


class DigestSettingsRequest(StrictModel):
    timezone: Annotated[str, StringConstraints(min_length=1, max_length=64)] = "Asia/Seoul"
    hour: Annotated[int, Field(ge=0, le=23)] = 9
    minute: Annotated[int, Field(ge=0, le=59)] = 0
    email_enabled: bool = False

    def to_domain(self) -> DigestSettings:
        return DigestSettings(
            timezone=self.timezone,
            hour=self.hour,
            minute=self.minute,
            email_enabled=self.email_enabled,
        )


class DigestSettingsResponse(DigestSettingsRequest):
    smtp_configured: bool

    @classmethod
    def from_domain(cls, settings: DigestSettings, *, smtp_configured: bool) -> Self:
        return cls(
            timezone=settings.timezone,
            hour=settings.hour,
            minute=settings.minute,
            email_enabled=settings.email_enabled,
            smtp_configured=smtp_configured,
        )


def _quality_warnings(recommendation: Recommendation) -> list[QualityWarning]:
    warnings: list[QualityWarning] = []
    minimum, maximum = comment_length_bounds(recommendation.preferences.length)
    if any(
        not minimum <= len(candidate.comment) <= maximum for candidate in recommendation.candidates
    ):
        warnings.append("length_target_missed")

    comments_by_tone = {
        candidate.tone.value: candidate.comment for candidate in recommendation.candidates
    }
    curious = comments_by_tone["curious"]
    if (
        curious.count("?") + curious.count("？") != 1
        or any(mark in comments_by_tone["warm"] for mark in ("?", "？"))
        or any(mark in comments_by_tone["supportive"] for mark in ("?", "？"))
    ):
        warnings.append("candidate_roles_blurred")

    normalized_comments = tuple(
        _normalize_comment(candidate.comment) for candidate in recommendation.candidates
    )
    if any(
        left and right and SequenceMatcher(None, left, right).ratio() >= 0.72
        for left, right in combinations(normalized_comments, 2)
    ):
        warnings.append("candidates_too_similar")
    return warnings


def _normalize_comment(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[^\w]", "", normalized)


class ReviewRecommendationRequest(StrictModel):
    selected_candidate_id: UUID | None = None
    edited_comment: CommentText | None = None
    review_status: ReviewStatus | None = None
    personalization_eligible: bool | None = None

    @model_validator(mode="after")
    def require_one_property(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("at least one review property is required")
        if "review_status" in self.model_fields_set and self.review_status is None:
            raise ValueError("review_status must not be null")
        if (
            "personalization_eligible" in self.model_fields_set
            and self.personalization_eligible is None
        ):
            raise ValueError("personalization_eligible must not be null")
        return self


class FieldError(StrictModel):
    field: str
    message: str


class ProblemDetails(StrictModel):
    type: str
    title: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    status: Annotated[int, Field(ge=400, le=599)]
    detail: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
    code: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]*$")]
    request_id: UUID
    errors: list[FieldError] | None = None
