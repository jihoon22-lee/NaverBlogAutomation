"""Engagement run endpoints for the local web app.

Starting a run is one explicit user approval. The response returns the persisted run immediately and
the caller follows progress on the SSE stream, so a long browser sequence never blocks the request
that approved it.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from typing import Any
from uuid import UUID

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from naver_blog_assistant.api.errors import ApiError
from naver_blog_assistant.api.models import (
    AutomationRunRequest,
    EngagementRunResponse,
)
from naver_blog_assistant.application import RecommendationNotFoundError
from naver_blog_assistant.application.automation import (
    EngagementNotAllowedError,
    EngagementRunService,
)

REFUSAL_DETAILS: dict[str, tuple[int, str]] = {
    "post_not_found": (404, "대기열에서 해당 글을 찾을 수 없습니다."),
    "recommendation_not_approved": (409, "승인된 댓글이 없습니다. 먼저 댓글을 승인하세요."),
    "comment_missing": (409, "등록할 댓글이 비어 있습니다."),
    "consent_missing": (403, "설정에서 자동 실행 동의가 필요합니다."),
}


def register_engagement_routes(
    app: FastAPI,
    *,
    runs: EngagementRunService,
    problem_metadata: Callable[..., dict[str, Any]],
) -> None:
    """Add the engagement run and event stream endpoints to ``app``."""

    @app.post(
        "/api/v1/automation/engagement-runs",
        response_model=EngagementRunResponse,
        status_code=202,
        responses={
            403: problem_metadata("Automation consent is required."),
            404: problem_metadata("The queued post or recommendation does not exist."),
            409: problem_metadata("The approval does not permit a run."),
            422: problem_metadata("Request validation failed."),
        },
        tags=["Automation"],
        operation_id="startAutomationRun",
    )
    async def start_automation_run(payload: AutomationRunRequest) -> EngagementRunResponse:
        try:
            run, request = runs.prepare(
                discovery_post_id=payload.discovery_post_id,
                recommendation_id=payload.recommendation_id,
            )
        except EngagementNotAllowedError as error:
            status, detail = REFUSAL_DETAILS[error.code]
            raise ApiError(
                status=status,
                code=error.code,
                title="Engagement not allowed",
                detail=detail,
            ) from error
        except RecommendationNotFoundError as error:
            raise ApiError(
                status=404,
                code="recommendation_not_found",
                title="Recommendation not found",
                detail="해당 추천을 찾을 수 없습니다.",
            ) from error
        except ValueError as error:
            raise ApiError(
                status=409,
                code="engagement_conflict",
                title="Engagement conflict",
                detail="이미 다른 실행에 연결된 승인입니다.",
            ) from error
        runs.start_background(run.id, request)
        return EngagementRunResponse.from_domain(run)

    @app.get(
        "/api/v1/automation/engagement-runs/{run_id}/events",
        responses={
            200: {
                "description": "Server-sent step progress for one run.",
                "content": {"text/event-stream": {"schema": {"type": "string"}}},
            },
            422: problem_metadata("The run identifier is invalid."),
        },
        tags=["Automation"],
        operation_id="streamAutomationRunEvents",
    )
    async def stream_automation_run_events(run_id: UUID) -> StreamingResponse:
        async def stream() -> AsyncIterator[bytes]:
            async for event in runs.events(run_id):
                if event.event == "keepalive":
                    yield b": keepalive\n\n"
                    continue
                payload = json.dumps(event.payload, ensure_ascii=False, sort_keys=True)
                yield f"event: {event.event}\ndata: {payload}\n\n".encode()

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )
