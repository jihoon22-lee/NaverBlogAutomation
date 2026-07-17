"""FastAPI application composition for the local recommendation API."""

from __future__ import annotations

import asyncio
import logging
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from importlib.resources import as_file, files
from pathlib import Path
from typing import Annotated, Any, Final, Literal, cast
from urllib.parse import urlsplit
from uuid import UUID

import yaml
from alembic import command
from alembic.config import Config
from fastapi import FastAPI, Header, Request, Response
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from naver_blog_assistant.api.errors import (
    ApiError,
    api_error_handler,
    problem_response,
    validation_error_handler,
)
from naver_blog_assistant.api.middleware import (
    ExactCorsMiddleware,
    RequestContextMiddleware,
    RequestSizeLimitMiddleware,
)
from naver_blog_assistant.api.models import (
    CreateRecommendationRequest,
    HealthResponse,
    ProblemDetails,
    RecommendationResponse,
    ReviewRecommendationRequest,
)
from naver_blog_assistant.api.rate_limit import LocalRateLimiter
from naver_blog_assistant.application import (
    ConcurrentReviewError,
    GenerateRecommendation,
    GenerationInProgressError,
    GenerationRateLimitedError,
    GenerationRefusedError,
    GenerationResult,
    GenerationUnavailableError,
    GetRecommendation,
    IdempotencyConflictError,
    RecommendationNotFoundError,
    ReviewRecommendation,
)
from naver_blog_assistant.domain import (
    CandidateSelectionError,
    CapturedPost,
    DomainValidationError,
    GenerationOutput,
    ReviewPatch,
    ReviewTransitionError,
)
from naver_blog_assistant.infrastructure.database import create_sqlite_engine
from naver_blog_assistant.infrastructure.database.repositories import SqliteRepository
from naver_blog_assistant.infrastructure.generators import DeterministicFakeGenerator
from naver_blog_assistant.ports import CommentGenerator, GenerationNotStartedError

SUPPORTED_HOSTS: Final = frozenset({"blog.naver.com", "m.blog.naver.com"})
EXTENSION_ORIGIN_PATTERN: Final = re.compile(r"chrome-extension://[a-p]{32}\Z")
DEFAULT_DATABASE_URL: Final = "sqlite:///data/naver_blog_assistant.db"
logger = logging.getLogger("naver_blog_assistant.api")

IDEMPOTENCY_REPLAYED_HEADER: Final = {
    "description": "True when returning a stored result for a repeated request.",
    "schema": {"type": "boolean"},
}


def _problem_metadata(description: str) -> dict[str, Any]:
    return {
        "model": ProblemDetails,
        "description": description,
        "content": {
            "application/problem+json": {"schema": {"$ref": "#/components/schemas/ProblemDetails"}}
        },
    }


def _recommendation_metadata(description: str) -> dict[str, Any]:
    return {
        "model": RecommendationResponse,
        "description": description,
        "headers": {"Idempotency-Replayed": IDEMPOTENCY_REPLAYED_HEADER},
    }


class ContractFastAPI(FastAPI):
    """Expose the checked-in OpenAPI document as the runtime contract."""

    def openapi(self) -> dict[str, Any]:
        if self.openapi_schema is None:
            packaged = files("naver_blog_assistant.api").joinpath("openapi.yaml")
            if packaged.is_file():
                contract_text = packaged.read_text(encoding="utf-8")
            else:
                contract_path = Path(__file__).resolve().parents[3] / "docs/api/openapi.yaml"
                contract_text = contract_path.read_text(encoding="utf-8")
            loaded = yaml.safe_load(contract_text)
            if not isinstance(loaded, dict):
                raise RuntimeError("the checked-in OpenAPI contract must be an object")
            self.openapi_schema = cast(dict[str, Any], loaded)
        return self.openapi_schema


@dataclass(frozen=True, slots=True)
class ApiSettings:
    """Non-secret local API settings, validated before opening a socket."""

    extension_origin: str
    database_url: str = DEFAULT_DATABASE_URL
    generator_mode: Literal["openai", "fake"] = "openai"
    app_environment: Literal["production", "development", "test"] = "production"
    openai_api_key: str = field(default="", repr=False)
    max_request_bytes: int = 512_000
    generation_timeout_seconds: float = 45.0
    rate_limit_requests: int = 10
    rate_limit_window_seconds: float = 60.0

    def __post_init__(self) -> None:
        if not EXTENSION_ORIGIN_PATTERN.fullmatch(self.extension_origin):
            raise ValueError("CHROME_EXTENSION_ORIGIN must contain one valid Chrome extension ID")
        if self.generator_mode == "fake" and self.app_environment == "production":
            raise ValueError("the fake generator is forbidden in production")
        if self.generator_mode == "openai" and not self.openai_api_key.strip():
            raise ValueError("OPENAI_API_KEY is required for the openai generator")
        if self.max_request_bytes < 1 or self.generation_timeout_seconds <= 0:
            raise ValueError("request and timeout limits must be positive")

    @classmethod
    def from_environment(cls) -> ApiSettings:
        """Load API settings without silently enabling the fake generator."""
        mode = os.getenv("COMMENT_GENERATOR_MODE", "openai").strip().lower()
        environment = os.getenv("APP_ENV", "production").strip().lower()
        if mode not in {"openai", "fake"}:
            raise ValueError("COMMENT_GENERATOR_MODE must be openai or fake")
        if environment not in {"production", "development", "test"}:
            raise ValueError("APP_ENV must be production, development, or test")
        return cls(
            extension_origin=os.getenv("CHROME_EXTENSION_ORIGIN", "").strip(),
            database_url=os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL).strip(),
            generator_mode=cast(Literal["openai", "fake"], mode),
            app_environment=cast(Literal["production", "development", "test"], environment),
            openai_api_key=os.getenv("OPENAI_API_KEY", "").strip(),
            max_request_bytes=int(os.getenv("MAX_REQUEST_BYTES", "512000")),
            generation_timeout_seconds=float(os.getenv("GENERATION_TIMEOUT_SECONDS", "45")),
            rate_limit_requests=int(os.getenv("RATE_LIMIT_REQUESTS", "10")),
            rate_limit_window_seconds=float(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60")),
        )


def create_app(
    settings: ApiSettings,
    *,
    generator: CommentGenerator | None = None,
    run_migrations: bool = True,
) -> FastAPI:
    """Compose transport, use cases, persistence, and an explicit generator adapter."""
    if run_migrations:
        upgrade_database(settings.database_url)
    engine = create_sqlite_engine(settings.database_url)
    repository = SqliteRepository(engine)
    selected_generator = generator or _configured_generator(settings)
    limiter = LocalRateLimiter(
        requests=settings.rate_limit_requests,
        window_seconds=settings.rate_limit_window_seconds,
    )
    rate_limited_generator = _LocallyRateLimitedGenerator(selected_generator, limiter)
    generate = GenerateRecommendation(generator=rate_limited_generator, idempotency=repository)
    get = GetRecommendation(repository)
    review = ReviewRecommendation(repository)
    pending_generations: set[asyncio.Task[GenerationResult]] = set()

    def finish_generation_task(task: asyncio.Task[GenerationResult]) -> None:
        pending_generations.discard(task)
        if not task.cancelled():
            task.exception()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            if pending_generations:
                await asyncio.gather(*pending_generations, return_exceptions=True)
            engine.dispose()

    app = ContractFastAPI(
        title="Naver Blog Assistant Local API",
        version="1.0.0",
        description="Loopback-only API for human-reviewed comment recommendations.",
        lifespan=lifespan,
    )
    app.state.database_engine = engine
    app.add_middleware(RequestSizeLimitMiddleware, max_bytes=settings.max_request_bytes)
    app.add_middleware(ExactCorsMiddleware, allowed_origin=settings.extension_origin)
    app.add_middleware(RequestContextMiddleware)

    async def handle_api_error(request: Request, error: Exception) -> Response:
        assert isinstance(error, ApiError)
        return await api_error_handler(request, error)

    async def handle_validation_error(request: Request, error: Exception) -> Response:
        assert isinstance(error, RequestValidationError)
        return await validation_error_handler(request, error)

    async def handle_http_error(request: Request, error: Exception) -> Response:
        assert isinstance(error, StarletteHTTPException)
        descriptions = {
            404: (
                "route_not_found",
                "Route not found",
                "The requested local API route does not exist.",
            ),
            405: (
                "method_not_allowed",
                "Method not allowed",
                "The HTTP method is not allowed for this local API route.",
            ),
        }
        code, title, detail = descriptions.get(
            error.status_code,
            ("http_error", "HTTP error", "The local API rejected the HTTP request."),
        )
        return problem_response(
            request,
            status=error.status_code,
            code=code,
            title=title,
            detail=detail,
            headers=dict(error.headers or {}),
        )

    app.add_exception_handler(ApiError, handle_api_error)
    app.add_exception_handler(RequestValidationError, handle_validation_error)
    app.add_exception_handler(StarletteHTTPException, handle_http_error)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, _: Exception) -> Response:
        logger.error("unhandled_error request_id=%s", request.state.request_id)
        return problem_response(
            request,
            status=500,
            code="internal_error",
            title="Internal error",
            detail="The local service could not complete the request.",
        )

    @app.get(
        "/health",
        response_model=HealthResponse,
        responses={400: _problem_metadata("The HTTP request is malformed.")},
        tags=["System"],
        operation_id="getHealth",
    )
    def health() -> HealthResponse:
        return HealthResponse()

    @app.post(
        "/api/v1/recommendations",
        response_model=RecommendationResponse,
        status_code=201,
        responses={
            200: _recommendation_metadata("Stored response replayed."),
            201: _recommendation_metadata("Recommendation generated and stored."),
            409: _problem_metadata("Idempotency or processing conflict."),
            413: _problem_metadata("Request body is too large."),
            422: _problem_metadata("Request validation failed."),
            429: _problem_metadata("Generation was rate limited."),
            502: _problem_metadata("Generation was refused or invalid."),
            503: _problem_metadata("Generation dependency is unavailable."),
            504: _problem_metadata("Generation timed out."),
        },
        tags=["Recommendations"],
        operation_id="createRecommendation",
    )
    async def create_recommendation(
        payload: CreateRecommendationRequest,
        response: Response,
        idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
    ) -> RecommendationResponse:
        _validate_source_url(payload.source_url)
        post = CapturedPost(
            source_url=payload.source_url,
            title=payload.title,
            body=payload.body,
        )
        try:
            generation_task = asyncio.create_task(
                asyncio.to_thread(
                    generate.execute,
                    post=post,
                    idempotency_key=idempotency_key,
                )
            )
            pending_generations.add(generation_task)
            generation_task.add_done_callback(finish_generation_task)
            async with asyncio.timeout(settings.generation_timeout_seconds):
                result = await asyncio.shield(generation_task)
        except TimeoutError as error:
            raise ApiError(
                504,
                "generation_timeout",
                "Generation timed out",
                "Comment generation did not finish before the local timeout.",
            ) from error
        except IdempotencyConflictError as error:
            raise ApiError(
                409,
                "idempotency_conflict",
                "Idempotency conflict",
                "The idempotency key was already used for different content.",
            ) from error
        except GenerationInProgressError as error:
            raise ApiError(
                409,
                "generation_in_progress",
                "Generation in progress",
                "A request with this idempotency key is already being processed.",
            ) from error
        except GenerationRateLimitedError as error:
            raise ApiError(
                429,
                "generation_rate_limited",
                "Generation rate limited",
                "Comment generation is temporarily rate limited.",
                error.retry_after,
            ) from error
        except GenerationRefusedError as error:
            raise ApiError(
                502,
                "generation_refused",
                "Generation refused",
                "The generator could not safely create comment candidates.",
            ) from error
        except GenerationUnavailableError as error:
            raise ApiError(
                503,
                "generation_unavailable",
                "Generation unavailable",
                "Comment generation is temporarily unavailable.",
            ) from error
        except GenerationNotStartedError as error:
            raise ApiError(
                503,
                "generation_unavailable",
                "Generation unavailable",
                "Comment generation is temporarily unavailable.",
            ) from error
        except DomainValidationError as error:
            raise ApiError(
                502,
                "generation_invalid",
                "Invalid generation result",
                "The generator returned candidates that did not satisfy the contract.",
            ) from error
        response.status_code = 200 if result.replayed else 201
        response.headers["Idempotency-Replayed"] = str(result.replayed).lower()
        return RecommendationResponse.from_domain(result.recommendation)

    @app.get(
        "/api/v1/recommendations/{recommendation_id}",
        response_model=RecommendationResponse,
        responses={
            404: _problem_metadata("Recommendation was not found."),
            422: _problem_metadata("Recommendation ID is invalid."),
        },
        tags=["Recommendations"],
        operation_id="getRecommendation",
    )
    def get_recommendation(recommendation_id: UUID) -> RecommendationResponse:
        try:
            result = get.execute(recommendation_id)
        except RecommendationNotFoundError as error:
            raise _not_found() from error
        return RecommendationResponse.from_domain(result)

    @app.patch(
        "/api/v1/recommendations/{recommendation_id}",
        response_model=RecommendationResponse,
        responses={
            404: _problem_metadata("Recommendation was not found."),
            409: _problem_metadata("Review conflicts with stored state."),
            422: _problem_metadata("Review request is invalid."),
        },
        tags=["Recommendations"],
        operation_id="reviewRecommendation",
    )
    def review_recommendation(
        recommendation_id: UUID,
        payload: ReviewRecommendationRequest,
    ) -> RecommendationResponse:
        try:
            fields = payload.model_fields_set
            patch = ReviewPatch(
                selected_candidate_id=(
                    payload.selected_candidate_id
                    if "selected_candidate_id" in fields
                    and payload.selected_candidate_id is not None
                    else None
                ),
                clear_selection=(
                    "selected_candidate_id" in fields and payload.selected_candidate_id is None
                ),
                edited_comment=(
                    payload.edited_comment
                    if "edited_comment" in fields and payload.edited_comment is not None
                    else None
                ),
                clear_edited_comment=(
                    "edited_comment" in fields and payload.edited_comment is None
                ),
                review_status=payload.review_status,
            )
            result = review.execute(recommendation_id, patch)
        except RecommendationNotFoundError as error:
            raise _not_found() from error
        except (CandidateSelectionError, ReviewTransitionError, ConcurrentReviewError) as error:
            raise ApiError(
                409,
                "review_conflict",
                "Review conflict",
                "The requested review change conflicts with the stored recommendation.",
            ) from error
        except DomainValidationError as error:
            raise ApiError(
                422,
                "invalid_review",
                "Invalid review",
                "The review update is invalid.",
            ) from error
        return RecommendationResponse.from_domain(result)

    return app


def upgrade_database(database_url: str) -> None:
    """Apply committed Alembic migrations to the configured SQLite database."""
    migrations = files("naver_blog_assistant.infrastructure.database.migrations")
    with as_file(migrations) as migration_path:
        config = Config()
        config.set_main_option("script_location", str(migration_path))
        config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
        command.upgrade(config, "head")


def _configured_generator(settings: ApiSettings) -> CommentGenerator:
    if settings.generator_mode == "fake":
        return DeterministicFakeGenerator()
    raise RuntimeError(
        "The OpenAI generator is not implemented yet; set COMMENT_GENERATOR_MODE=fake "
        "with APP_ENV=development for local API development."
    )


def _validate_source_url(value: str) -> None:
    if any(
        character.isspace() or ord(character) < 0x20 or ord(character) == 0x7F
        for character in value
    ):
        raise _unsupported_url()
    if re.search(r"%(?![0-9A-Fa-f]{2})", value):
        raise _unsupported_url()
    if re.search(r"%(?:0[0-9A-Fa-f]|1[0-9A-Fa-f]|20|7[Ff])", value):
        raise _unsupported_url()
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise _unsupported_url() from error
    if (
        parsed.scheme != "https"
        or parsed.hostname not in SUPPORTED_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
        or not parsed.path.startswith("/")
    ):
        raise _unsupported_url()


def _unsupported_url() -> ApiError:
    return ApiError(
        422,
        "unsupported_source_url",
        "Unsupported blog URL",
        "Only supported Naver Blog HTTPS URLs can be processed.",
    )


def _not_found() -> ApiError:
    return ApiError(
        404,
        "recommendation_not_found",
        "Recommendation not found",
        "The requested recommendation does not exist.",
    )


class _LocallyRateLimitedGenerator:
    """Limit only calls that reach generation, so idempotent replays stay available."""

    def __init__(self, generator: CommentGenerator, limiter: LocalRateLimiter) -> None:
        self._generator = generator
        self._limiter = limiter

    def generate(self, post: CapturedPost) -> GenerationOutput:
        retry_after = self._limiter.acquire()
        if retry_after is not None:
            raise _LocalRateLimitError(retry_after)
        return self._generator.generate(post)


class _LocalRateLimitError(GenerationRateLimitedError, GenerationNotStartedError):
    """Signal a safe-to-release local rejection before provider work starts."""
