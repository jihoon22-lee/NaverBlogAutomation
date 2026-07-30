"""Application ports for external generation and persistence adapters."""

from naver_blog_assistant.ports.browser import (
    BrowserContextHandle,
    BrowserDriver,
    BrowserLaunchError,
    BrowserOperationError,
    FrameHandle,
    PageHandle,
)
from naver_blog_assistant.ports.generator import CommentGenerator, GenerationNotStartedError
from naver_blog_assistant.ports.repositories import (
    GenerationFailureSnapshot,
    IdempotencyOutcome,
    IdempotencyRepository,
    IdempotencyReservation,
    PersonalizationRepository,
    RecommendationRepository,
    RecommendationVersionConflictError,
)

__all__ = [
    "BrowserContextHandle",
    "BrowserDriver",
    "BrowserLaunchError",
    "BrowserOperationError",
    "CommentGenerator",
    "FrameHandle",
    "GenerationNotStartedError",
    "GenerationFailureSnapshot",
    "IdempotencyOutcome",
    "IdempotencyRepository",
    "IdempotencyReservation",
    "PageHandle",
    "PersonalizationRepository",
    "RecommendationRepository",
    "RecommendationVersionConflictError",
]
