"""Port for generating grounded comment suggestions."""

from __future__ import annotations

from typing import Protocol

from naver_blog_assistant.domain import CapturedPost, GenerationOutput


class CommentGenerator(Protocol):
    """Generate structured suggestions from one in-memory article."""

    def generate(self, post: CapturedPost) -> GenerationOutput:
        """Return a summary, topics, and candidate content for ``post``."""
        ...
