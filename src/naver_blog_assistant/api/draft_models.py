"""Transport models for post drafts."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from naver_blog_assistant.domain.writing import (
    MAX_BLOCKS,
    MAX_DRAFT_TITLE_LENGTH,
    MAX_SEED_LENGTH,
    MAX_TAGS,
    DraftImage,
    DraftRevision,
    DraftTag,
    PostDraft,
    body_payload,
)


class StrictDraftModel(BaseModel):
    """Reject unknown fields so a client cannot smuggle values past validation."""

    model_config = ConfigDict(extra="forbid")


class DraftCreateRequest(StrictDraftModel):
    """Register one draft with the text the user wrote."""

    title: Annotated[str, StringConstraints(min_length=1, max_length=MAX_DRAFT_TITLE_LENGTH)]
    seed_text: Annotated[str, StringConstraints(min_length=1, max_length=MAX_SEED_LENGTH)]
    category_no: Annotated[int | None, Field(ge=0)] = None
    use_image_vision: bool = False


class DraftPatchRequest(StrictDraftModel):
    """Change the draft fields the user may edit."""

    title: Annotated[
        str | None, StringConstraints(min_length=1, max_length=MAX_DRAFT_TITLE_LENGTH)
    ] = None
    category_no: Annotated[int | None, Field(ge=0)] = None
    use_image_vision: bool | None = None
    active_revision_id: UUID | None = None

    @model_validator(mode="after")
    def validate_any_change(self) -> Self:
        if all(
            value is None
            for value in (
                self.title,
                self.category_no,
                self.use_image_vision,
                self.active_revision_id,
            )
        ):
            raise ValueError("at least one field must change")
        return self


class DraftGenerationRequest(StrictDraftModel):
    """Ask one provider to compose, refine, or tag the draft."""

    provider: Literal["openai", "gemini", "anthropic"]
    model: Annotated[str | None, StringConstraints(min_length=1, max_length=100)] = None
    length: Literal["short", "medium", "long"] = "medium"
    tone: Literal["calm", "warm", "lively"] = "warm"
    structure: Literal["plain", "sectioned", "story"] = "sectioned"
    reference_limit: Annotated[int, Field(ge=0, le=10)] = 5
    request: Annotated[str, StringConstraints(max_length=2_000)] = ""


class DraftTagPatchRequest(StrictDraftModel):
    """Replace the tag selection or add tags the user typed."""

    selected: Annotated[list[str] | None, Field(max_length=MAX_TAGS)] = None
    added: Annotated[list[str] | None, Field(max_length=MAX_TAGS)] = None

    @model_validator(mode="after")
    def validate_any_change(self) -> Self:
        if self.selected is None and self.added is None:
            raise ValueError("selected or added must be present")
        return self


class DraftImageResponse(StrictDraftModel):
    """One uploaded image, without its bytes."""

    id: UUID
    ordinal: Annotated[int, Field(ge=0)]
    original_filename: str
    byte_size: Annotated[int, Field(gt=0)]
    mime: str
    alt_text: str

    @classmethod
    def from_domain(cls, image: DraftImage) -> Self:
        return cls(
            id=image.id,
            ordinal=image.ordinal,
            original_filename=image.original_filename,
            byte_size=image.byte_size,
            mime=image.mime,
            alt_text=image.alt_text,
        )


class DraftRevisionResponse(StrictDraftModel):
    """One stored body version."""

    id: UUID
    round_no: Annotated[int, Field(ge=0)]
    kind: Literal["seed", "composed", "refined", "user_edited"]
    provider: str | None
    model: str | None
    title: str
    summary: str
    is_active: bool
    blocks: Annotated[list[dict[str, Any]], Field(max_length=MAX_BLOCKS)]
    created_at: datetime | None

    @classmethod
    def from_domain(cls, revision: DraftRevision) -> Self:
        return cls(
            id=revision.id,
            round_no=revision.round_no,
            kind=revision.kind.value,
            provider=revision.provider,
            model=revision.model,
            title=revision.title,
            summary=revision.summary,
            is_active=revision.is_active,
            blocks=body_payload(revision.blocks),
            created_at=revision.created_at,
        )


class DraftTagResponse(StrictDraftModel):
    """One tag attached to a draft."""

    tag: str
    ordinal: Annotated[int, Field(ge=0)]
    source: Literal["generated", "user"]
    selected: bool

    @classmethod
    def from_domain(cls, tag: DraftTag) -> Self:
        return cls(tag=tag.tag, ordinal=tag.ordinal, source=tag.source.value, selected=tag.selected)


class DraftResponse(StrictDraftModel):
    """One whole draft."""

    id: UUID
    title: str
    category_no: int | None
    status: Literal[
        "collecting", "composed", "refining", "tagged", "staging", "staged", "abandoned"
    ]
    use_image_vision: bool
    seed_text: str
    revisions: list[DraftRevisionResponse]
    images: list[DraftImageResponse]
    tags: list[DraftTagResponse]
    created_at: datetime | None
    updated_at: datetime | None

    @classmethod
    def from_domain(cls, draft: PostDraft) -> Self:
        return cls(
            id=draft.id,
            title=draft.title,
            category_no=draft.category_no,
            status=draft.status.value,
            use_image_vision=draft.use_image_vision,
            seed_text=draft.seed_text,
            revisions=[DraftRevisionResponse.from_domain(revision) for revision in draft.revisions],
            images=[DraftImageResponse.from_domain(image) for image in draft.images],
            tags=[DraftTagResponse.from_domain(tag) for tag in draft.tags],
            created_at=draft.created_at,
            updated_at=draft.updated_at,
        )


class DraftListResponse(StrictDraftModel):
    """The newest drafts, newest first."""

    items: list[DraftResponse]

    @classmethod
    def from_domain(cls, drafts: tuple[PostDraft, ...]) -> Self:
        return cls(items=[DraftResponse.from_domain(draft) for draft in drafts])
