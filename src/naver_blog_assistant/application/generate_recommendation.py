"""Generate and persist a recommendation from one captured article."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

from naver_blog_assistant.application.errors import (
    GenerationIndeterminateError,
    GenerationInProgressError,
    GenerationInvalidError,
    GenerationRateLimitedError,
    GenerationRefusedError,
    GenerationUnavailableError,
    IdempotencyConflictError,
    ReplayedGenerationFailure,
)
from naver_blog_assistant.domain import (
    CapturedPost,
    CommentCandidate,
    DomainValidationError,
    Recommendation,
    ReviewStatus,
)
from naver_blog_assistant.ports import (
    CommentGenerator,
    GenerationFailureSnapshot,
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
        if reservation.outcome is IdempotencyOutcome.FAILURE_REPLAY:
            assert reservation.failure_snapshot is not None
            raise ReplayedGenerationFailure(reservation.failure_snapshot)
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
        except GenerationRefusedError:
            self._commit_failure(idempotency_key, attempt_id, _REFUSED)
            raise
        except GenerationInvalidError:
            self._commit_failure(idempotency_key, attempt_id, _INVALID)
            raise
        except GenerationIndeterminateError:
            self._commit_failure(idempotency_key, attempt_id, _INDETERMINATE, indeterminate=True)
            raise
        except GenerationRateLimitedError:
            self._commit_failure(idempotency_key, attempt_id, _INDETERMINATE, indeterminate=True)
            raise
        except GenerationUnavailableError:
            self._commit_failure(idempotency_key, attempt_id, _UNAVAILABLE)
            raise
        except Exception as error:
            self._commit_failure(idempotency_key, attempt_id, _INDETERMINATE, indeterminate=True)
            raise GenerationIndeterminateError("generation outcome is unknown") from error

        try:
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
        except DomainValidationError as error:
            self._commit_failure(idempotency_key, attempt_id, _INVALID)
            raise GenerationInvalidError("generator result violated the contract") from error
        try:
            self._idempotency.commit_generation(
                idempotency_key,
                attempt_id,
                recommendation=recommendation,
            )
        except Exception as error:
            self._commit_failure(idempotency_key, attempt_id, _INDETERMINATE, indeterminate=True)
            raise GenerationIndeterminateError(
                "generation could not be committed safely"
            ) from error

        return GenerationResult(recommendation=recommendation, replayed=False)

    def _commit_failure(
        self,
        key: UUID,
        attempt_id: UUID,
        failure: GenerationFailureSnapshot,
        *,
        indeterminate: bool = False,
    ) -> None:
        try:
            self._idempotency.commit_failure(
                key,
                attempt_id,
                failure=failure,
                indeterminate=indeterminate,
            )
        except Exception as error:
            # A rolled-back failure write leaves the fenced row generating, preventing a
            # duplicate potentially billable provider call.
            raise GenerationIndeterminateError(
                "generation outcome could not be persisted safely"
            ) from error


_REFUSED = GenerationFailureSnapshot(
    502,
    "generation_refused",
    "Generation refused",
    "The generator could not safely create comment candidates.",
)
_INVALID = GenerationFailureSnapshot(
    502,
    "generation_invalid",
    "Invalid generation result",
    "The generator returned candidates that did not satisfy the contract.",
)
_UNAVAILABLE = GenerationFailureSnapshot(
    503,
    "generation_unavailable",
    "Generation unavailable",
    "Comment generation is temporarily unavailable.",
)
_INDETERMINATE = GenerationFailureSnapshot(
    409,
    "generation_indeterminate",
    "Generation outcome indeterminate",
    "The provider attempt may have started, so this idempotency key cannot be retried safely.",
)
