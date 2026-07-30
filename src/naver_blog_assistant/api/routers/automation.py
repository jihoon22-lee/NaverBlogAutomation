"""Automation endpoints for the locally owned browser session.

Registered from the application factory so `factory.py` keeps composition only. Screenshots are
streamed from memory and never written to disk or logs because they can contain article text and the
signed-in account view.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any

from fastapi import FastAPI, Query, Response

from naver_blog_assistant.api.errors import ApiError
from naver_blog_assistant.api.models import BrowserSessionResponse
from naver_blog_assistant.application.automation import (
    BrowserSessionAlreadyRunningError,
    BrowserSessionBusyError,
    BrowserSessionManager,
    BrowserSessionNotRunningError,
    BrowserSessionOperationFailedError,
    BrowserSessionUnavailableError,
)

SESSION_ERROR_MAP: dict[type[Exception], tuple[int, str, str, str]] = {
    BrowserSessionAlreadyRunningError: (
        409,
        "browser_session_already_running",
        "Browser session already running",
        "자동화 브라우저가 이미 실행 중입니다.",
    ),
    BrowserSessionBusyError: (
        409,
        "browser_session_busy",
        "Browser session busy",
        "다른 브라우저 작업이 진행 중입니다.",
    ),
    BrowserSessionNotRunningError: (
        409,
        "browser_session_not_running",
        "Browser session not running",
        "자동화 브라우저가 실행되지 않았습니다.",
    ),
    BrowserSessionUnavailableError: (
        503,
        "browser_unavailable",
        "Browser unavailable",
        "자동화 브라우저를 시작할 수 없습니다. 설치와 설정을 확인하세요.",
    ),
    BrowserSessionOperationFailedError: (
        502,
        "browser_operation_failed",
        "Browser operation failed",
        "브라우저 작업을 완료하지 못했습니다.",
    ),
}


def to_api_error(error: Exception) -> ApiError:
    """Map an automation failure onto a stable problem response without leaking internals."""
    mapped = SESSION_ERROR_MAP.get(type(error))
    if mapped is None:
        return ApiError(
            status=502,
            code="browser_operation_failed",
            title="Browser operation failed",
            detail="브라우저 작업을 완료하지 못했습니다.",
        )
    status, code, title, detail = mapped
    return ApiError(status=status, code=code, title=title, detail=detail)


def register_automation_session_routes(
    app: FastAPI,
    *,
    sessions: BrowserSessionManager,
    problem_metadata: Callable[..., dict[str, Any]],
) -> None:
    """Add the browser session lifecycle endpoints to ``app``."""

    async def guarded(operation: Callable[[], Any]) -> Any:
        try:
            return await operation()
        except (
            BrowserSessionAlreadyRunningError,
            BrowserSessionBusyError,
            BrowserSessionNotRunningError,
            BrowserSessionOperationFailedError,
            BrowserSessionUnavailableError,
        ) as error:
            raise to_api_error(error) from error

    @app.get(
        "/api/v1/automation/session",
        response_model=BrowserSessionResponse,
        responses={
            409: problem_metadata("The browser session is not available for this request."),
            422: problem_metadata("Query validation failed."),
            502: problem_metadata("A live browser operation failed."),
        },
        tags=["Automation"],
        operation_id="getBrowserSession",
    )
    async def browser_session(
        refresh: Annotated[bool, Query()] = False,
    ) -> BrowserSessionResponse:
        if refresh:
            status = await guarded(sessions.refresh_login_state)
            return BrowserSessionResponse.from_domain(status)
        return BrowserSessionResponse.from_domain(sessions.status())

    @app.post(
        "/api/v1/automation/session/launch",
        response_model=BrowserSessionResponse,
        responses={
            409: problem_metadata("A session already exists or is changing state."),
            503: problem_metadata("The configured browser driver could not start."),
        },
        tags=["Automation"],
        operation_id="launchBrowserSession",
    )
    async def launch_browser_session() -> BrowserSessionResponse:
        return BrowserSessionResponse.from_domain(await guarded(sessions.launch))

    @app.post(
        "/api/v1/automation/session/close",
        response_model=BrowserSessionResponse,
        responses={
            409: problem_metadata("No live session can be closed."),
            502: problem_metadata("The browser did not shut down cleanly."),
        },
        tags=["Automation"],
        operation_id="closeBrowserSession",
    )
    async def close_browser_session() -> BrowserSessionResponse:
        return BrowserSessionResponse.from_domain(await guarded(sessions.close))

    @app.post(
        "/api/v1/automation/session/focus",
        response_model=BrowserSessionResponse,
        responses={
            409: problem_metadata("No live session can be focused."),
            502: problem_metadata("The browser window could not be raised."),
        },
        tags=["Automation"],
        operation_id="focusBrowserSession",
    )
    async def focus_browser_session() -> BrowserSessionResponse:
        return BrowserSessionResponse.from_domain(await guarded(sessions.focus))

    @app.get(
        "/api/v1/automation/session/screenshot",
        response_class=Response,
        responses={
            200: {
                "description": "One in-memory PNG capture of the automation tab.",
                "content": {"image/png": {"schema": {"type": "string", "format": "binary"}}},
            },
            409: problem_metadata("No live session can be captured."),
            502: problem_metadata("The capture failed."),
        },
        tags=["Automation"],
        operation_id="captureBrowserSession",
    )
    async def capture_browser_session() -> Response:
        image: bytes = await guarded(sessions.screenshot)
        return Response(
            content=image,
            media_type="image/png",
            headers={"Cache-Control": "no-store"},
        )
