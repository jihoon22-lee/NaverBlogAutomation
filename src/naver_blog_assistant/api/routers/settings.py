"""Settings endpoints for the local web app.

Payload validation happens in the domain layer so the scheduler and the web app cannot disagree
about what a valid setting is.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any

from fastapi import FastAPI, Path

from naver_blog_assistant.api.errors import ApiError
from naver_blog_assistant.api.models import AppSettingRequest, AppSettingResponse
from naver_blog_assistant.application.settings import ReadAppSetting, SaveAppSetting
from naver_blog_assistant.domain import AppSettingKind, DomainValidationError

SETTING_KIND_VALUES = tuple(kind.value for kind in AppSettingKind)


def register_settings_routes(
    app: FastAPI,
    *,
    read_setting: ReadAppSetting,
    save_setting: SaveAppSetting,
    problem_metadata: Callable[..., dict[str, Any]],
) -> None:
    """Add the versioned settings endpoints to ``app``."""

    def resolve(kind: str) -> AppSettingKind:
        try:
            return AppSettingKind(kind)
        except ValueError as error:
            raise ApiError(
                status=404,
                code="setting_not_found",
                title="Setting not found",
                detail="지원하지 않는 설정 종류입니다.",
            ) from error

    @app.get(
        "/api/v1/settings/{kind}",
        response_model=AppSettingResponse,
        responses={
            404: problem_metadata("The settings kind does not exist."),
            422: problem_metadata("The path parameter is invalid."),
        },
        tags=["Settings"],
        operation_id="getAppSetting",
    )
    def get_app_setting(kind: Annotated[str, Path()]) -> AppSettingResponse:
        return AppSettingResponse.from_domain(read_setting.execute(resolve(kind)))

    @app.put(
        "/api/v1/settings/{kind}",
        response_model=AppSettingResponse,
        responses={
            404: problem_metadata("The settings kind does not exist."),
            422: problem_metadata("The settings payload is invalid."),
        },
        tags=["Settings"],
        operation_id="saveAppSetting",
    )
    def save_app_setting(
        kind: Annotated[str, Path()], request: AppSettingRequest
    ) -> AppSettingResponse:
        resolved = resolve(kind)
        try:
            saved = save_setting.execute(resolved, request.payload)
        except DomainValidationError as error:
            raise ApiError(
                status=422,
                code="invalid_setting",
                title="Invalid setting",
                detail=str(error),
            ) from error
        return AppSettingResponse.from_domain(saved)
