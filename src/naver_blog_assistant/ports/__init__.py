"""Application ports for external generation and persistence adapters."""

from naver_blog_assistant.ports.generator import CommentGenerator, GenerationNotStartedError
from naver_blog_assistant.ports.repositories import (
    GenerationFailureSnapshot,
    IdempotencyOutcome,
    IdempotencyRepository,
    IdempotencyReservation,
    RecommendationRepository,
    RecommendationVersionConflictError,
)

__all__ = [
    "CommentGenerator",
    "GenerationNotStartedError",
    "GenerationFailureSnapshot",
    "IdempotencyOutcome",
    "IdempotencyRepository",
    "IdempotencyReservation",
    "RecommendationRepository",
    "RecommendationVersionConflictError",
]
