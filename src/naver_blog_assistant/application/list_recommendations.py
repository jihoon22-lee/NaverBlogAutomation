"""List recent recommendation history without exposing captured article bodies."""

from __future__ import annotations

from naver_blog_assistant.domain import Recommendation
from naver_blog_assistant.ports import RecommendationRepository


class ListRecommendations:
    """Return a bounded, newest-first view of locally stored recommendations."""

    def __init__(self, repository: RecommendationRepository) -> None:
        self._repository = repository

    def execute(self, *, limit: int) -> tuple[Recommendation, ...]:
        if not 1 <= limit <= 50:
            raise ValueError("history limit must be between 1 and 50")
        return self._repository.list_recent(limit)
