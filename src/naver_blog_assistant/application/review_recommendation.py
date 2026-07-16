"""Apply a human-review decision to one recommendation."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from uuid import UUID

from naver_blog_assistant.application.errors import RecommendationNotFoundError
from naver_blog_assistant.domain import Recommendation, ReviewPatch
from naver_blog_assistant.ports import RecommendationRepository


class ReviewRecommendation:
    """Validate and persist a forward-only review update."""

    def __init__(
        self,
        recommendations: RecommendationRepository,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._recommendations = recommendations
        self._clock = clock or (lambda: datetime.now(UTC))

    def execute(self, recommendation_id: UUID, patch: ReviewPatch) -> Recommendation:
        """Apply ``patch`` and persist the resulting recommendation."""
        recommendation = self._recommendations.get(recommendation_id)
        if recommendation is None:
            raise RecommendationNotFoundError(recommendation_id)
        updated = recommendation.apply_review(patch, reviewed_at=self._clock())
        self._recommendations.update(updated)
        return updated
