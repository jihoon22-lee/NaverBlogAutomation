"""Application ports for external generation and persistence adapters."""

from naver_blog_assistant.ports.generator import CommentGenerator, GenerationNotStartedError
from naver_blog_assistant.ports.repositories import (
    IdempotencyOutcome,
    IdempotencyRepository,
    IdempotencyReservation,
    RecommendationRepository,
    RecommendationVersionConflictError,
)

__all__ = [
    "CommentGenerator",
    "GenerationNotStartedError",
    "IdempotencyOutcome",
    "IdempotencyRepository",
    "IdempotencyReservation",
    "RecommendationRepository",
    "RecommendationVersionConflictError",
]
