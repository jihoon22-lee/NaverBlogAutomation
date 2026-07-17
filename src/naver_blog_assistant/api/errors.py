"""Safe HTTP error mapping for the local API."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID, uuid4

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from naver_blog_assistant.api.models import FieldError, ProblemDetails

PROBLEM_MEDIA_TYPE = "application/problem+json"


@dataclass(slots=True)
class ApiError(Exception):
    """An expected transport error with a stable machine-readable code."""

    status: int
    code: str
    title: str
    detail: str
    retry_after: int | None = None
    idempotency_replayed: bool = False


def request_id(request: Request) -> UUID:
    """Return middleware-provided request identity, with a defensive fallback."""
    value = getattr(request.state, "request_id", None)
    return value if isinstance(value, UUID) else uuid4()


def problem_response(
    request: Request,
    *,
    status: int,
    code: str,
    title: str,
    detail: str,
    errors: list[FieldError] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    problem = ProblemDetails(
        type="about:blank",
        title=title,
        status=status,
        detail=detail,
        code=code,
        request_id=request_id(request),
        errors=errors,
    )
    return JSONResponse(
        status_code=status,
        content=problem.model_dump(mode="json", exclude_none=True),
        media_type=PROBLEM_MEDIA_TYPE,
        headers=headers,
    )


async def api_error_handler(request: Request, error: ApiError) -> JSONResponse:
    headers: dict[str, str] = {}
    if error.retry_after is not None:
        headers["Retry-After"] = str(error.retry_after)
    if error.idempotency_replayed:
        headers["Idempotency-Replayed"] = "true"
    return problem_response(
        request,
        status=error.status,
        code=error.code,
        title=error.title,
        detail=error.detail,
        headers=headers or None,
    )


async def validation_error_handler(request: Request, error: RequestValidationError) -> JSONResponse:
    fields = [
        FieldError(
            field=".".join(str(part) for part in item["loc"] if part != "body"),
            message=str(item["msg"]),
        )
        for item in error.errors()
    ]
    return problem_response(
        request,
        status=422,
        code="invalid_request",
        title="Invalid request",
        detail="The request does not match the API contract.",
        errors=fields,
    )
