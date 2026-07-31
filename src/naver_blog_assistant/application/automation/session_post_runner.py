"""Run one queued post inside an approved session.

The session approval replaces the per-post confirmation, so the runner composes the existing steps
in the order the manual flow uses: extract, generate, approve the first candidate with the saved
closing phrase, then execute the approved actions. Every failure becomes a result code instead of an
exception so the batch can decide whether to continue.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from naver_blog_assistant.application.automation.generate_comment import (
    GenerationOptions,
    PlanGeneration,
    apply_closing_phrase,
    closing_phrase,
)
from naver_blog_assistant.application.errors import ApplicationError
from naver_blog_assistant.application.settings import ReadAppSetting
from naver_blog_assistant.domain import (
    DiscoveredPost,
    EngagementRunState,
    Recommendation,
    ReviewPatch,
    ReviewStatus,
)

logger = logging.getLogger("naver_blog_assistant.api")


@dataclass(frozen=True, slots=True)
class PostAttempt:
    """What happened to one post inside a session."""

    state: EngagementRunState
    result_codes: tuple[str, ...]


class SessionPostRunner:
    """Extract, generate, approve, and execute one queued post."""

    def __init__(
        self,
        *,
        extract: Any,
        planner: PlanGeneration,
        generate: Any,
        review: Any,
        runs: Any,
        read_setting: ReadAppSetting,
        to_thread: Callable[..., Any] | None = None,
    ) -> None:
        self._extract = extract
        self._planner = planner
        self._generate = generate
        self._review = review
        self._runs = runs
        self._read_setting = read_setting
        self._to_thread = to_thread

    async def run_one(self, post: DiscoveredPost) -> tuple[EngagementRunState, tuple[str, ...]]:
        """Process one post and report its terminal state with the observed codes."""
        try:
            extraction = await self._extract.execute(post.source_url)
        except ApplicationError as error:
            return EngagementRunState.FAILED, (_code(error, "extraction_failed"),)
        except Exception as error:  # noqa: BLE001 - a batch must not stop on an adapter detail
            logger.info("session_extract_failed post=%s error=%s", post.id, type(error).__name__)
            return EngagementRunState.FAILED, ("extraction_failed",)

        options = GenerationOptions()
        try:
            plan = self._planner.execute(extraction, options)
            _attempt, key = self._planner.key_for(plan, options)
            result = await self._call(
                self._generate.execute,
                post=plan.post,
                preferences=plan.preferences,
                personalization_mode=plan.personalization_mode,
                idempotency_key=UUID(key),
            )
        except ApplicationError as error:
            return EngagementRunState.FAILED, (_code(error, "generation_failed"),)

        recommendation = self._approve(result.recommendation)
        if recommendation is None:
            return EngagementRunState.FAILED, ("approval_failed",)

        try:
            run, request = self._runs.prepare(
                discovery_post_id=post.id, recommendation_id=recommendation.id
            )
        except ApplicationError as error:
            return EngagementRunState.FAILED, (_code(error, "not_allowed"),)
        except ValueError:
            return EngagementRunState.FAILED, ("engagement_conflict",)

        finished = await self._runs.run(run.id, request)
        if finished is None:
            return EngagementRunState.UNCONFIRMED, ("run_missing",)
        codes = tuple(step.result_code for step in finished.steps if step.result_code is not None)
        return finished.state, codes

    def _approve(self, recommendation: Recommendation) -> Recommendation | None:
        """Approve the first candidate with the saved closing phrase."""
        candidate = recommendation.candidates[0]
        comment = apply_closing_phrase(candidate.comment, closing_phrase(self._read_setting))
        try:
            return self._review.execute(
                recommendation.id,
                ReviewPatch(
                    selected_candidate_id=candidate.id,
                    edited_comment=comment,
                    review_status=ReviewStatus.APPROVED,
                ),
            )
        except ApplicationError:
            return None

    async def _call(self, function: Callable[..., Any], **kwargs: Any) -> Any:
        if self._to_thread is None:
            import asyncio  # noqa: PLC0415 - imported lazily so tests can inject a runner

            return await asyncio.to_thread(function, **kwargs)
        return await self._to_thread(function, **kwargs)


def _code(error: ApplicationError, fallback: str) -> str:
    code = getattr(error, "code", None)
    return code if isinstance(code, str) else fallback
