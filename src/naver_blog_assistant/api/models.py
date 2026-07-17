"""Pydantic transport models matching the checked-in OpenAPI contract."""

from __future__ import annotations

import re
from datetime import datetime
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

from naver_blog_assistant.domain import Recommendation, ReviewStatus

ShortText = Annotated[str, StringConstraints(min_length=1, max_length=300)]
CommentText = Annotated[str, StringConstraints(min_length=1, max_length=500)]
TopicText = Annotated[str, StringConstraints(min_length=1, max_length=80)]


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

    @field_validator("source_url", "title", "body", mode="before")
    @classmethod
    def normalize_whitespace(cls, value: object) -> object:
        """Normalize browser-extracted whitespace before validation and hashing."""
        if isinstance(value, str):
            return re.sub(r"\s+", " ", value).strip()
        return value


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
        )


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
