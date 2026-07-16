"""Retrieve one persisted recommendation."""

from __future__ import annotations

from uuid import UUID

from naver_blog_assistant.application.errors import RecommendationNotFoundError
from naver_blog_assistant.domain import Recommendation
from naver_blog_assistant.ports import RecommendationRepository


class GetRecommendation:
    """Return a recommendation without access to its original article body."""

    def __init__(self, recommendations: RecommendationRepository) -> None:
        self._recommendations = recommendations

    def execute(self, recommendation_id: UUID) -> Recommendation:
        """Return one recommendation or raise a stable application error."""
        recommendation = self._recommendations.get(recommendation_id)
        if recommendation is None:
            raise RecommendationNotFoundError(recommendation_id)
        return recommendation
