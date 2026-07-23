"""Persistence ports used by recommendation use cases."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol
from uuid import UUID

from naver_blog_assistant.domain import Recommendation


class IdempotencyOutcome(StrEnum):
    """Result of atomically reserving an idempotency key."""

    STARTED = "started"
    REPLAY = "replay"
    FAILURE_REPLAY = "failure_replay"
    CONFLICT = "conflict"
    IN_PROGRESS = "in_progress"


@dataclass(frozen=True, slots=True)
class GenerationFailureSnapshot:
    """Safe, provider-independent problem details stored for deterministic replay."""

    status: int
    code: str
    title: str
    detail: str

    def __post_init__(self) -> None:
        if not 400 <= self.status <= 599:
            raise ValueError("failure status must be an HTTP error status")
        if not self.code or not self.title or not self.detail:
            raise ValueError("failure snapshot fields must not be empty")


@dataclass(frozen=True, slots=True)
class IdempotencyReservation:
    """Outcome and optional immutable first-response snapshot for a reservation."""

    outcome: IdempotencyOutcome
    response_snapshot: Recommendation | None = None
    attempt_id: UUID | None = None
    failure_snapshot: GenerationFailureSnapshot | None = None

    def __post_init__(self) -> None:
        if self.outcome is IdempotencyOutcome.REPLAY:
            if (
                self.response_snapshot is None
                or self.attempt_id is not None
                or self.failure_snapshot is not None
            ):
                raise ValueError("replay reservations require only a response snapshot")
        elif self.outcome is IdempotencyOutcome.FAILURE_REPLAY:
            if (
                self.failure_snapshot is None
                or self.response_snapshot is not None
                or self.attempt_id is not None
            ):
                raise ValueError("failure replays require only a failure snapshot")
        elif self.outcome is IdempotencyOutcome.STARTED:
            if (
                self.response_snapshot is not None
                or self.failure_snapshot is not None
                or self.attempt_id is None
            ):
                raise ValueError("started reservations require only an attempt id")
        elif (
            self.response_snapshot is not None
            or self.failure_snapshot is not None
            or self.attempt_id is not None
        ):
            raise ValueError("conflict and in-progress reservations carry no payload")


class RecommendationVersionConflictError(RuntimeError):
    """Raised when a stale review attempts to overwrite newer canonical state."""


class RecommendationRepository(Protocol):
    """Store recommendations without ever receiving the full article body."""

    def get(self, recommendation_id: UUID) -> Recommendation | None:
        """Return one recommendation or ``None`` when it does not exist."""
        ...

    def update(self, recommendation: Recommendation) -> Recommendation:
        """Persist a review with compare-and-swap and return its incremented version."""
        ...

    def list_recent(self, limit: int) -> tuple[Recommendation, ...]:
        """Return recent recommendations in descending activity order."""
        ...

    def delete(self, recommendation_id: UUID) -> bool:
        """Delete one recommendation and retry metadata, returning whether it existed."""
        ...


class PersonalizationRepository(Protocol):
    """Read and update the local completed-comment style sample set."""

    def list_personalization_examples(self, limit: int) -> tuple[str, ...]:
        """Return newest eligible completed comments without article content."""
        ...

    def clear_personalization_examples(self) -> int:
        """Exclude every completed comment from future personalization."""
        ...


class IdempotencyRepository(Protocol):
    """Coordinate safe retries around an otherwise expensive generation call."""

    def reserve(self, key: UUID, request_hash: str) -> IdempotencyReservation:
        """Atomically classify or start processing ``key`` and ``request_hash``."""
        ...

    def mark_generation_started(self, key: UUID, attempt_id: UUID) -> None:
        """Mark the point after which a crashed request may have called the provider."""
        ...

    def commit_generation(
        self,
        key: UUID,
        attempt_id: UUID,
        *,
        recommendation: Recommendation,
    ) -> None:
        """Atomically store canonical data, complete the key, and freeze its first response.

        Implementations must commit all three effects in one transaction or commit none of them.
        The immutable snapshot must be serialized from ``recommendation`` itself so canonical
        data and the first response cannot diverge.
        """
        ...

    def release(self, key: UUID, attempt_id: UUID) -> None:
        """Release a failed in-progress reservation so the request can be retried."""
        ...

    def commit_failure(
        self,
        key: UUID,
        attempt_id: UUID,
        *,
        failure: GenerationFailureSnapshot,
        indeterminate: bool = False,
    ) -> None:
        """Fence and persist a safe terminal or indeterminate failure snapshot."""
        ...
