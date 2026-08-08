"""Desktop-only endpoints for write-only private runtime configuration."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal, cast

from fastapi import FastAPI, Request

from naver_blog_assistant.api.errors import ApiError
from naver_blog_assistant.api.models import (
    RuntimeAiConfiguration,
    RuntimeBrowserConfiguration,
    RuntimeConfigurationPatch,
    RuntimeConfigurationResponse,
    RuntimeNaverSearchConfiguration,
    RuntimeNetworkConfiguration,
    RuntimeProviderStatus,
    RuntimeSmtpConfiguration,
)
from naver_blog_assistant.application.runtime_configuration import (
    RuntimeConfiguration,
    RuntimeConfigurationError,
    RuntimeConfigurationSnapshot,
)
from naver_blog_assistant.domain import BrowserSessionState


def register_runtime_configuration_routes(
    app: FastAPI,
    *,
    configuration: RuntimeConfiguration,
    browser_status: Callable[[], Any],
    restart_allowed: Callable[[], bool],
    restart_marker: Path | None,
    problem_metadata: Callable[..., dict[str, Any]],
) -> None:
    """Register non-secret settings and an explicit supervisor restart request."""

    def require_local(request: Request) -> None:
        if not getattr(request.state, "is_local_client", False):
            raise ApiError(
                status=403,
                code="runtime_configuration_local_only",
                title="Desktop request required",
                detail="연결 및 앱 설정은 PC의 로컬 웹앱에서만 변경할 수 있습니다.",
            )

    @app.get(
        "/api/v1/runtime/configuration",
        response_model=RuntimeConfigurationResponse,
        responses={403: problem_metadata("Only a local desktop can view runtime configuration.")},
        tags=["Runtime configuration"],
        operation_id="getRuntimeConfiguration",
    )
    def get_configuration(request: Request) -> RuntimeConfigurationResponse:
        require_local(request)
        return _response(configuration.snapshot())

    @app.patch(
        "/api/v1/runtime/configuration",
        response_model=RuntimeConfigurationResponse,
        responses={
            403: problem_metadata("Only a local desktop can change runtime configuration."),
            409: problem_metadata("The private configuration file is unavailable."),
            422: problem_metadata("The runtime configuration is invalid."),
        },
        tags=["Runtime configuration"],
        operation_id="patchRuntimeConfiguration",
    )
    def patch_configuration(
        payload: RuntimeConfigurationPatch, request: Request
    ) -> RuntimeConfigurationResponse:
        require_local(request)
        try:
            return _response(
                configuration.update(
                    _changes(payload, current_access_mode=configuration.snapshot().access_mode)
                )
            )
        except RuntimeConfigurationError as error:
            status = 409 if str(error) == "launcher_restart_unavailable" else 422
            raise ApiError(
                status=status,
                code=str(error) if status == 409 else "invalid_runtime_configuration",
                title="Runtime configuration not saved",
                detail="런타임 설정을 안전하게 저장하지 못했습니다.",
            ) from error

    @app.post(
        "/api/v1/runtime/restart",
        response_model=RuntimeConfigurationResponse,
        responses={
            403: problem_metadata("Only a local desktop can restart the service."),
            409: problem_metadata("Restarting is unavailable or unsafe right now."),
        },
        tags=["Runtime configuration"],
        operation_id="restartRuntimeConfiguration",
    )
    def restart_configuration(request: Request) -> RuntimeConfigurationResponse:
        require_local(request)
        if not configuration.launcher_restart_available or restart_marker is None:
            raise ApiError(
                status=409,
                code="launcher_restart_unavailable",
                title="Launcher restart unavailable",
                detail="이 API 실행 방식에서는 설정을 저장한 뒤 launcher를 직접 다시 시작하세요.",
            )
        if not configuration.snapshot().restart_required:
            raise ApiError(
                status=409,
                code="restart_not_required",
                title="Restart not required",
                detail="적용할 저장된 연결 설정이 없습니다.",
            )
        status = browser_status()
        if status.state is not BrowserSessionState.STOPPED:
            raise ApiError(
                status=409,
                code="restart_busy",
                title="Restart blocked by active browser",
                detail="자동화 브라우저와 진행 중인 작업을 종료한 뒤 다시 시도하세요.",
            )
        if not restart_allowed():
            raise ApiError(
                status=409,
                code="restart_busy",
                title="Restart blocked by active work",
                detail="진행 중인 배치 또는 네이버 임시저장이 끝난 뒤 다시 시도하세요.",
            )
        restart_marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        restart_marker.write_text("restart\n", encoding="ascii")
        configuration.clear_restart_required()
        return _response(configuration.snapshot())


def _response(snapshot: RuntimeConfigurationSnapshot) -> RuntimeConfigurationResponse:
    return RuntimeConfigurationResponse(
        ai=RuntimeAiConfiguration(
            active_provider=cast(
                Literal["openai", "gemini", "anthropic", "fake"], snapshot.active_provider
            ),
            providers=[
                RuntimeProviderStatus(
                    provider=cast(Literal["openai", "gemini", "anthropic"], provider),
                    configured=configured,
                    model=model,
                )
                for provider, configured, model in snapshot.providers
            ],
        ),
        naver_search=RuntimeNaverSearchConfiguration(configured=snapshot.naver_search_configured),
        smtp=RuntimeSmtpConfiguration(
            configured=snapshot.smtp_configured,
            host=snapshot.smtp_host,
            port=snapshot.smtp_port,
            security=cast(Literal["starttls", "ssl"], snapshot.smtp_security),
            digest_email_from=snapshot.digest_email_from,
            digest_email_to=snapshot.digest_email_to,
        ),
        browser=RuntimeBrowserConfiguration(
            driver=cast(Literal["patchright", "playwright", "fake"], snapshot.browser_driver),
            headless=snapshot.browser_headless,
            channel=snapshot.browser_channel,
        ),
        network=RuntimeNetworkConfiguration(
            access_mode=cast(Literal["local", "lan"], snapshot.access_mode)
        ),
        restart_required=snapshot.restart_required,
        launcher_restart_available=snapshot.launcher_restart_available,
    )


def _changes(
    payload: RuntimeConfigurationPatch, *, current_access_mode: str
) -> dict[str, str | None]:
    access_mode = payload.access_mode or current_access_mode
    values = {
        "COMMENT_GENERATOR_MODE": payload.active_provider,
        "OPENAI_MODEL": payload.openai_model,
        "GEMINI_MODEL": payload.gemini_model,
        "ANTHROPIC_MODEL": payload.anthropic_model,
        "DIGEST_SMTP_HOST": payload.smtp_host,
        "DIGEST_SMTP_PORT": None if payload.smtp_port is None else str(payload.smtp_port),
        "DIGEST_SMTP_SECURITY": payload.smtp_security,
        "DIGEST_EMAIL_FROM": payload.digest_email_from,
        "DIGEST_EMAIL_TO": payload.digest_email_to,
        "AUTOMATION_DRIVER": payload.browser_driver,
        "AUTOMATION_HEADLESS": (
            None if payload.browser_headless is None else str(payload.browser_headless).lower()
        ),
        "AUTOMATION_BROWSER_CHANNEL": payload.browser_channel,
        "WEBAPP_ACCESS_MODE": payload.access_mode,
        "API_HOST": "0.0.0.0" if access_mode == "lan" else "127.0.0.1",
        # Port is application-owned and fixed, not a web form option. Normalizing an old private
        # env file here prevents a later supervised restart from binding an unsafe custom port.
        "API_PORT": "8765",
    }
    secrets = {
        "OPENAI_API_KEY": payload.openai_api_key,
        "GEMINI_API_KEY": payload.gemini_api_key,
        "ANTHROPIC_API_KEY": payload.anthropic_api_key,
        "NAVER_SEARCH_CLIENT_ID": payload.naver_search_client_id,
        "NAVER_SEARCH_CLIENT_SECRET": payload.naver_search_client_secret,
        "DIGEST_SMTP_USERNAME": payload.smtp_username,
        "DIGEST_SMTP_PASSWORD": payload.smtp_password,
    }
    changes: dict[str, str | None] = {
        key: value for key, value in values.items() if value is not None
    }
    for key, intent in secrets.items():
        if intent is not None:
            if intent.clear:
                changes[key] = None
            else:
                assert intent.replace is not None
                changes[key] = intent.replace
    return changes
