"""Privacy-preserving request identity, logging, and size controls."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from http.cookies import SimpleCookie
from ipaddress import ip_address
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from naver_blog_assistant.api.models import ProblemDetails
from naver_blog_assistant.application.remote_access import RemoteAccessService

logger = logging.getLogger("naver_blog_assistant.api")
REMOTE_SESSION_COOKIE = "nba_device_session"
REMOTE_CSRF_COOKIE = "nba_csrf"
REMOTE_CSRF_HEADER = "x-nba-csrf"


class OriginBoundaryMiddleware:
    """Reject browser requests whose Origin does not match this web-app service."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        origin = headers.get("origin")
        if origin is None or _is_same_service_origin(headers, origin):
            await self.app(scope, receive, send)
            return
        await _send_problem(
            scope,
            send,
            status=403,
            code="origin_forbidden",
            title="Origin forbidden",
            detail="This browser origin is not allowed to access the local API.",
        )


def _is_same_service_origin(headers: Headers, origin: str) -> bool:
    """Return whether a browser Origin exactly matches this HTTP service's Host header."""
    host = headers.get("host")
    if host is None:
        return False
    parsed = urlsplit(origin)
    return (
        parsed.scheme == "http"
        and parsed.netloc.casefold() == host.casefold()
        and not parsed.path
        and not parsed.query
        and not parsed.fragment
        and parsed.username is None
        and parsed.password is None
    )


class HostBoundaryMiddleware:
    """Accept only loopback and explicitly discovered private-LAN Host headers."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        access_mode: Literal["local", "lan"],
        lan_hosts: frozenset[str],
        allow_test_client: bool,
    ) -> None:
        self.app = app
        self.access_mode = access_mode
        self.lan_hosts = lan_hosts
        self.allow_test_client = allow_test_client

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        host = _host_name(headers.get("host"))
        allowed = {"127.0.0.1", "localhost"}
        if self.access_mode == "lan":
            allowed.update(self.lan_hosts)
        if self.allow_test_client and host == "testserver":
            allowed.add("testserver")
        if host not in allowed:
            await _send_problem(
                scope,
                send,
                status=400,
                code="host_forbidden",
                title="Host forbidden",
                detail="This Host is not allowed to access the local web app.",
            )
            return
        await self.app(scope, receive, send)


class RemoteAccessMiddleware:
    """Require pairing, session cookies, and CSRF outside desktop loopback."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        access_mode: Literal["local", "lan"],
        remote_access: RemoteAccessService,
        allow_test_client: bool,
    ) -> None:
        self.app = app
        self.access_mode = access_mode
        self.remote_access = remote_access
        self.allow_test_client = allow_test_client

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        client_id = _client_id(scope)
        is_local = _is_loopback_client(client_id, allow_test_client=self.allow_test_client)
        scope.setdefault("state", {})["is_local_client"] = is_local
        if is_local:
            await self.app(scope, receive, send)
            return
        if self.access_mode != "lan":
            await _send_problem(
                scope,
                send,
                status=403,
                code="remote_access_disabled",
                title="Remote access disabled",
                detail=(
                    "Enable trusted LAN access from the desktop web app before pairing a device."
                ),
            )
            return
        if not _is_private_client(client_id):
            await _send_problem(
                scope,
                send,
                status=403,
                code="remote_client_forbidden",
                title="Remote client forbidden",
                detail="Only devices on a private LAN can access this web app.",
            )
            return
        path = scope["path"]
        if path.startswith("/app") or path == "/health":
            await self.app(scope, receive, send)
            return
        if path == "/api/v1/remote/pair" and scope["method"] == "POST":
            await self.app(scope, receive, send)
            return
        cookies = SimpleCookie()
        cookies.load(Headers(scope=scope).get("cookie", ""))
        session_cookie = cookies.get(REMOTE_SESSION_COOKIE)
        session_token = "" if session_cookie is None else session_cookie.value
        session = self.remote_access.authenticate(
            session_token=session_token,
            now=datetime.now(UTC),
        )
        if session is None:
            await _send_problem(
                scope,
                send,
                status=401,
                code="remote_pairing_required",
                title="Device pairing required",
                detail="Pair this device from the desktop web app before continuing.",
            )
            return
        if scope["method"] in {"POST", "PUT", "PATCH", "DELETE"}:
            csrf_cookie = cookies.get(REMOTE_CSRF_COOKIE)
            csrf_token = "" if csrf_cookie is None else csrf_cookie.value
            csrf_header = Headers(scope=scope).get(REMOTE_CSRF_HEADER, "")
            if csrf_token != csrf_header or not self.remote_access.csrf_matches(
                session=session,
                csrf_token=csrf_token,
                now=datetime.now(UTC),
            ):
                await _send_problem(
                    scope,
                    send,
                    status=403,
                    code="csrf_invalid",
                    title="CSRF validation failed",
                    detail="Refresh the paired web app and try the action again.",
                )
                return
        scope["state"]["remote_device_session"] = session
        await self.app(scope, receive, send)


def _host_name(value: str | None) -> str | None:
    if value is None or not value:
        return None
    host, separator, port = value.rpartition(":")
    if not separator:
        return value.casefold()
    if port != "8765" or not host:
        return None
    return host.casefold()


def _client_id(scope: Scope) -> str:
    client = scope.get("client")
    return "" if client is None else str(client[0])


def _is_loopback_client(client_id: str, *, allow_test_client: bool) -> bool:
    if allow_test_client and client_id == "testclient":
        return True
    try:
        return ip_address(client_id).is_loopback
    except ValueError:
        return False


def _is_private_client(client_id: str) -> bool:
    try:
        return ip_address(client_id).is_private
    except ValueError:
        return False


class RequestContextMiddleware:
    """Attach an opaque ID and log only method, path, status, and ID."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = uuid4()
        scope.setdefault("state", {})["request_id"] = request_id
        status = 500

        async def send_with_status(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_with_status)
        finally:
            logger.info(
                "request_id=%s method=%s path=%s status=%s",
                request_id,
                scope["method"],
                scope["path"],
                status,
            )


class RequestSizeLimitMiddleware:
    """Reject declared or streamed request bodies over a fixed byte limit."""

    def __init__(self, app: ASGIApp, *, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        content_length = Headers(scope=scope).get("content-length")
        if content_length and content_length.isdigit() and int(content_length) > self.max_bytes:
            await self._reject(scope, send)
            return
        if scope["method"] not in {"POST", "PUT", "PATCH"}:
            await self.app(scope, receive, send)
            return

        buffered: list[Message] = []
        received = 0
        while True:
            message = await receive()
            buffered.append(message)
            if message["type"] == "http.disconnect":
                break
            if message["type"] != "http.request":
                continue
            received += len(message.get("body", b""))
            if received > self.max_bytes:
                await self._reject(scope, send)
                return
            if not message.get("more_body", False):
                break

        position = 0

        async def replay_receive() -> Message:
            nonlocal position
            if position < len(buffered):
                message = buffered[position]
                position += 1
                return message
            return await receive()

        await self.app(scope, replay_receive, send)

    async def _reject(self, scope: Scope, send: Send) -> None:
        await _send_problem(
            scope,
            send,
            status=413,
            code="payload_too_large",
            title="Payload too large",
            detail="The request body exceeds the configured size limit.",
        )


async def _send_problem(
    scope: Scope,
    send: Send,
    *,
    status: int,
    code: str,
    title: str,
    detail: str,
) -> None:
    request_id = scope.get("state", {}).get("request_id", uuid4())
    problem = ProblemDetails(
        type="about:blank",
        title=title,
        status=status,
        detail=detail,
        code=code,
        request_id=request_id,
    )
    payload = problem.model_dump_json(exclude_none=True).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/problem+json"),
                (b"content-length", str(len(payload)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})
