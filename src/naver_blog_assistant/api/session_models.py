"""Transport models for session batches."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from naver_blog_assistant.domain.sessions import MAX_SESSION_POSTS, AutomationSession

StepName = Literal["like", "comment", "mutual_neighbor"]
SourceName = Literal["neighbor", "search"]


class StrictSessionModel(BaseModel):
    """Reject unknown fields so a client cannot smuggle values past validation."""

    model_config = ConfigDict(extra="forbid")


class SessionApprovalRequest(StrictSessionModel):
    """One approval covering several queued posts."""

    approved_steps: Annotated[list[StepName], Field(min_length=1, max_length=3)]
    sources: Annotated[list[SourceName], Field(min_length=1, max_length=2)]
    max_posts: Annotated[int, Field(ge=1, le=MAX_SESSION_POSTS)]

    @model_validator(mode="after")
    def validate_unique(self) -> Self:
        if len(set(self.approved_steps)) != len(self.approved_steps):
            raise ValueError("each step may appear at most once")
        if len(set(self.sources)) != len(self.sources):
            raise ValueError("each source may appear at most once")
        return self


class SessionResponse(StrictSessionModel):
    """One persisted session batch."""

    id: UUID
    trigger: Literal["manual", "session", "schedule"]
    state: Literal["pending", "running", "completed", "aborted", "cancelled"]
    approved_steps: list[str]
    sources: list[str]
    max_posts: Annotated[int, Field(ge=1)]
    processed_count: Annotated[int, Field(ge=0)]
    abort_reason: str | None
    created_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None

    @classmethod
    def from_domain(cls, session: AutomationSession) -> Self:
        return cls(
            id=session.id,
            trigger=session.trigger.value,
            state=session.state.value,
            approved_steps=[step.value for step in session.approved_steps],
            sources=[source.value for source in session.sources],
            max_posts=session.max_posts,
            processed_count=session.processed_count,
            abort_reason=session.abort_reason,
            created_at=session.created_at,
            started_at=session.started_at,
            finished_at=session.finished_at,
        )


class SessionListResponse(StrictSessionModel):
    """The newest sessions, newest first."""

    items: list[SessionResponse]

    @classmethod
    def from_domain(cls, sessions: tuple[AutomationSession, ...]) -> Self:
        return cls(items=[SessionResponse.from_domain(session) for session in sessions])


class ScheduleStatusResponse(StrictSessionModel):
    """Whether unattended mode can run, and what blocks it."""

    mode: Literal["manual", "session", "schedule"]
    hour: Annotated[int, Field(ge=0, le=23)]
    minute: Annotated[int, Field(ge=0, le=59)]
    max_posts: Annotated[int, Field(ge=1)]
    enabled: bool
    blocking_reason: str | None
