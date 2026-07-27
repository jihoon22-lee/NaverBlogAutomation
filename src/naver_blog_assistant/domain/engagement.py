"""Persisted state for one explicitly approved browser engagement run."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID

from naver_blog_assistant.domain.discovery import DiscoverySource
from naver_blog_assistant.domain.models import DomainValidationError

_RESULT_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class EngagementStepName(StrEnum):
    """External browser actions in their fixed execution order."""

    LIKE = "like"
    COMMENT = "comment"
    MUTUAL_NEIGHBOR = "mutual_neighbor"


class EngagementStepState(StrEnum):
    """Recoverable state of one external action."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    SKIPPED = "skipped"
    FAILED = "failed"
    UNCONFIRMED = "unconfirmed"


class EngagementRunState(StrEnum):
    """Aggregate state shown consistently in the current task and history."""

    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    UNCONFIRMED = "unconfirmed"


@dataclass(frozen=True, slots=True)
class EngagementStep:
    name: EngagementStepName
    position: int
    state: EngagementStepState
    result_code: str | None
    updated_at: datetime

    def __post_init__(self) -> None:
        if not 0 <= self.position <= 2:
            raise DomainValidationError("engagement step position is invalid")
        if self.updated_at.tzinfo is None:
            raise DomainValidationError("engagement step timestamp must be timezone-aware")
        terminal = self.state in {
            EngagementStepState.SUCCEEDED,
            EngagementStepState.SKIPPED,
            EngagementStepState.FAILED,
            EngagementStepState.UNCONFIRMED,
        }
        if terminal != (self.result_code is not None):
            raise DomainValidationError("engagement step result does not match its state")
        if self.result_code is not None and _RESULT_CODE.fullmatch(self.result_code) is None:
            raise DomainValidationError("engagement result code is invalid")


@dataclass(frozen=True, slots=True)
class EngagementRun:
    id: UUID
    approval_id: UUID
    discovery_post_id: UUID
    recommendation_id: UUID
    source: DiscoverySource
    state: EngagementRunState
    steps: tuple[EngagementStep, ...]
    created_at: datetime
    updated_at: datetime

    def __post_init__(self) -> None:
        if self.created_at.tzinfo is None or self.updated_at.tzinfo is None:
            raise DomainValidationError("engagement run timestamps must be timezone-aware")
        expected = required_engagement_steps(self.source)
        if tuple(step.name for step in self.steps) != expected:
            raise DomainValidationError("engagement run steps do not match its discovery source")
        if tuple(step.position for step in self.steps) != tuple(range(len(expected))):
            raise DomainValidationError("engagement run step positions are invalid")


def required_engagement_steps(source: DiscoverySource) -> tuple[EngagementStepName, ...]:
    """Return the immutable action sequence for a discovery source."""
    common = (EngagementStepName.LIKE, EngagementStepName.COMMENT)
    return (
        common
        if source is DiscoverySource.NEIGHBOR
        else (*common, EngagementStepName.MUTUAL_NEIGHBOR)
    )
