"""Session batch endpoints.

One request approves several queued posts. The response returns the persisted session at once and
the caller follows progress on the SSE stream. Cancelling takes effect before the next post.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from typing import Annotated, Any
from uuid import UUID

from fastapi import FastAPI, Query
from fastapi.responses import StreamingResponse

from naver_blog_assistant.api.errors import ApiError
from naver_blog_assistant.api.session_models import (
    SafetyActionStatusResponse,
    SafetyStatusResponse,
    ScheduleStatusResponse,
    SessionApprovalRequest,
    SessionListResponse,
    SessionResponse,
)
from naver_blog_assistant.application.automation import EngagementNotAllowedError, RunSession
from naver_blog_assistant.domain import DiscoverySource, DomainValidationError, SessionTrigger
from naver_blog_assistant.domain.engagement import EngagementStepName
from naver_blog_assistant.infrastructure.database.session_repository import (
    SessionAlreadyRunningError,
    SessionNotFoundError,
)


def register_session_routes(
    app: FastAPI,
    *,
    sessions: RunSession,
    store: Any,
    schedule: Any,
    safety: Any,
    read_setting: Any,
    problem_metadata: Callable[..., dict[str, Any]],
) -> None:
    """Add the session batch endpoints to ``app``."""

    @app.post(
        "/api/v1/automation/sessions",
        response_model=SessionResponse,
        status_code=202,
        responses={
            403: problem_metadata("The automation consent is missing."),
            409: problem_metadata("Another session is still active."),
            422: problem_metadata("The approval is not usable."),
        },
        tags=["Automation"],
        operation_id="approveAutomationSession",
    )
    async def approve_session(payload: SessionApprovalRequest) -> SessionResponse:
        try:
            session = sessions.approve(
                trigger=SessionTrigger.SESSION,
                approved_steps=[EngagementStepName(step) for step in payload.approved_steps],
                max_posts=payload.max_posts,
                sources=[DiscoverySource(source) for source in payload.sources],
                post_ids=payload.post_ids,
            )
        except EngagementNotAllowedError as error:
            raise ApiError(
                status=403,
                code=error.code,
                title="Not allowed",
                detail="설정에서 자동 실행 동의가 필요합니다.",
            ) from error
        except SessionAlreadyRunningError as error:
            raise ApiError(
                status=409,
                code="session_already_running",
                title="Session already running",
                detail="이미 진행 중인 세션이 있습니다. 먼저 취소하거나 끝나기를 기다리세요.",
            ) from error
        except (DomainValidationError, ValueError) as error:
            raise ApiError(
                status=422,
                code="invalid_session_approval",
                title="Invalid approval",
                detail=str(error),
            ) from error
        sessions.start_background(session.id)
        return SessionResponse.from_domain(session)

    @app.get(
        "/api/v1/automation/safety-status",
        response_model=SafetyStatusResponse,
        tags=["Automation"],
        operation_id="getAutomationSafetyStatus",
    )
    async def get_safety_status() -> SafetyStatusResponse:
        status = safety.status()
        return SafetyStatusResponse(
            local_date=status.local_date,
            allowed_now=status.allowed_now,
            blocking_reason=status.blocking_reason,
            allowed_hours=list(status.allowed_hours),
            min_interval_seconds=status.min_interval_seconds,
            consecutive_failures=status.consecutive_failures,
            max_consecutive_failures=status.max_consecutive_failures,
            actions=[
                SafetyActionStatusResponse(
                    name=action.action.value,
                    cap=action.cap,
                    used=action.used,
                    remaining=action.remaining,
                )
                for action in status.actions
            ],
        )

    @app.get(
        "/api/v1/automation/schedule",
        response_model=ScheduleStatusResponse,
        tags=["Automation"],
        operation_id="getAutomationSchedule",
    )
    async def get_schedule() -> ScheduleStatusResponse:
        from naver_blog_assistant.domain import AppSettingKind  # noqa: PLC0415

        payload = read_setting.execute(AppSettingKind.SCHEDULE_POLICY).payload
        return ScheduleStatusResponse(
            mode=payload["mode"],
            hour=int(payload["hour"]),
            minute=int(payload["minute"]),
            max_posts=int(payload["max_posts"]),
            enabled=schedule.enabled(),
            blocking_reason=None if schedule.enabled() else _schedule_reason(schedule),
        )

    @app.get(
        "/api/v1/automation/sessions",
        response_model=SessionListResponse,
        responses={422: problem_metadata("The request parameters are invalid.")},
        tags=["Automation"],
        operation_id="listAutomationSessions",
    )
    async def list_sessions(
        limit: Annotated[int, Query(ge=1, le=50)] = 20,
    ) -> SessionListResponse:
        return SessionListResponse.from_domain(store.recent(limit=limit))

    @app.get(
        "/api/v1/automation/sessions/{session_id}",
        response_model=SessionResponse,
        responses={
            404: problem_metadata("The session does not exist."),
            422: problem_metadata("The session identifier is invalid."),
        },
        tags=["Automation"],
        operation_id="getAutomationSession",
    )
    async def get_session(session_id: UUID) -> SessionResponse:
        return SessionResponse.from_domain(_session(store, session_id))

    @app.post(
        "/api/v1/automation/sessions/{session_id}/cancel",
        response_model=SessionResponse,
        responses={
            404: problem_metadata("The session does not exist."),
            422: problem_metadata("The session identifier is invalid."),
        },
        tags=["Automation"],
        operation_id="cancelAutomationSession",
    )
    async def cancel_session(session_id: UUID) -> SessionResponse:
        _session(store, session_id)
        return SessionResponse.from_domain(sessions.cancel(session_id))

    @app.get(
        "/api/v1/automation/sessions/{session_id}/events",
        responses={
            200: {
                "description": "Server-sent progress for one session batch.",
                "content": {"text/event-stream": {"schema": {"type": "string"}}},
            },
            422: problem_metadata("The session identifier is invalid."),
        },
        tags=["Automation"],
        operation_id="streamAutomationSessionEvents",
    )
    async def stream_session_events(session_id: UUID) -> StreamingResponse:
        async def stream() -> AsyncIterator[bytes]:
            async for event in sessions.events(session_id):
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


def _schedule_reason(schedule: Any) -> str:
    """Report why unattended mode cannot run, without exposing internals."""
    reason = schedule._blocking_reason()  # noqa: SLF001 - the gate is internal to the use case
    return "ready" if reason is None else reason


def _session(store: Any, session_id: UUID) -> Any:
    try:
        return store.get(session_id)
    except SessionNotFoundError as error:
        raise ApiError(
            status=404,
            code="session_not_found",
            title="Session not found",
            detail="해당 세션을 찾을 수 없습니다.",
        ) from error
