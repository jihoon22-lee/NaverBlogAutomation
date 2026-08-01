"""Pair and manage trusted private-LAN browser devices from the local desktop."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import FastAPI, Request, Response
from pydantic import Field, StringConstraints

from naver_blog_assistant.api.errors import ApiError
from naver_blog_assistant.api.middleware import REMOTE_CSRF_COOKIE, REMOTE_SESSION_COOKIE
from naver_blog_assistant.api.models import StrictModel
from naver_blog_assistant.application.remote_access import (
    REMOTE_SESSION_LIFETIME,
    PairingRejectedError,
    RemoteAccessService,
    RemoteDeviceSession,
)

DeviceName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
PairingCode = Annotated[str, StringConstraints(min_length=1, max_length=128)]


class PairingCodeResponse(StrictModel):
    code: str
    expires_at: datetime


class PairDeviceRequest(StrictModel):
    code: PairingCode
    device_name: DeviceName


class RemoteDeviceResponse(StrictModel):
    id: UUID
    device_name: DeviceName
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime

    @classmethod
    def from_domain(cls, session: RemoteDeviceSession) -> RemoteDeviceResponse:
        return cls(
            id=session.id,
            device_name=session.device_name,
            created_at=session.created_at,
            last_seen_at=session.last_seen_at,
            expires_at=session.expires_at,
        )


class PairDeviceResponse(StrictModel):
    device: RemoteDeviceResponse


class RemoteDeviceListResponse(StrictModel):
    items: list[RemoteDeviceResponse] = Field(max_length=100)


def register_remote_access_routes(
    app: FastAPI,
    *,
    access: RemoteAccessService,
    problem_metadata: Any,
    pairing_enabled: bool,
) -> None:
    """Add pairing and desktop-only device management endpoints."""

    def require_local(request: Request) -> None:
        if not getattr(request.state, "is_local_client", False):
            raise ApiError(
                status=403,
                code="remote_management_local_only",
                title="Desktop request required",
                detail="Manage trusted devices only from the desktop web app.",
            )

    @app.post(
        "/api/v1/remote/pairing-code",
        response_model=PairingCodeResponse,
        responses={
            403: problem_metadata("Only a local desktop can create pairing codes."),
            409: problem_metadata("Enable trusted-LAN mode before pairing a tablet."),
        },
        tags=["Remote access"],
        operation_id="createRemotePairingCode",
    )
    def create_pairing_code(request: Request) -> PairingCodeResponse:
        require_local(request)
        if not pairing_enabled:
            raise ApiError(
                status=409,
                code="remote_pairing_disabled",
                title="Trusted-LAN pairing is disabled",
                detail="WEBAPP_ACCESS_MODE=lan으로 바꾼 뒤 서비스를 다시 시작하세요.",
            )
        code, expires_at = access.create_pairing_code(now=datetime.now(UTC))
        return PairingCodeResponse(code=code, expires_at=expires_at)

    @app.post(
        "/api/v1/remote/pair",
        response_model=PairDeviceResponse,
        responses={
            403: problem_metadata("The pairing code is invalid or expired."),
            429: problem_metadata("Pairing attempts are temporarily rate limited."),
            422: problem_metadata("Pairing request validation failed."),
        },
        tags=["Remote access"],
        operation_id="pairRemoteDevice",
    )
    def pair_device(
        payload: PairDeviceRequest,
        request: Request,
        response: Response,
    ) -> PairDeviceResponse:
        client = request.client
        client_id = "" if client is None else client.host
        try:
            paired = access.pair(
                code=payload.code,
                device_name=payload.device_name,
                client_id=client_id,
                now=datetime.now(UTC),
            )
        except PairingRejectedError as error:
            if str(error) == "pairing_rate_limited":
                raise ApiError(
                    status=429,
                    code="pairing_rate_limited",
                    title="Pairing rate limited",
                    detail="Wait for a new pairing code before trying this device again.",
                ) from error
            raise ApiError(
                status=403,
                code=str(error),
                title="Pairing rejected",
                detail="The pairing code is invalid, expired, or has already been used.",
            ) from error
        max_age = int(REMOTE_SESSION_LIFETIME.total_seconds())
        response.set_cookie(
            REMOTE_SESSION_COOKIE,
            paired.session_token,
            httponly=True,
            max_age=max_age,
            path="/",
            samesite="strict",
            secure=False,
        )
        response.set_cookie(
            REMOTE_CSRF_COOKIE,
            paired.csrf_token,
            httponly=False,
            max_age=max_age,
            path="/",
            samesite="strict",
            secure=False,
        )
        return PairDeviceResponse(device=RemoteDeviceResponse.from_domain(paired.device))

    @app.get(
        "/api/v1/remote/devices",
        response_model=RemoteDeviceListResponse,
        responses={403: problem_metadata("Only a local desktop can list paired devices.")},
        tags=["Remote access"],
        operation_id="listRemoteDevices",
    )
    def list_devices(request: Request) -> RemoteDeviceListResponse:
        require_local(request)
        return RemoteDeviceListResponse(
            items=[
                RemoteDeviceResponse.from_domain(session)
                for session in access.list_active(now=datetime.now(UTC))
            ]
        )

    @app.delete(
        "/api/v1/remote/devices/{session_id}",
        status_code=204,
        responses={
            204: {"description": "The paired device was revoked."},
            403: problem_metadata("Only a local desktop can revoke paired devices."),
            404: problem_metadata("The paired device does not exist or is already revoked."),
        },
        tags=["Remote access"],
        operation_id="revokeRemoteDevice",
    )
    def revoke_device(session_id: UUID, request: Request) -> Response:
        require_local(request)
        if not access.revoke(session_id, now=datetime.now(UTC)):
            raise ApiError(
                status=404,
                code="remote_device_not_found",
                title="Remote device not found",
                detail="The paired device does not exist or is already revoked.",
            )
        return Response(status_code=204)
