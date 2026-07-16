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

    def __post_init__(self) -> None:
        has_recommendation = self.response_snapshot is not None
        if (self.outcome is IdempotencyOutcome.REPLAY) != has_recommendation:
            raise ValueError("only replay reservations carry a response snapshot")


class RecommendationRepository(Protocol):
    """Store recommendations without ever receiving the full article body."""

    def get(self, recommendation_id: UUID) -> Recommendation | None:
        """Return one recommendation or ``None`` when it does not exist."""
        ...

    def update(self, recommendation: Recommendation) -> None:
        """Persist an existing recommendation after review."""
        ...


class IdempotencyRepository(Protocol):
    """Coordinate safe retries around an otherwise expensive generation call."""

    def reserve(self, key: UUID, request_hash: str) -> IdempotencyReservation:
        """Atomically classify or start processing ``key`` and ``request_hash``."""
        ...

    def commit_generation(
        self,
        key: UUID,
        *,
        recommendation: Recommendation,
        response_snapshot: Recommendation,
    ) -> None:
        """Atomically store canonical data, complete the key, and freeze its first response.

        Implementations must commit all three effects in one transaction or commit none of them.
        ``response_snapshot`` is immutable and must not follow later canonical review updates.
        """
        ...

    def release(self, key: UUID) -> None:
        """Release a failed in-progress reservation so the request can be retried."""
        ...
