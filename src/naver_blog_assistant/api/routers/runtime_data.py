"""Desktop-only data location, export, and recoverable reset endpoints."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, Response

from naver_blog_assistant.api.errors import ApiError
from naver_blog_assistant.api.models import (
    RuntimeDataResetRequest,
    RuntimeDataResetResponse,
    RuntimeDataResponse,
)
from naver_blog_assistant.application.runtime_data import (
    RuntimeDataError,
    RuntimeDataManager,
)
from naver_blog_assistant.domain import BrowserSessionState


def register_runtime_data_routes(
    app: FastAPI,
    *,
    data: RuntimeDataManager,
    browser_status: Callable[[], Any],
    restart_allowed: Callable[[], bool],
    restart_marker: Path | None,
    problem_metadata: Callable[..., dict[str, Any]],
) -> None:
    """Register data endpoints; all paths are resolved by the service, never the request."""

    def require_local(request: Request) -> None:
        if not getattr(request.state, "is_local_client", False):
            raise ApiError(
                status=403,
                code="runtime_data_local_only",
                title="Desktop request required",
                detail="데이터 관리는 PC의 로컬 웹앱에서만 사용할 수 있습니다.",
            )

    def require_idle_restart() -> None:
        require_idle()
        if restart_marker is None:
            raise ApiError(
                status=409,
                code="launcher_restart_unavailable",
                title="Launcher restart unavailable",
                detail="이 API 실행 방식에서는 데이터 초기화를 지원하지 않습니다.",
            )

    def require_idle() -> None:
        if browser_status().state is not BrowserSessionState.STOPPED or not restart_allowed():
            raise ApiError(
                status=409,
                code="restart_busy",
                title="Restart blocked by active work",
                detail="브라우저, 배치, 네이버 임시저장 작업을 모두 마친 뒤 다시 시도하세요.",
            )

    @app.get(
        "/api/v1/runtime/data",
        response_model=RuntimeDataResponse,
        responses={
            403: problem_metadata("Only a local desktop can view runtime data metadata."),
            409: problem_metadata("The local data path is unsafe or unavailable."),
        },
        tags=["Runtime data"],
        operation_id="getRuntimeData",
    )
    def get_data(request: Request) -> RuntimeDataResponse:
        require_local(request)
        return _snapshot(data, reset_available=restart_marker is not None)

    @app.post(
        "/api/v1/runtime/data/export",
        responses={
            200: {"description": "A user-requested archive of the local database and draft media."},
            403: problem_metadata("Only a local desktop can export runtime data."),
            409: problem_metadata("The local data path is unsafe or unavailable."),
        },
        tags=["Runtime data"],
        operation_id="exportRuntimeData",
    )
    def export_data(request: Request) -> Response:
        require_local(request)
        require_idle()
        try:
            payload = data.export()
        except RuntimeDataError as error:
            raise ApiError(
                status=409,
                code=str(error),
                title="Runtime data export unavailable",
                detail="로컬 데이터 경로를 안전하게 내보낼 수 없습니다.",
            ) from error
        return Response(
            content=payload,
            media_type="application/zip",
            headers={
                "Content-Disposition": 'attachment; filename="naver-blog-assistant-data.zip"',
                "Cache-Control": "no-store",
            },
        )

    @app.post(
        "/api/v1/runtime/data/reset",
        response_model=RuntimeDataResetResponse,
        status_code=202,
        responses={
            403: problem_metadata("Only a local desktop can reset runtime data."),
            409: problem_metadata("Resetting is unavailable or unsafe right now."),
            422: problem_metadata("The reset confirmation is invalid."),
        },
        tags=["Runtime data"],
        operation_id="resetRuntimeData",
    )
    def reset_data(payload: RuntimeDataResetRequest, request: Request) -> RuntimeDataResetResponse:
        require_local(request)
        require_idle_restart()
        try:
            reset = data.reset(confirmation=payload.confirmation)
        except RuntimeDataError as error:
            code = str(error)
            status = 422 if code == "reset_confirmation_invalid" else 409
            raise ApiError(
                status=status,
                code=code,
                title="Runtime data not reset",
                detail="로컬 데이터 초기화를 안전하게 완료하지 못했습니다.",
            ) from error
        assert restart_marker is not None
        restart_marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        restart_marker.write_text("reset\n", encoding="ascii")
        return RuntimeDataResetResponse(
            backup_location=reset.backup_location,
            restart_required=reset.restart_required,
        )


def _snapshot(data: RuntimeDataManager, *, reset_available: bool) -> RuntimeDataResponse:
    try:
        snapshot = data.snapshot(reset_available=reset_available)
    except RuntimeDataError as error:
        raise ApiError(
            status=409,
            code=str(error),
            title="Runtime data unavailable",
            detail="로컬 데이터 경로를 안전하게 확인할 수 없습니다.",
        ) from error
    return RuntimeDataResponse(
        database_location=snapshot.database_location,
        database_file_count=snapshot.database_file_count,
        media_location=snapshot.media_location,
        media_file_count=snapshot.media_file_count,
        file_count=snapshot.file_count,
        size_bytes=snapshot.size_bytes,
        reset_available=snapshot.reset_available,
    )


__all__ = ["register_runtime_data_routes"]
