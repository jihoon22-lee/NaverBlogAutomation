"""Comment generation for the local web app.

The web app sends a URL, so the service extracts the post, resolves the saved generation
profile, and derives its own idempotency key. A timeout or an interrupted response never
silently issues a new key: the same request replays until the user explicitly asks for a
replacement attempt.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi import FastAPI, Response

from naver_blog_assistant.api.errors import ApiError
from naver_blog_assistant.api.models import (
    ArticleExtractionResponse,
    CommentFanoutRequest,
    CommentFanoutResponse,
    CommentGenerationRequest,
    CommentGenerationResponse,
    ProviderOutcomeResponse,
    RecommendationResponse,
)
from naver_blog_assistant.api.routers.automation import EXTRACTION_DETAILS, to_api_error
from naver_blog_assistant.application import (
    GenerateRecommendation,
    GenerationIndeterminateError,
    GenerationInProgressError,
    GenerationInvalidError,
    GenerationRateLimitedError,
    GenerationRefusedError,
    GenerationResult,
    GenerationUnavailableError,
    IdempotencyConflictError,
    ReplayedGenerationFailure,
)
from naver_blog_assistant.application.automation import (
    ArticleExtractionFailedError,
    BrowserSessionNotRunningError,
    BrowserSessionOperationFailedError,
    ExtractArticle,
    GenerationOptions,
    PlanGeneration,
)
from naver_blog_assistant.application.llm import BudgetExceededError, FanOutGeneration
from naver_blog_assistant.domain import DomainValidationError, ModelSelection
from naver_blog_assistant.infrastructure.browser import PageBundleMissingError

logger = logging.getLogger("naver_blog_assistant.api")


def register_comment_routes(
    app: FastAPI,
    *,
    extractions: ExtractArticle,
    generate: GenerateRecommendation,
    planner: PlanGeneration,
    problem_metadata: Callable[..., dict[str, Any]],
    timeout_seconds: float,
    track: Callable[[asyncio.Task[GenerationResult]], None],
    fanout: FanOutGeneration | None = None,
    selection_for: Callable[[str, str | None], ModelSelection] | None = None,
) -> None:
    """Add the web app comment generation endpoint to ``app``."""

    @app.post(
        "/api/v1/automation/comments",
        response_model=CommentGenerationResponse,
        responses={
            200: {
                "description": "The stored recommendation for this request.",
                "headers": {
                    "Idempotency-Replayed": {
                        "description": (
                            "True when returning a stored success for a repeated request."
                        ),
                        "schema": {"type": "boolean"},
                    }
                },
            },
            409: problem_metadata("Generation for this request is already in progress."),
            422: problem_metadata("The URL or the captured article is unusable."),
            429: problem_metadata("Generation was rate limited.", retry_after=True),
            502: problem_metadata("Generation was refused or the browser failed."),
            503: problem_metadata("A generation dependency is unavailable."),
            504: problem_metadata("Generation timed out."),
        },
        tags=["Automation"],
        operation_id="generateComment",
    )
    async def generate_comment(
        payload: CommentGenerationRequest, response: Response
    ) -> CommentGenerationResponse:
        extraction = await _extract(payload.url)
        options = _options(payload)
        try:
            plan = planner.execute(extraction, options)
        except ValueError as error:
            raise ApiError(
                status=422,
                code="invalid_generation_options",
                title="Invalid generation options",
                detail="생성 옵션이 유효하지 않습니다.",
            ) from error
        attempt, key = planner.key_for(plan, options)
        result = await _generate(plan, key, timeout_seconds, generate, track)
        if result.replayed:
            response.headers["Idempotency-Replayed"] = "true"
        return CommentGenerationResponse(
            attempt=attempt,
            extraction=ArticleExtractionResponse.from_domain(extraction),
            recommendation=RecommendationResponse.from_domain(result.recommendation),
            replayed=result.replayed,
        )

    async def _extract(url: str) -> Any:
        try:
            return await extractions.execute(url)
        except PageBundleMissingError as error:
            raise ApiError(
                status=503,
                code="browser_unavailable",
                title="Browser unavailable",
                detail="page bundle이 없어 본문을 읽을 수 없습니다. client build를 실행하세요.",
            ) from error
        except ArticleExtractionFailedError as error:
            raise ApiError(
                status=422,
                code=error.code,
                title="Article extraction failed",
                detail=EXTRACTION_DETAILS[error.code],
            ) from error
        except (BrowserSessionNotRunningError, BrowserSessionOperationFailedError) as error:
            raise to_api_error(error) from error

    @app.post(
        "/api/v1/automation/comments/fanout",
        response_model=CommentFanoutResponse,
        responses={
            200: {"description": "Every provider outcome for this request."},
            402: problem_metadata("A configured call budget would be exceeded."),
            422: problem_metadata("The URL, the article, or a provider selection is unusable."),
            502: problem_metadata("Every provider failed."),
            503: problem_metadata("A generation dependency is unavailable."),
        },
        tags=["Automation"],
        operation_id="generateCommentFanout",
    )
    async def generate_comment_fanout(payload: CommentFanoutRequest) -> CommentFanoutResponse:
        if fanout is None or selection_for is None:
            raise ApiError(
                status=503,
                code="generation_unavailable",
                title="Generation unavailable",
                detail="호출할 수 있는 provider가 구성되지 않았습니다.",
            )
        generation, resolve = fanout, selection_for
        extraction = await _extract(payload.url)
        options = _options(payload)
        try:
            plan = planner.execute(extraction, options)
        except ValueError as error:
            raise ApiError(
                status=422,
                code="invalid_generation_options",
                title="Invalid generation options",
                detail="생성 옵션이 유효하지 않습니다.",
            ) from error
        attempt, _ = planner.key_for(plan, options)
        try:
            selections = [resolve(item.provider, item.model) for item in payload.providers]
        except (DomainValidationError, ValueError) as error:
            raise ApiError(
                status=422,
                code="invalid_provider_selection",
                title="Invalid provider selection",
                detail="provider 또는 model 값이 유효하지 않습니다.",
            ) from error
        try:
            result = await generation.execute(
                post=plan.post,
                request_hash=plan.request_hash,
                attempt=attempt,
                selections=selections,
                preferences=plan.preferences,
                personalization_mode=plan.personalization_mode,
            )
        except BudgetExceededError as error:
            raise ApiError(
                status=402,
                code=error.code,
                title="Call budget exceeded",
                detail=(
                    f"설정한 상한 {error.limit}을 넘습니다. 현재 {error.observed}건 사용했습니다."
                ),
            ) from error
        if not result.succeeded:
            raise ApiError(
                status=502,
                code="fanout_all_failed",
                title="Every provider failed",
                detail="선택한 provider 모두 후보를 만들지 못했습니다.",
            )
        return CommentFanoutResponse(
            attempt=result.attempt,
            extraction=ArticleExtractionResponse.from_domain(extraction),
            items=[
                ProviderOutcomeResponse(
                    provider=outcome.selection.provider.value,
                    model=outcome.selection.model,
                    status=outcome.status.value,
                    result_code=outcome.result_code,
                    replayed=outcome.replayed,
                    retry_after=outcome.retry_after,
                    recommendation=None
                    if outcome.recommendation is None
                    else RecommendationResponse.from_domain(outcome.recommendation),
                )
                for outcome in result.outcomes
            ],
        )


def _options(payload: CommentGenerationRequest) -> GenerationOptions:
    return GenerationOptions(
        relationship_level=None
        if payload.relationship_level is None
        else payload.relationship_level.value,
        speech_style=None if payload.speech_style is None else payload.speech_style.value,
        comment_length=None if payload.comment_length is None else payload.comment_length.value,
        comment_mood=None if payload.comment_mood is None else payload.comment_mood.value,
        personalization_mode=(
            None if payload.personalization_mode is None else payload.personalization_mode.value
        ),
        replace=payload.replace,
    )


async def _generate(  # noqa: C901 - one branch per documented generation failure
    plan: Any,
    key: str,
    timeout_seconds: float,
    generate: GenerateRecommendation,
    track: Callable[[asyncio.Task[GenerationResult]], None],
) -> GenerationResult:
    task = asyncio.create_task(
        asyncio.to_thread(
            generate.execute,
            post=plan.post,
            preferences=plan.preferences,
            personalization_mode=plan.personalization_mode,
            idempotency_key=UUID(key),
        )
    )
    track(task)
    try:
        async with asyncio.timeout(timeout_seconds):
            return await asyncio.shield(task)
    except TimeoutError as error:
        raise ApiError(
            status=504,
            code="generation_timeout",
            title="Generation timed out",
            detail=(
                "생성이 제한 시간 안에 끝나지 않았습니다."
                " 같은 요청은 결과가 확인될 때까지 같은 key를 재사용합니다."
            ),
        ) from error
    except IdempotencyConflictError as error:
        raise ApiError(
            status=409,
            code="idempotency_conflict",
            title="Idempotency conflict",
            detail="같은 key가 다른 내용으로 사용되었습니다.",
        ) from error
    except GenerationInProgressError as error:
        raise ApiError(
            status=409,
            code="generation_in_progress",
            title="Generation in progress",
            detail="같은 요청이 이미 처리 중입니다.",
        ) from error
    except GenerationIndeterminateError as error:
        raise ApiError(
            status=409,
            code="generation_indeterminate",
            title="Generation indeterminate",
            detail="이전 결과를 확인할 수 없습니다. 다시 시도하려면 교체를 명시적으로 승인하세요.",
        ) from error
    except GenerationRateLimitedError as error:
        raise ApiError(
            status=429,
            code="generation_rate_limited",
            title="Generation rate limited",
            detail="생성 요청이 잠시 제한되었습니다.",
            retry_after=error.retry_after,
        ) from error
    except ReplayedGenerationFailure as error:
        raise ApiError(
            status=502,
            code="generation_refused",
            title="Generation refused",
            detail="이전 생성 실패 결과를 그대로 반환했습니다.",
            idempotency_replayed=True,
        ) from error
    except GenerationRefusedError as error:
        raise ApiError(
            status=502,
            code="generation_refused",
            title="Generation refused",
            detail="생성기가 안전하게 후보를 만들 수 없었습니다.",
        ) from error
    except GenerationInvalidError as error:
        raise ApiError(
            status=502,
            code="generation_invalid",
            title="Generation invalid",
            detail="생성 결과가 계약과 맞지 않습니다.",
        ) from error
    except GenerationUnavailableError as error:
        raise ApiError(
            status=503,
            code="generation_unavailable",
            title="Generation unavailable",
            detail="생성 의존성을 사용할 수 없습니다.",
        ) from error
