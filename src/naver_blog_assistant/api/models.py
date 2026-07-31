"""Pydantic transport models matching the checked-in OpenAPI contract."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from datetime import datetime
from difflib import SequenceMatcher
from itertools import combinations
from typing import Annotated, Any, Literal, Self, cast
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
    AppSetting,
    ArticleExtraction,
    AutoDiscoverySettings,
    BrowserSessionStatus,
    CommentLength,
    CommentMood,
    DigestSettings,
    DiscoveredPost,
    EngagementRun,
    EngagementStepState,
    GenerationPreferences,
    ImportedDiscoveryPost,
    NeighborBlog,
    PersonalizationMode,
    ProviderAvailability,
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
    publisher_blog_id: Annotated[str, StringConstraints(min_length=1, max_length=100)] | None = None
    published_at: datetime | None = None

    def to_domain(self) -> ImportedDiscoveryPost:
        return ImportedDiscoveryPost(
            source_url=self.source_url,
            title=self.title,
            publisher_name=self.publisher_name,
            publisher_blog_id=self.publisher_blog_id,
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
    publisher_blog_id: Annotated[str, StringConstraints(min_length=1, max_length=100)] | None
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
            publisher_blog_id=post.publisher_blog_id,
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


class EngagementRunStartRequest(StrictModel):
    approval_id: UUID
    discovery_post_id: UUID
    recommendation_id: UUID


class ManualEngagementCompletionRequest(StrictModel):
    completed_steps: Annotated[
        list[Literal["like", "comment", "mutual_neighbor"]], Field(min_length=1, max_length=3)
    ]

    @model_validator(mode="after")
    def validate_completed_steps(self) -> Self:
        if len(set(self.completed_steps)) != len(self.completed_steps):
            raise ValueError("completed_steps must not contain duplicates")
        return self


class EngagementStepTransitionRequest(StrictModel):
    state: Literal["running", "succeeded", "skipped", "failed", "unconfirmed"]
    result_code: Annotated[
        str | None,
        StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,63}$"),
    ] = None

    @model_validator(mode="after")
    def validate_result(self) -> Self:
        terminal = self.state in {"succeeded", "skipped", "failed", "unconfirmed"}
        if terminal != (self.result_code is not None):
            raise ValueError("terminal engagement state requires one result_code")
        return self

    def to_state(self) -> EngagementStepState:
        return EngagementStepState(self.state)


class EngagementStepResponse(StrictModel):
    name: Literal["like", "comment", "mutual_neighbor"]
    position: Annotated[int, Field(ge=0, le=2)]
    state: Literal["pending", "running", "succeeded", "skipped", "failed", "unconfirmed"]
    result_code: Annotated[
        str | None,
        StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,63}$"),
    ]
    updated_at: datetime


class EngagementRunResponse(StrictModel):
    id: UUID
    approval_id: UUID
    discovery_post_id: UUID
    recommendation_id: UUID
    source: Literal["neighbor", "search"]
    state: Literal["running", "succeeded", "failed", "unconfirmed"]
    steps: Annotated[list[EngagementStepResponse], Field(min_length=2, max_length=3)]
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_domain(cls, run: EngagementRun) -> Self:
        return cls(
            id=run.id,
            approval_id=run.approval_id,
            discovery_post_id=run.discovery_post_id,
            recommendation_id=run.recommendation_id,
            source=run.source.value,
            state=run.state.value,
            steps=[
                EngagementStepResponse(
                    name=step.name.value,
                    position=step.position,
                    state=step.state.value,
                    result_code=step.result_code,
                    updated_at=step.updated_at,
                )
                for step in run.steps
            ],
            created_at=run.created_at,
            updated_at=run.updated_at,
        )


class EngagementRunListResponse(StrictModel):
    items: Annotated[list[EngagementRunResponse], Field(max_length=50)]


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


class AutomaticDiscoverySettingsRequest(StrictModel):
    own_blog_id: Annotated[str, StringConstraints(max_length=100)] = ""
    enabled: bool = False
    timezone: Annotated[str, StringConstraints(min_length=1, max_length=64)] = "Asia/Seoul"
    hour: Annotated[int, Field(ge=0, le=23)] = 9
    minute: Annotated[int, Field(ge=0, le=59)] = 0

    def to_domain(self, *, previous: AutoDiscoverySettings | None = None) -> AutoDiscoverySettings:
        return AutoDiscoverySettings(
            own_blog_id=self.own_blog_id.strip(),
            enabled=self.enabled,
            timezone=self.timezone,
            hour=self.hour,
            minute=self.minute,
            last_synced_at=None if previous is None else previous.last_synced_at,
            last_status="never" if previous is None else previous.last_status,
            last_detail="" if previous is None else previous.last_detail,
        )


class AutomaticDiscoverySettingsResponse(AutomaticDiscoverySettingsRequest):
    last_synced_at: datetime | None
    last_status: Literal["never", "success", "partial", "failed"]
    last_detail: str

    @classmethod
    def from_domain(cls, settings: AutoDiscoverySettings) -> Self:
        return cls(
            own_blog_id=settings.own_blog_id,
            enabled=settings.enabled,
            timezone=settings.timezone,
            hour=settings.hour,
            minute=settings.minute,
            last_synced_at=settings.last_synced_at,
            last_status=cast(
                Literal["never", "success", "partial", "failed"], settings.last_status
            ),
            last_detail=settings.last_detail,
        )


class AutomaticDiscoverySyncResponse(StrictModel):
    # A saved search is capped independently, but one sync aggregates every
    # enabled search and can therefore legitimately exceed 50.
    neighbors_added: Annotated[int, Field(ge=0)]
    neighbor_posts_added: Annotated[int, Field(ge=0)]
    search_posts_added: Annotated[int, Field(ge=0)]
    search_provider: Literal["naver_open_api", "none"]
    status: Literal["success", "partial", "failed"]
    detail: str


class DiscoverySearchRefreshResponse(StrictModel):
    imported_count: Annotated[int, Field(ge=0, le=50)]
    provider: Literal["naver_open_api"]
    detail: str


class AppSettingRequest(StrictModel):
    """One settings payload; the service validates it per kind."""

    payload: dict[str, Any]


class AppSettingResponse(StrictModel):
    """Stored settings record with its schema version."""

    kind: Literal[
        "generation_profile",
        "closing_phrase",
        "neighbor_message",
        "automation_consent",
        "safety_policy",
        "schedule_policy",
        "browser_profile",
        "llm_providers",
        "llm_budget",
    ]
    schema_version: Annotated[int, Field(ge=1)]
    payload: dict[str, Any]
    updated_at: datetime | None

    @classmethod
    def from_domain(cls, setting: AppSetting) -> Self:
        return cls(
            kind=setting.kind.value,
            schema_version=setting.schema_version,
            payload=setting.payload,
            updated_at=setting.updated_at,
        )


class AutomationRunRequest(StrictModel):
    """One explicit approval to run the reviewed actions for a queued post."""

    discovery_post_id: UUID
    recommendation_id: UUID


class LlmProviderResponse(StrictModel):
    """One provider and whether this process can call it. Never includes credentials."""

    provider: Literal["openai", "gemini", "anthropic"]
    configured: bool
    model: str


class LlmProvidersResponse(StrictModel):
    """Every known provider in declaration order."""

    items: list[LlmProviderResponse]

    @classmethod
    def from_domain(cls, availability: Sequence[ProviderAvailability]) -> Self:
        return cls(
            items=[
                LlmProviderResponse(
                    provider=entry.provider.value,
                    configured=entry.configured,
                    model=entry.model,
                )
                for entry in availability
            ]
        )


class CommentGenerationRequest(StrictModel):
    """Generate candidates for one supported post using the saved profile."""

    url: Annotated[str, StringConstraints(min_length=1, max_length=2048)]
    relationship_level: Relationship | None = None
    speech_style: SpeechStyle | None = None
    comment_length: CommentLength | None = None
    comment_mood: CommentMood | None = None
    personalization_mode: PersonalizationMode | None = None
    replace: bool = False


class CommentGenerationResponse(StrictModel):
    """The stored recommendation plus the capture it was generated from."""

    attempt: Annotated[int, Field(ge=1)]
    extraction: ArticleExtractionResponse
    recommendation: RecommendationResponse
    replayed: bool


class ArticleExtractionRequest(StrictModel):
    """One explicitly requested article capture."""

    url: Annotated[str, StringConstraints(min_length=1, max_length=2048)]


class ArticleExtractionResponse(StrictModel):
    """Bounded capture returned for human review; the full body stays in memory."""

    source_url: Annotated[str, StringConstraints(min_length=1, max_length=2048)]
    title: ShortText
    selector_kind: Literal["modern", "legacy", "semantic"]
    original_length: Annotated[int, Field(ge=0)]
    transmitted_length: Annotated[int, Field(ge=0)]
    truncated: bool
    preview: Annotated[str, StringConstraints(max_length=1200)]

    @classmethod
    def from_domain(cls, extraction: ArticleExtraction) -> Self:
        return cls(
            source_url=extraction.source_url,
            title=extraction.title,
            selector_kind=cast(Literal["modern", "legacy", "semantic"], extraction.selector_kind),
            original_length=extraction.original_length,
            transmitted_length=extraction.transmitted_length,
            truncated=extraction.truncated,
            preview=extraction.preview,
        )


class BrowserSessionResponse(StrictModel):
    """Redacted automation session snapshot; never includes cookies or page content."""

    state: Literal["stopped", "launching", "ready", "closing"]
    login: Literal["unknown", "anonymous", "authenticated"]
    driver: Annotated[str, StringConstraints(min_length=1, max_length=32)]
    headless: bool
    profile_dir: Annotated[str, StringConstraints(min_length=1, max_length=1024)]
    open_pages: Annotated[int, Field(ge=0)]
    detail: str | None = None

    @classmethod
    def from_domain(cls, status: BrowserSessionStatus) -> Self:
        return cls(
            state=status.state.value,
            login=status.login.value,
            driver=status.driver,
            headless=status.headless,
            profile_dir=status.profile_dir,
            open_pages=status.open_pages,
            detail=status.detail,
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
