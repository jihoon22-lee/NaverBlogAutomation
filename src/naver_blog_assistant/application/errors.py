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


class GenerationRateLimitedError(ApplicationError):
    """Raised when a configured generator reports temporary rate limiting."""

    def __init__(self, retry_after: int | None = None) -> None:
        super().__init__("comment generation was rate limited")
        self.retry_after = retry_after


class GenerationRefusedError(ApplicationError):
    """Raised when a provider safely refuses the requested generation."""


class GenerationUnavailableError(ApplicationError):
    """Raised when a required provider dependency is temporarily unavailable."""
