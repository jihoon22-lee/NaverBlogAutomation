"""Generate and persist a recommendation from one captured article."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

from naver_blog_assistant.application.errors import (
    GenerationInProgressError,
    IdempotencyConflictError,
)
from naver_blog_assistant.domain import (
    CapturedPost,
    CommentCandidate,
    Recommendation,
    ReviewStatus,
)
from naver_blog_assistant.ports import (
    CommentGenerator,
    GenerationNotStartedError,
    IdempotencyOutcome,
    IdempotencyRepository,
)


@dataclass(frozen=True, slots=True)
class GenerationResult:
    """Recommendation plus whether it was replayed from prior work."""

    recommendation: Recommendation
    replayed: bool


class GenerateRecommendation:
    """Coordinate idempotency, generation, and body-free persistence."""

    def __init__(
        self,
        *,
        generator: CommentGenerator,
        idempotency: IdempotencyRepository,
        clock: Callable[[], datetime] | None = None,
        id_factory: Callable[[], UUID] | None = None,
    ) -> None:
        self._generator = generator
        self._idempotency = idempotency
        self._clock = clock or (lambda: datetime.now(UTC))
        self._id_factory = id_factory or uuid4

    def execute(self, *, post: CapturedPost, idempotency_key: UUID) -> GenerationResult:
        """Generate once for a key and replay a matching completed request."""
        reservation = self._idempotency.reserve(idempotency_key, post.request_hash)
        if reservation.outcome is IdempotencyOutcome.CONFLICT:
            raise IdempotencyConflictError("idempotency key was used for different content")
        if reservation.outcome is IdempotencyOutcome.IN_PROGRESS:
            raise GenerationInProgressError("generation is already in progress")
        if reservation.outcome is IdempotencyOutcome.REPLAY:
            assert reservation.response_snapshot is not None
            return GenerationResult(
                recommendation=reservation.response_snapshot,
                replayed=True,
            )
        assert reservation.attempt_id is not None
        attempt_id = reservation.attempt_id

        try:
            self._idempotency.mark_generation_started(idempotency_key, attempt_id)
        except Exception:
            # Fencing makes cleanup safe if this attempt lost ownership before the mark.
            self._idempotency.release(idempotency_key, attempt_id)
            raise

        try:
            output = self._generator.generate(post)
        except GenerationNotStartedError:
            self._idempotency.release(idempotency_key, attempt_id)
            raise

        recommendation = Recommendation(
            id=self._id_factory(),
            source_url=post.source_url,
            title=post.title,
            content_hash=post.content_hash,
            excerpt=post.excerpt,
            summary=output.summary,
            topics=output.topics,
            candidates=tuple(
                CommentCandidate(
                    id=self._id_factory(),
                    tone=candidate.tone,
                    comment=candidate.comment,
                    referenced_detail=candidate.referenced_detail,
                )
                for candidate in output.candidates
            ),
            review_status=ReviewStatus.DRAFTED,
            created_at=self._clock(),
        )
        self._idempotency.commit_generation(
            idempotency_key,
            attempt_id,
            recommendation=recommendation,
        )

        return GenerationResult(recommendation=recommendation, replayed=False)
