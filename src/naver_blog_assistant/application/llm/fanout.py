"""Call several providers for one request and report each outcome.

Every provider gets its own idempotency key derived from the same request, so repeating a fan-out
replays stored work instead of paying twice. Partial failure is normal: one provider refusing must
not discard another provider's usable answer.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID, uuid5

from naver_blog_assistant.application.errors import (
    ApplicationError,
    GenerationIndeterminateError,
    GenerationInProgressError,
    GenerationRateLimitedError,
    IdempotencyConflictError,
    ReplayedGenerationFailure,
)
from naver_blog_assistant.application.generate_recommendation import GenerationResult
from naver_blog_assistant.application.llm.budget import CallBudget
from naver_blog_assistant.domain import (
    CapturedPost,
    GenerationPreferences,
    LlmCallStatus,
    ModelSelection,
    PersonalizationMode,
    Recommendation,
)

logger = logging.getLogger("naver_blog_assistant.api")

# Fixed namespace so a provider key is reproducible across processes and restarts.
FANOUT_NAMESPACE = UUID("6f1d5c2e-8f3a-4a0e-9c2b-8a7c1d3e5f90")


class RecommendationGenerator(Protocol):
    """Generate and persist one recommendation for one idempotency key."""

    def execute(
        self,
        *,
        post: CapturedPost,
        idempotency_key: UUID,
        preferences: GenerationPreferences,
        personalization_mode: PersonalizationMode,
    ) -> GenerationResult: ...


class AttemptRecorder(Protocol):
    """Store one provider attempt for one request."""

    def record(
        self,
        *,
        request_hash: str,
        attempt: int,
        selection: ModelSelection,
        status: LlmCallStatus,
        result_code: str | None = None,
        recommendation_id: UUID | None = None,
        retry_after: int | None = None,
    ) -> object: ...


def fanout_key(request_hash: str, attempt: int, selection: ModelSelection) -> UUID:
    """Derive the idempotency key for one provider attempt of one request."""
    return uuid5(FANOUT_NAMESPACE, f"{request_hash}:{attempt}:{selection.key}")


@dataclass(frozen=True, slots=True)
class ProviderOutcome:
    """The result of one provider attempt."""

    selection: ModelSelection
    status: LlmCallStatus
    result_code: str | None = None
    recommendation: Recommendation | None = None
    replayed: bool = False
    retry_after: int | None = None


@dataclass(frozen=True, slots=True)
class FanOutResult:
    """Every provider outcome for one request, in the requested order."""

    attempt: int
    outcomes: tuple[ProviderOutcome, ...]

    @property
    def succeeded(self) -> tuple[ProviderOutcome, ...]:
        """Return only the outcomes that produced a recommendation."""
        return tuple(
            outcome for outcome in self.outcomes if outcome.status is LlmCallStatus.SUCCEEDED
        )


FAILURE_CODES: dict[type[BaseException], tuple[LlmCallStatus, str]] = {
    IdempotencyConflictError: (LlmCallStatus.FAILED, "idempotency_conflict"),
    GenerationInProgressError: (LlmCallStatus.INDETERMINATE, "generation_in_progress"),
    GenerationIndeterminateError: (LlmCallStatus.INDETERMINATE, "generation_indeterminate"),
    GenerationRateLimitedError: (LlmCallStatus.FAILED, "generation_rate_limited"),
    ReplayedGenerationFailure: (LlmCallStatus.FAILED, "generation_refused"),
}


class FanOutGeneration:
    """Run one request against several providers in parallel."""

    def __init__(
        self,
        *,
        generators: Mapping[str, RecommendationGenerator],
        attempts: AttemptRecorder,
        budget: CallBudget,
        timeout_seconds: float = 45.0,
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError("fan-out timeout must be positive")
        self._generators = generators
        self._attempts = attempts
        self._budget = budget
        self._timeout_seconds = timeout_seconds

    async def execute(
        self,
        *,
        post: CapturedPost,
        request_hash: str,
        attempt: int,
        selections: Sequence[ModelSelection],
        preferences: GenerationPreferences,
        personalization_mode: PersonalizationMode,
    ) -> FanOutResult:
        """Call every selection once and record each outcome."""
        self._budget.check(selections)
        results = await asyncio.gather(
            *(
                self._one(
                    post=post,
                    request_hash=request_hash,
                    attempt=attempt,
                    selection=selection,
                    preferences=preferences,
                    personalization_mode=personalization_mode,
                )
                for selection in selections
            )
        )
        return FanOutResult(attempt=attempt, outcomes=tuple(results))

    async def _one(
        self,
        *,
        post: CapturedPost,
        request_hash: str,
        attempt: int,
        selection: ModelSelection,
        preferences: GenerationPreferences,
        personalization_mode: PersonalizationMode,
    ) -> ProviderOutcome:
        generate = self._generators.get(selection.provider.value)
        if generate is None:
            return self._record(
                selection, LlmCallStatus.FAILED, "provider_not_configured", request_hash, attempt
            )
        key = fanout_key(request_hash, attempt, selection)
        try:
            async with asyncio.timeout(self._timeout_seconds):
                result = await asyncio.to_thread(
                    generate.execute,
                    post=post,
                    preferences=preferences,
                    personalization_mode=personalization_mode,
                    idempotency_key=key,
                )
        except TimeoutError:
            return self._record(
                selection,
                LlmCallStatus.INDETERMINATE,
                "generation_timeout",
                request_hash,
                attempt,
            )
        except ApplicationError as error:
            return self._failure(selection, error, request_hash, attempt)
        return self._success(selection, result, request_hash, attempt)

    def _success(
        self,
        selection: ModelSelection,
        result: GenerationResult,
        request_hash: str,
        attempt: int,
    ) -> ProviderOutcome:
        self._attempts.record(
            request_hash=request_hash,
            attempt=attempt,
            selection=selection,
            status=LlmCallStatus.SUCCEEDED,
            result_code="generated",
            recommendation_id=result.recommendation.id,
        )
        return ProviderOutcome(
            selection=selection,
            status=LlmCallStatus.SUCCEEDED,
            result_code="generated",
            recommendation=result.recommendation,
            replayed=result.replayed,
        )

    def _failure(
        self,
        selection: ModelSelection,
        error: ApplicationError,
        request_hash: str,
        attempt: int,
    ) -> ProviderOutcome:
        for kind, (status, code) in FAILURE_CODES.items():
            if isinstance(error, kind):
                retry_after = getattr(error, "retry_after", None)
                return self._record(
                    selection, status, code, request_hash, attempt, retry_after=retry_after
                )
        logger.info("fanout_provider_failed provider=%s", selection.provider.value)
        return self._record(
            selection, LlmCallStatus.FAILED, _generic_code(error), request_hash, attempt
        )

    def _record(
        self,
        selection: ModelSelection,
        status: LlmCallStatus,
        code: str,
        request_hash: str,
        attempt: int,
        *,
        retry_after: int | None = None,
    ) -> ProviderOutcome:
        self._attempts.record(
            request_hash=request_hash,
            attempt=attempt,
            selection=selection,
            status=status,
            result_code=code,
            retry_after=retry_after,
        )
        return ProviderOutcome(
            selection=selection, status=status, result_code=code, retry_after=retry_after
        )


def _generic_code(error: ApplicationError) -> str:
    name = type(error).__name__
    if "Refused" in name:
        return "generation_refused"
    if "Invalid" in name:
        return "generation_invalid"
    if "Unavailable" in name:
        return "generation_unavailable"
    return "generation_failed"
