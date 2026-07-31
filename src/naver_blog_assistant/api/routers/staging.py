"""Staging endpoints for one composed draft.

Starting a run is one explicit approval. The response returns the persisted run immediately and the
caller follows progress on the SSE stream, so a long editor sequence never blocks the request.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from typing import Any
from uuid import UUID

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from naver_blog_assistant.api.draft_models import PublishRunResponse
from naver_blog_assistant.api.errors import ApiError
from naver_blog_assistant.application.automation import StagePostService, StagingBlockedError
from naver_blog_assistant.infrastructure.database.post_draft_repository import DraftNotFoundError

STAGING_DETAILS: dict[str, str] = {
    "blog_id_missing": "설정에서 내 블로그 ID를 먼저 저장하세요.",
    "no_active_revision": "먼저 본문을 생성하거나 저장하세요.",
    "navigation_failed": "글쓰기 화면을 열지 못했습니다.",
    "editor_not_found": "에디터 입력 영역을 찾지 못했습니다.",
    "editor_ambiguous": "에디터 대상이 여러 개여서 중단했습니다.",
    "login_required": "네이버에 다시 로그인해야 합니다.",
    "restore_prompt_unresolved": "작성 중인 글 안내를 처리할 수 없어 중단했습니다.",
}


def register_staging_routes(
    app: FastAPI,
    *,
    staging: StagePostService,
    problem_metadata: Callable[..., dict[str, Any]],
) -> None:
    """Add the staging endpoints to ``app``."""

    @app.post(
        "/api/v1/drafts/{draft_id}/stage",
        response_model=PublishRunResponse,
        status_code=202,
        responses={
            404: problem_metadata("The draft does not exist."),
            422: problem_metadata("The draft cannot be staged."),
        },
        tags=["Writing"],
        operation_id="stagePostDraft",
    )
    async def stage_draft(draft_id: UUID) -> PublishRunResponse:
        try:
            approval = staging.prepare(draft_id)
        except DraftNotFoundError as error:
            raise ApiError(
                status=404,
                code="draft_not_found",
                title="Draft not found",
                detail="해당 초안을 찾을 수 없습니다.",
            ) from error
        except StagingBlockedError as error:
            raise ApiError(
                status=422,
                code=error.code,
                title="Draft cannot be staged",
                detail=STAGING_DETAILS[error.code],
            ) from error
        staging.start_background(approval.run.id, approval.request)
        return PublishRunResponse.from_domain(approval.run)

    @app.get(
        "/api/v1/drafts/{draft_id}/stage/events",
        responses={
            200: {
                "description": "Server-sent step progress for one staging run.",
                "content": {"text/event-stream": {"schema": {"type": "string"}}},
            },
            404: problem_metadata("The draft does not exist."),
            422: problem_metadata("The draft identifier is invalid."),
        },
        tags=["Writing"],
        operation_id="streamStagingEvents",
    )
    async def stream_staging_events(draft_id: UUID) -> StreamingResponse:
        run_id = staging.run_id_for(draft_id)

        async def stream() -> AsyncIterator[bytes]:
            if run_id is None:
                return
            async for event in staging.events(run_id):
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
