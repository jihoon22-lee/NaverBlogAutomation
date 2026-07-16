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
    CONFLICT = "conflict"
    IN_PROGRESS = "in_progress"


@dataclass(frozen=True, slots=True)
class IdempotencyReservation:
    """Outcome and optional immutable first-response snapshot for a reservation."""

    outcome: IdempotencyOutcome
    response_snapshot: Recommendation | None = None
    attempt_id: UUID | None = None

    def __post_init__(self) -> None:
        if self.outcome is IdempotencyOutcome.REPLAY:
            if self.response_snapshot is None or self.attempt_id is not None:
                raise ValueError("replay reservations require only a response snapshot")
        elif self.outcome is IdempotencyOutcome.STARTED:
            if self.response_snapshot is not None or self.attempt_id is None:
                raise ValueError("started reservations require only an attempt id")
        elif self.response_snapshot is not None or self.attempt_id is not None:
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
