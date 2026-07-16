"""Application ports for external generation and persistence adapters."""

from naver_blog_assistant.ports.generator import CommentGenerator
from naver_blog_assistant.ports.repositories import (
    IdempotencyOutcome,
    IdempotencyRepository,
    IdempotencyReservation,
    RecommendationRepository,
)

__all__ = [
    "CommentGenerator",
    "IdempotencyOutcome",
    "IdempotencyRepository",
    "IdempotencyReservation",
    "RecommendationRepository",
]
