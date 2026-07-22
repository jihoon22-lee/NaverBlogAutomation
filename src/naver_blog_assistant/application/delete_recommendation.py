"""Delete one locally stored recommendation and its retry metadata."""

from __future__ import annotations

from uuid import UUID

from naver_blog_assistant.application.errors import RecommendationNotFoundError
from naver_blog_assistant.ports import RecommendationRepository


class DeleteRecommendation:
    """Remove a recommendation through the persistence boundary."""

    def __init__(self, repository: RecommendationRepository) -> None:
        self._repository = repository

    def execute(self, recommendation_id: UUID) -> None:
        if not self._repository.delete(recommendation_id):
            raise RecommendationNotFoundError(recommendation_id)
