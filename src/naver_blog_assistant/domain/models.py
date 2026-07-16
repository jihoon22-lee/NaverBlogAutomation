"""Validated domain models shared across application boundaries."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field, HttpUrl


class DraftStatus(StrEnum):
    """Human-review lifecycle for a generated comment draft."""

    DRAFTED = "drafted"
    APPROVED = "approved"
    COMPLETED = "completed"


class CommentDraft(BaseModel):
    """A validated AI-generated comment awaiting human review."""

    post_url: HttpUrl
    comment: str = Field(min_length=1, max_length=500)
    status: DraftStatus = DraftStatus.DRAFTED
