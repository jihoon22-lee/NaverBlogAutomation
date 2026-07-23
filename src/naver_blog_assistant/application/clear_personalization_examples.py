"""Exclude retained completed comments from future personalization."""

from __future__ import annotations

from naver_blog_assistant.ports import PersonalizationRepository


class ClearPersonalizationExamples:
    """Preserve history while removing its eligibility as provider style examples."""

    def __init__(self, recommendations: PersonalizationRepository) -> None:
        self._recommendations = recommendations

    def execute(self) -> int:
        """Return the number of completed comments excluded from future generation."""
        return self._recommendations.clear_personalization_examples()
