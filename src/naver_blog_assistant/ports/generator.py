"""Port for generating grounded comment suggestions."""

from __future__ import annotations

from typing import Protocol

from naver_blog_assistant.domain import CapturedPost, GenerationOutput, GenerationPreferences


class GenerationNotStartedError(RuntimeError):
    """Raised only when the provider guarantees that no generation request was sent."""


class CommentGenerator(Protocol):
    """Generate structured suggestions from one in-memory article."""

    def generate(self, post: CapturedPost, preferences: GenerationPreferences) -> GenerationOutput:
        """Return a summary, topics, and candidate content for ``post``."""
        ...
