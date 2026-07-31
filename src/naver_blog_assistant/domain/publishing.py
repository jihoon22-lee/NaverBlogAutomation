"""Staging one composed draft into the Naver editor.

The step machine mirrors engagement runs: steps move forward only, a successful step is never
repeated, and a step whose result is unknown is never retried automatically. Publishing is not part
of it; the run stops at the saved draft so a person makes the irreversible choice.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID

from naver_blog_assistant.domain.models import DomainValidationError


class PublishStepName(StrEnum):
    """Editor actions in their fixed order."""

    TITLE = "title"
    BODY = "body"
    IMAGES = "images"
    TAGS = "tags"
    SAVE = "save"


class PublishStepState(StrEnum):
    """Recoverable state of one editor action."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    SKIPPED = "skipped"
    FAILED = "failed"
    UNCONFIRMED = "unconfirmed"


class PublishRunState(StrEnum):
    """Aggregate state of one staging run."""

    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    UNCONFIRMED = "unconfirmed"


PUBLISH_STEP_ORDER: tuple[PublishStepName, ...] = (
    PublishStepName.TITLE,
    PublishStepName.BODY,
    PublishStepName.IMAGES,
    PublishStepName.TAGS,
    PublishStepName.SAVE,
)
TERMINAL_STEP_STATES = frozenset(
    {
        PublishStepState.SUCCEEDED,
        PublishStepState.SKIPPED,
        PublishStepState.FAILED,
        PublishStepState.UNCONFIRMED,
    }
)


@dataclass(frozen=True, slots=True)
class PublishStep:
    """One editor action and its recorded result."""

    name: PublishStepName
    position: int
    state: PublishStepState
    result_code: str | None = None
    updated_at: datetime | None = None

    def __post_init__(self) -> None:
        if not 0 <= self.position <= 4:
            raise DomainValidationError("publish step position is invalid")
        terminal = self.state in TERMINAL_STEP_STATES
        if terminal != (self.result_code is not None):
            raise DomainValidationError("publish step result does not match its state")
        if self.updated_at is not None and self.updated_at.tzinfo is None:
            raise DomainValidationError("publish step timestamp must be timezone-aware")


@dataclass(frozen=True, slots=True)
class PublishRun:
    """One staging run for one draft revision."""

    id: UUID
    draft_id: UUID
    revision_id: UUID
    state: PublishRunState
    steps: tuple[PublishStep, ...]
    result_code: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    def __post_init__(self) -> None:
        if tuple(step.name for step in self.steps) != PUBLISH_STEP_ORDER:
            raise DomainValidationError("publish run steps do not match the documented order")
        if tuple(step.position for step in self.steps) != tuple(range(len(PUBLISH_STEP_ORDER))):
            raise DomainValidationError("publish run step positions are invalid")

    @property
    def pending_steps(self) -> tuple[PublishStepName, ...]:
        """Return the steps that still need to run, in order."""
        return tuple(step.name for step in self.steps if step.state is PublishStepState.PENDING)

    def step(self, name: PublishStepName) -> PublishStep:
        """Return one step by name."""
        for step in self.steps:
            if step.name is name:
                return step
        raise DomainValidationError(f"{name} is not part of this run")


def aggregate_state(steps: tuple[PublishStep, ...]) -> PublishRunState:
    """Derive the run state from its steps without guessing an unknown outcome."""
    states = {step.state for step in steps}
    if PublishStepState.PENDING in states or PublishStepState.RUNNING in states:
        return PublishRunState.RUNNING
    if PublishStepState.UNCONFIRMED in states:
        return PublishRunState.UNCONFIRMED
    if PublishStepState.FAILED in states:
        return PublishRunState.FAILED
    return PublishRunState.SUCCEEDED


def assert_step_transition(current: PublishStepState, following: PublishStepState) -> None:
    """Allow only forward transitions, so a recorded result is never overwritten."""
    if current in TERMINAL_STEP_STATES:
        raise DomainValidationError(f"{current.value} is terminal and cannot change")
    if current is PublishStepState.PENDING and following is PublishStepState.PENDING:
        raise DomainValidationError("a pending step cannot transition to pending")
    if following is PublishStepState.PENDING:
        raise DomainValidationError("a step cannot return to pending")
    if current is PublishStepState.RUNNING and following is PublishStepState.RUNNING:
        raise DomainValidationError("a running step cannot start again")
