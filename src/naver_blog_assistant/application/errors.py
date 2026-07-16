"""Stable application errors independent of transport and provider details."""

from __future__ import annotations

from uuid import UUID


class ApplicationError(RuntimeError):
    """Base class for use-case failures handled by an outer adapter."""


class RecommendationNotFoundError(ApplicationError):
    """Raised when a requested recommendation does not exist."""

    def __init__(self, recommendation_id: UUID) -> None:
        super().__init__(f"recommendation {recommendation_id} was not found")
        self.recommendation_id = recommendation_id


class IdempotencyConflictError(ApplicationError):
    """Raised when an idempotency key is reused for different content."""


class GenerationInProgressError(ApplicationError):
    """Raised when another request is already generating with the same key."""


class ConcurrentReviewError(ApplicationError):
    """Raised when a review was based on an outdated recommendation version."""
