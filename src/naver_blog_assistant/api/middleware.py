"""Privacy-preserving request identity, logging, and size controls."""

from __future__ import annotations

import logging
from uuid import uuid4

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from naver_blog_assistant.api.models import ProblemDetails

logger = logging.getLogger("naver_blog_assistant.api")
ALLOWED_CORS_METHODS = frozenset({"GET", "POST", "PATCH"})
ALLOWED_CORS_HEADERS = frozenset({"content-type", "idempotency-key"})


class ExactCorsMiddleware:
    """Allow one extension origin and reject every other browser origin safely."""

    def __init__(self, app: ASGIApp, *, allowed_origin: str) -> None:
        self.app = app
        self.allowed_origin = allowed_origin

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        origin = headers.get("origin")
        if origin is None:
            await self.app(scope, receive, send)
            return
        if origin != self.allowed_origin:
            await _send_problem(
                scope,
                send,
                status=403,
                code="cors_origin_forbidden",
                title="Origin forbidden",
                detail="This browser origin is not allowed to access the local API.",
            )
            return
        if scope["method"] == "OPTIONS":
            await self._preflight(scope, headers, send)
            return

        async def send_with_cors(message: Message) -> None:
            if message["type"] == "http.response.start":
                mutable_headers = list(message.get("headers", []))
                mutable_headers.extend(
                    (
                        (b"access-control-allow-origin", self.allowed_origin.encode()),
                        (b"vary", b"Origin"),
                    )
                )
                message["headers"] = mutable_headers
            await send(message)

        await self.app(scope, receive, send_with_cors)

    async def _preflight(self, scope: Scope, headers: Headers, send: Send) -> None:
        method = headers.get("access-control-request-method", "")
        requested_headers = {
            value.strip().lower()
            for value in headers.get("access-control-request-headers", "").split(",")
            if value.strip()
        }
        if method not in ALLOWED_CORS_METHODS or not requested_headers <= ALLOWED_CORS_HEADERS:
            await _send_problem(
                scope,
                send,
                status=403,
                code="cors_request_forbidden",
                title="CORS request forbidden",
                detail="The requested browser method or headers are not allowed.",
            )
            return
        response_headers = [
            (b"access-control-allow-origin", self.allowed_origin.encode()),
            (b"access-control-allow-methods", b"GET, POST, PATCH"),
            (b"access-control-allow-headers", b"Content-Type, Idempotency-Key"),
            (b"vary", b"Origin"),
            (b"content-length", b"0"),
        ]
        await send({"type": "http.response.start", "status": 200, "headers": response_headers})
        await send({"type": "http.response.body", "body": b""})


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
