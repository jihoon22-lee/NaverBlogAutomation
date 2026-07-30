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
from naver_blog_assistant.api.models import (
    ArticleExtractionRequest,
    ArticleExtractionResponse,
    BrowserSessionResponse,
)
from naver_blog_assistant.application.automation import (
    ArticleExtractionFailedError,
    BrowserSessionAlreadyRunningError,
    BrowserSessionBusyError,
    BrowserSessionManager,
    BrowserSessionNotRunningError,
    BrowserSessionOperationFailedError,
    BrowserSessionUnavailableError,
    ExtractArticle,
)
from naver_blog_assistant.infrastructure.browser import PageBundleMissingError

EXTRACTION_DETAILS: dict[str, str] = {
    "unsupported_url": "지원하는 네이버 블로그 글 주소가 아닙니다.",
    "empty_article": "본문을 찾지 못했습니다. 이미지 전용 글은 지원하지 않습니다.",
    "short_article": "본문이 너무 짧아 댓글을 생성할 수 없습니다.",
    "extraction_failed": "본문을 읽는 중 문제가 발생했습니다.",
}

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
    extractions: ExtractArticle,
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

    @app.post(
        "/api/v1/automation/extract",
        response_model=ArticleExtractionResponse,
        responses={
            409: problem_metadata("No live session can open the post."),
            422: problem_metadata("The URL or the captured article is unusable."),
            502: problem_metadata("A live browser operation failed."),
            503: problem_metadata("The injected page bundle is unavailable."),
        },
        tags=["Automation"],
        operation_id="extractArticle",
    )
    async def extract_article(request: ArticleExtractionRequest) -> ArticleExtractionResponse:
        try:
            extraction = await extractions.execute(request.url)
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
        except (
            BrowserSessionNotRunningError,
            BrowserSessionOperationFailedError,
        ) as error:
            raise to_api_error(error) from error
        return ArticleExtractionResponse.from_domain(extraction)
