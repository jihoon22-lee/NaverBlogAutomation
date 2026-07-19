"""Pydantic transport models matching the checked-in OpenAPI contract."""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from difflib import SequenceMatcher
from itertools import combinations
from typing import Annotated, Literal, Self
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
    GenerationPreferences,
    Recommendation,
    Relationship,
    ReviewStatus,
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

    @model_validator(mode="after")
    def require_one_property(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("at least one review property is required")
        if "review_status" in self.model_fields_set and self.review_status is None:
            raise ValueError("review_status must not be null")
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
