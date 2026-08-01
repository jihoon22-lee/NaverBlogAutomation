"""One approval covering several queued posts.

A session is the unit the user approves once. It moves forward only, stops on the first blocking
condition, and never resumes on its own: an aborted or cancelled session requires a new approval.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID

from naver_blog_assistant.domain.discovery import DiscoverySource
from naver_blog_assistant.domain.engagement import EngagementStepName
from naver_blog_assistant.domain.models import DomainValidationError

MAX_SESSION_POSTS = 50
ABORT_REASONS = frozenset(
    {
        "captcha_required",
        "login_required",
        "consecutive_failures",
        "daily_cap_reached",
        "outside_allowed_hours",
        "browser_unavailable",
        "internal_error",
        "process_restarted",
    }
)


class SessionTrigger(StrEnum):
    """What started one session."""

    MANUAL = "manual"
    SESSION = "session"
    SCHEDULE = "schedule"


class SessionState(StrEnum):
    """Lifecycle of one session."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    ABORTED = "aborted"
    CANCELLED = "cancelled"


TERMINAL_SESSION_STATES = frozenset(
    {SessionState.COMPLETED, SessionState.ABORTED, SessionState.CANCELLED}
)
_ALLOWED_TRANSITIONS: dict[SessionState, frozenset[SessionState]] = {
    SessionState.PENDING: frozenset(
        {SessionState.RUNNING, SessionState.CANCELLED, SessionState.ABORTED}
    ),
    SessionState.RUNNING: frozenset(
        {SessionState.COMPLETED, SessionState.ABORTED, SessionState.CANCELLED}
    ),
    SessionState.COMPLETED: frozenset(),
    SessionState.ABORTED: frozenset(),
    SessionState.CANCELLED: frozenset(),
}


@dataclass(frozen=True, slots=True)
class AutomationSession:
    """One approved batch of queued posts."""

    id: UUID
    trigger: SessionTrigger
    state: SessionState
    approved_steps: tuple[EngagementStepName, ...]
    max_posts: int
    sources: tuple[DiscoverySource, ...]
    post_ids: tuple[UUID, ...] = ()
    processed_count: int = 0
    created_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    abort_reason: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.trigger, SessionTrigger):
            raise DomainValidationError("trigger must be a SessionTrigger")
        if not isinstance(self.state, SessionState):
            raise DomainValidationError("state must be a SessionState")
        if not self.approved_steps:
            raise DomainValidationError("a session must approve at least one step")
        if len(set(self.approved_steps)) != len(self.approved_steps):
            raise DomainValidationError("approved steps must be unique")
        if not 1 <= self.max_posts <= MAX_SESSION_POSTS:
            raise DomainValidationError(f"max_posts must be between 1 and {MAX_SESSION_POSTS}")
        if not self.sources:
            raise DomainValidationError("a session must target at least one source")
        if len(set(self.sources)) != len(self.sources):
            raise DomainValidationError("sources must be unique")
        if len(self.post_ids) > self.max_posts:
            raise DomainValidationError("session snapshot cannot exceed max_posts")
        if len(set(self.post_ids)) != len(self.post_ids):
            raise DomainValidationError("session snapshot post ids must be unique")
        if self.processed_count < 0:
            raise DomainValidationError("processed_count must not be negative")
        if self.abort_reason is not None and self.abort_reason not in ABORT_REASONS:
            raise DomainValidationError(f"{self.abort_reason} is not a known abort reason")
        if self.abort_reason is not None and self.state is not SessionState.ABORTED:
            raise DomainValidationError("only an aborted session carries an abort reason")

    @property
    def finished(self) -> bool:
        """Report whether the session reached a terminal state."""
        return self.state in TERMINAL_SESSION_STATES

    @property
    def remaining(self) -> int:
        """Return how many more posts this session may process."""
        return max(self.max_posts - self.processed_count, 0)


def assert_batch_transition(current: SessionState, following: SessionState) -> None:
    """Allow only the documented forward transitions."""
    if following not in _ALLOWED_TRANSITIONS[current]:
        raise DomainValidationError(f"{current.value} cannot transition to {following.value}")


def approved_steps_for(source: DiscoverySource) -> tuple[EngagementStepName, ...]:
    """Return the steps a session approves for one discovery source."""
    common = (EngagementStepName.LIKE, EngagementStepName.COMMENT)
    return (
        common
        if source is DiscoverySource.NEIGHBOR
        else (*common, EngagementStepName.MUTUAL_NEIGHBOR)
    )
