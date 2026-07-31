"""FastAPI application composition for the local recommendation API."""

from __future__ import annotations

import asyncio
import logging
import math
import os
import re
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from importlib.resources import as_file, files
from pathlib import Path
from typing import Annotated, Any, Final, Literal, cast
from urllib.parse import urlsplit
from uuid import UUID

import yaml
from alembic import command
from alembic.config import Config
from fastapi import FastAPI, Header, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from sqlalchemy.engine import make_url
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
    AutomaticDiscoverySettingsRequest,
    AutomaticDiscoverySettingsResponse,
    AutomaticDiscoverySyncResponse,
    CreateRecommendationRequest,
    DigestSettingsRequest,
    DigestSettingsResponse,
    DiscoveryImportRequest,
    DiscoveryImportResponse,
    DiscoveryPostResponse,
    DiscoveryPostStateRequest,
    DiscoveryQueueResponse,
    DiscoverySearchRefreshResponse,
    EngagementRunListResponse,
    EngagementRunResponse,
    EngagementRunStartRequest,
    EngagementStepTransitionRequest,
    HealthResponse,
    ManualEngagementCompletionRequest,
    NeighborListResponse,
    NeighborRequest,
    NeighborResponse,
    ProblemDetails,
    RecommendationHistoryItemResponse,
    RecommendationHistoryResponse,
    RecommendationResponse,
    ReviewRecommendationRequest,
    SavedSearchListResponse,
    SavedSearchRequest,
    SavedSearchResponse,
    ServiceStatusResponse,
)
from naver_blog_assistant.api.rate_limit import LocalRateLimiter
from naver_blog_assistant.api.routers import (
    register_app_mount,
    register_automation_session_routes,
    register_blog_routes,
    register_comment_routes,
    register_draft_routes,
    register_engagement_routes,
    register_llm_routes,
    register_session_routes,
    register_settings_routes,
    register_staging_routes,
)
from naver_blog_assistant.application import (
    ClearPersonalizationExamples,
    ConcurrentReviewError,
    DeleteRecommendation,
    GenerateRecommendation,
    GenerationIndeterminateError,
    GenerationInProgressError,
    GenerationInvalidError,
    GenerationRateLimitedError,
    GenerationRefusedError,
    GenerationResult,
    GenerationUnavailableError,
    GetRecommendation,
    IdempotencyConflictError,
    ListRecommendations,
    RecommendationNotFoundError,
    ReplayedGenerationFailure,
    ReviewRecommendation,
)
from naver_blog_assistant.application.automation import (
    BrowserSessionManager,
    CollectReferencePosts,
    EngagementRunService,
    ExecuteEngagement,
    ExtractArticle,
    GenerationKeyRegistry,
    PlanGeneration,
    RunSession,
    SessionPostRunner,
    StagePost,
    StagePostService,
)
from naver_blog_assistant.application.discovery import (
    SmtpDigestSender,
    buddy_list_url,
    fetch_naver_blog_search,
    fetch_public_html,
    fetch_rss_posts,
    filter_saved_search_posts,
    parse_buddy_list,
    rss_url_for,
    saved_search_title_matches,
)
from naver_blog_assistant.application.llm import CallBudget, FanOutGeneration
from naver_blog_assistant.application.settings import ReadAppSetting, SaveAppSetting
from naver_blog_assistant.application.writing import ComposePost, ReferenceBody
from naver_blog_assistant.domain import (
    AppSettingKind,
    CandidateSelectionError,
    CapturedPost,
    DiscoverySource,
    DiscoveryState,
    DomainValidationError,
    EngagementStepName,
    GenerationOutput,
    GenerationPreferences,
    ImportedDiscoveryPost,
    ReviewPatch,
    ReviewTransitionError,
    SavedSearch,
)
from naver_blog_assistant.domain.llm import LlmProvider
from naver_blog_assistant.infrastructure.browser import (
    SUPPORTED_DRIVERS,
    create_browser_driver,
    resolve_profile_dir,
)
from naver_blog_assistant.infrastructure.database import (
    SqliteDiscoveryRepository,
    SqliteEngagementRepository,
    create_sqlite_engine,
)
from naver_blog_assistant.infrastructure.database.app_settings_repository import (
    SqliteAppSettingsRepository,
)
from naver_blog_assistant.infrastructure.database.blog_catalog_repository import (
    SqliteBlogCatalogRepository,
)
from naver_blog_assistant.infrastructure.database.llm_attempt_repository import (
    SqliteLlmAttemptRepository,
)
from naver_blog_assistant.infrastructure.database.post_draft_repository import (
    SqlitePostDraftRepository,
)
from naver_blog_assistant.infrastructure.database.publish_run_repository import (
    SqlitePublishRunRepository,
)
from naver_blog_assistant.infrastructure.database.repositories import SqliteRepository
from naver_blog_assistant.infrastructure.database.session_repository import (
    SqliteSessionRepository,
)
from naver_blog_assistant.infrastructure.generators import DeterministicFakeGenerator
from naver_blog_assistant.infrastructure.generators.provider_comment import (
    ProviderCommentGenerator,
)
from naver_blog_assistant.infrastructure.llm import ProviderRegistry
from naver_blog_assistant.infrastructure.storage import DraftImageStore
from naver_blog_assistant.ports import CommentGenerator, GenerationNotStartedError
from naver_blog_assistant.ports.browser import BrowserDriver

SUPPORTED_HOSTS: Final = frozenset({"blog.naver.com", "m.blog.naver.com"})
EXTENSION_ORIGIN_PATTERN: Final = re.compile(r"chrome-extension://[a-p]{32}\Z")
DEFAULT_DATABASE_URL: Final = "sqlite:///data/naver_blog_assistant.db"
logger = logging.getLogger("naver_blog_assistant.api")


class SearchProviderNotConfiguredError(ValueError):
    """Raised when a saved search is used without the documented API credentials."""


IDEMPOTENCY_REPLAYED_HEADER: Final = {
    "description": "True when returning a stored result for a repeated request.",
    "schema": {"type": "boolean"},
}
ENGAGEMENT_REPLAYED_HEADER: Final = {
    "description": "True when returning an existing engagement run.",
    "schema": {"type": "boolean"},
}


def _environment_int(name: str, default: str) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        raise ValueError(f"{name} must be an integer") from None


def _environment_float(name: str, default: str) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        raise ValueError(f"{name} must be a number") from None


def _environment_bool(name: str, default: str) -> bool:
    value = os.getenv(name, default).strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean flag")


def _problem_metadata(
    description: str,
    *,
    idempotency_replayed: bool = False,
    retry_after: bool = False,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "model": ProblemDetails,
        "description": description,
        "content": {
            "application/problem+json": {"schema": {"$ref": "#/components/schemas/ProblemDetails"}}
        },
    }
    headers: dict[str, Any] = {}
    if idempotency_replayed:
        headers["Idempotency-Replayed"] = IDEMPOTENCY_REPLAYED_HEADER
    if retry_after:
        headers["Retry-After"] = {
            "description": "Seconds before a definitely rejected request may be retried.",
            "schema": {"type": "integer", "minimum": 0},
        }
    if headers:
        metadata["headers"] = headers
    return metadata


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
    openai_model: str = "gpt-5.6-terra"
    openai_reasoning_effort: Literal["low", "medium", "high"] = "low"
    openai_timeout_seconds: float = 35.0
    openai_max_output_tokens: int = 3_000
    rate_limit_requests: int = 10
    rate_limit_window_seconds: float = 60.0
    digest_smtp_host: str = ""
    digest_smtp_port: int = 587
    digest_smtp_security: Literal["starttls", "ssl"] = "starttls"
    digest_smtp_username: str = field(default="", repr=False)
    digest_smtp_password: str = field(default="", repr=False)
    digest_email_from: str = ""
    digest_email_to: str = ""
    naver_search_client_id: str = field(default="", repr=False)
    naver_search_client_secret: str = field(default="", repr=False)
    gemini_api_key: str = field(default="", repr=False)
    gemini_model: str = "gemini-3.6-flash"
    anthropic_api_key: str = field(default="", repr=False)
    anthropic_model: str = "claude-sonnet-5-20260514"
    automation_driver: str = "patchright"
    automation_headless: bool = False
    automation_profile_dir: str = ""
    automation_browser_channel: str = "chrome"
    draft_media_dir: str = ""

    def __post_init__(self) -> None:
        try:
            database_backend = make_url(self.database_url).get_backend_name()
        except Exception:
            raise ValueError("DATABASE_URL must be a valid SQLite URL") from None
        if database_backend != "sqlite":
            raise ValueError("DATABASE_URL must use the local SQLite adapter")
        if not EXTENSION_ORIGIN_PATTERN.fullmatch(self.extension_origin):
            raise ValueError("CHROME_EXTENSION_ORIGIN must contain one valid Chrome extension ID")
        if self.generator_mode == "fake" and self.app_environment == "production":
            raise ValueError("the fake generator is forbidden in production")
        if self.generator_mode == "openai" and not self.openai_api_key.strip():
            raise ValueError("OPENAI_API_KEY is required for the openai generator")
        if (
            self.max_request_bytes < 1
            or not math.isfinite(self.generation_timeout_seconds)
            or self.generation_timeout_seconds <= 0
        ):
            raise ValueError("request and timeout limits must be positive")
        if not math.isfinite(self.openai_timeout_seconds) or self.openai_timeout_seconds <= 0:
            raise ValueError("OPENAI_TIMEOUT_SECONDS must be a positive finite number")
        if (
            self.generator_mode == "openai"
            and self.openai_timeout_seconds >= self.generation_timeout_seconds
        ):
            raise ValueError("OPENAI_TIMEOUT_SECONDS must be below GENERATION_TIMEOUT_SECONDS")
        if self.openai_max_output_tokens < 1 or not self.openai_model.strip():
            raise ValueError("OpenAI model and output token settings must be valid")
        if self.openai_reasoning_effort not in {"low", "medium", "high"}:
            raise ValueError("OPENAI_REASONING_EFFORT must be low, medium, or high")
        if (
            self.rate_limit_requests < 1
            or not math.isfinite(self.rate_limit_window_seconds)
            or self.rate_limit_window_seconds <= 0
        ):
            raise ValueError("RATE_LIMIT_REQUESTS and RATE_LIMIT_WINDOW_SECONDS must be positive")
        smtp_values = (
            self.digest_smtp_host,
            self.digest_smtp_username,
            self.digest_smtp_password,
            self.digest_email_from,
            self.digest_email_to,
        )
        if any(value.strip() for value in smtp_values) and not all(
            value.strip() for value in smtp_values
        ):
            raise ValueError("digest SMTP settings must be configured together")
        if not 1 <= self.digest_smtp_port <= 65535:
            raise ValueError("DIGEST_SMTP_PORT must be between 1 and 65535")
        if self.digest_smtp_security not in {"starttls", "ssl"}:
            raise ValueError("DIGEST_SMTP_SECURITY must be starttls or ssl")
        configured_search_values = (
            self.naver_search_client_id.strip(),
            self.naver_search_client_secret.strip(),
        )
        if any(configured_search_values) and not all(configured_search_values):
            raise ValueError(
                "NAVER_SEARCH_CLIENT_ID and NAVER_SEARCH_CLIENT_SECRET must be configured together"
            )
        if any(len(value) > 200 for value in configured_search_values):
            raise ValueError("Naver Search API credentials must not exceed 200 characters")
        if self.automation_driver not in SUPPORTED_DRIVERS:
            raise ValueError("AUTOMATION_DRIVER must be patchright, playwright, or fake")
        if self.automation_driver == "fake" and self.app_environment == "production":
            raise ValueError("the fake browser driver is forbidden in production")
        if len(self.automation_profile_dir) > 1024:
            raise ValueError("AUTOMATION_PROFILE_DIR must not exceed 1024 characters")
        if len(self.automation_browser_channel) > 32:
            raise ValueError("AUTOMATION_BROWSER_CHANNEL must not exceed 32 characters")

    @classmethod
    def from_environment(cls) -> ApiSettings:
        """Load API settings without silently enabling the fake generator."""
        return cls._from_environment(openai_api_key=os.getenv("OPENAI_API_KEY", "").strip())

    @classmethod
    def validate_environment_without_secrets(cls) -> None:
        """Validate setup while reducing the API key immediately to a configured flag."""
        configured = bool(os.getenv("OPENAI_API_KEY", "").strip())
        placeholder = "configured" if configured else ""
        cls._from_environment(openai_api_key=placeholder)

    @classmethod
    def _from_environment(cls, *, openai_api_key: str) -> ApiSettings:
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
            openai_api_key=openai_api_key,
            max_request_bytes=_environment_int("MAX_REQUEST_BYTES", "512000"),
            generation_timeout_seconds=_environment_float("GENERATION_TIMEOUT_SECONDS", "45"),
            openai_model=os.getenv("OPENAI_MODEL", "gpt-5.6-terra").strip(),
            openai_reasoning_effort=cast(
                Literal["low", "medium", "high"],
                os.getenv("OPENAI_REASONING_EFFORT", "low").strip().lower(),
            ),
            openai_timeout_seconds=_environment_float("OPENAI_TIMEOUT_SECONDS", "35"),
            openai_max_output_tokens=_environment_int("OPENAI_MAX_OUTPUT_TOKENS", "3000"),
            rate_limit_requests=_environment_int("RATE_LIMIT_REQUESTS", "10"),
            rate_limit_window_seconds=_environment_float("RATE_LIMIT_WINDOW_SECONDS", "60"),
            digest_smtp_host=os.getenv("DIGEST_SMTP_HOST", "").strip(),
            digest_smtp_port=_environment_int("DIGEST_SMTP_PORT", "587"),
            digest_smtp_security=cast(
                Literal["starttls", "ssl"],
                os.getenv("DIGEST_SMTP_SECURITY", "starttls").strip().lower(),
            ),
            digest_smtp_username=os.getenv("DIGEST_SMTP_USERNAME", "").strip(),
            digest_smtp_password=os.getenv("DIGEST_SMTP_PASSWORD", "").strip(),
            digest_email_from=os.getenv("DIGEST_EMAIL_FROM", "").strip(),
            digest_email_to=os.getenv("DIGEST_EMAIL_TO", "").strip(),
            naver_search_client_id=os.getenv("NAVER_SEARCH_CLIENT_ID", "").strip(),
            naver_search_client_secret=os.getenv("NAVER_SEARCH_CLIENT_SECRET", "").strip(),
            gemini_api_key=os.getenv("GEMINI_API_KEY", "").strip(),
            gemini_model=os.getenv("GEMINI_MODEL", "gemini-3.6-flash").strip(),
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", "").strip(),
            anthropic_model=os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5-20260514").strip(),
            automation_driver=os.getenv("AUTOMATION_DRIVER", "patchright").strip().lower(),
            automation_headless=_environment_bool("AUTOMATION_HEADLESS", "false"),
            automation_profile_dir=os.getenv("AUTOMATION_PROFILE_DIR", "").strip(),
            automation_browser_channel=os.getenv("AUTOMATION_BROWSER_CHANNEL", "chrome").strip(),
            draft_media_dir=os.getenv("DRAFT_MEDIA_DIR", "").strip(),
        )


def create_app(
    settings: ApiSettings,
    *,
    generator: CommentGenerator | None = None,
    browser_driver: BrowserDriver | None = None,
    run_migrations: bool = True,
) -> FastAPI:
    """Compose transport, use cases, persistence, and an explicit generator adapter."""
    if run_migrations:
        upgrade_database(settings.database_url)
    engine = create_sqlite_engine(settings.database_url)
    repository = SqliteRepository(engine)
    discovery = SqliteDiscoveryRepository(engine)
    engagements = SqliteEngagementRepository(engine)
    provider_registry = _configured_registry(settings)
    selected_generator = generator or _configured_generator(settings)
    browser_sessions = BrowserSessionManager(
        browser_driver or create_browser_driver(settings.automation_driver),
        profile_dir=resolve_profile_dir(
            configured=settings.automation_profile_dir,
            platform=sys.platform,
            environment=os.environ,
            home=Path.home(),
        ),
        headless=settings.automation_headless,
        channel=settings.automation_browser_channel or None,
    )
    article_extractions = ExtractArticle(browser_sessions)
    app_settings_repository = SqliteAppSettingsRepository(engine)
    read_setting = ReadAppSetting(app_settings_repository)
    save_setting = SaveAppSetting(app_settings_repository)
    generation_planner = PlanGeneration(read_setting, GenerationKeyRegistry())
    limiter = LocalRateLimiter(
        requests=settings.rate_limit_requests,
        window_seconds=settings.rate_limit_window_seconds,
    )
    rate_limited_generator = _LocallyRateLimitedGenerator(selected_generator, limiter)
    generate = GenerateRecommendation(
        generator=rate_limited_generator,
        idempotency=repository,
        personalization=repository,
    )
    get = GetRecommendation(repository)
    list_recommendations = ListRecommendations(repository)
    delete_recommendation = DeleteRecommendation(repository)
    review = ReviewRecommendation(repository)
    engagement_runs_service = EngagementRunService(
        engagements=engagements,
        discovery=discovery,
        recommendations=get,
        execute=ExecuteEngagement(browser_sessions),
        read_setting=read_setting.execute,
    )

    clear_personalization_examples = ClearPersonalizationExamples(repository)
    pending_generations: set[asyncio.Task[GenerationResult]] = set()

    async def refresh_saved_search(search: SavedSearch) -> int:
        """Import one saved search exclusively through Naver's documented API."""
        if not settings.naver_search_client_id:
            raise SearchProviderNotConfiguredError(
                "NAVER_SEARCH_CLIENT_ID and NAVER_SEARCH_CLIENT_SECRET are required"
            )
        posts = await asyncio.to_thread(
            fetch_naver_blog_search,
            search.query,
            client_id=settings.naver_search_client_id,
            client_secret=settings.naver_search_client_secret,
        )

        eligible = filter_saved_search_posts(search, posts, now=datetime.now(UTC))
        excluded = discovery.excluded_search_blog_ids(
            own_blog_id=discovery.get_automatic_settings().own_blog_id
        )
        candidates = tuple(
            post
            for post in eligible
            if post.publisher_blog_id is not None
            and post.publisher_blog_id.casefold() not in excluded
        )
        return discovery.import_posts(
            source=DiscoverySource.SEARCH,
            search_id=search.id,
            posts=candidates,
        )

    async def refresh_neighbors_from_rss() -> int:
        imported_count = 0
        for neighbor in discovery.list_neighbors():
            if not neighbor.enabled:
                continue
            try:
                rss_posts = await asyncio.to_thread(fetch_rss_posts, rss_url_for(neighbor.blog_id))
                imported_count += discovery.import_posts(
                    source=DiscoverySource.NEIGHBOR,
                    neighbor_id=neighbor.id,
                    posts=tuple(
                        ImportedDiscoveryPost(
                            source_url=url,
                            title=title,
                            publisher_name=neighbor.name,
                            published_at=published_at,
                        )
                        for url, title, published_at in rss_posts
                    ),
                )
                discovery.update_neighbor_feed_status(
                    neighbor.id, status="ready", checked_at=datetime.now(UTC)
                )
            except Exception:
                logger.warning("discovery_rss_refresh_failed neighbor_id=%s", neighbor.id)
                discovery.update_neighbor_feed_status(
                    neighbor.id, status="unavailable", checked_at=datetime.now(UTC)
                )
        discovery.cleanup_old_posts()
        return imported_count

    async def synchronize_automatic_discovery() -> AutomaticDiscoverySyncResponse:
        """Refresh explicitly configured public sources without browser state or cookies."""
        automation = discovery.get_automatic_settings()
        if not automation.own_blog_id.strip():
            detail = "내 블로그 ID를 저장한 뒤 자동 탐색을 시작해 주세요."
            discovery.record_automatic_sync(status="failed", detail=detail)
            return AutomaticDiscoverySyncResponse(
                neighbors_added=0,
                neighbor_posts_added=0,
                search_posts_added=0,
                search_provider="none",
                status="failed",
                detail=detail,
            )

        failures: list[str] = []
        neighbors_added = 0
        try:
            html = await asyncio.to_thread(
                fetch_public_html, buddy_list_url(automation.own_blog_id)
            )
            before = {item.blog_id for item in discovery.list_neighbors()}
            for name, blog_id, blog_url in parse_buddy_list(html):
                discovery.save_neighbor(name=name, blog_id=blog_id, blog_url=blog_url)
            neighbors_added = len({item.blog_id for item in discovery.list_neighbors()} - before)
        except Exception:
            logger.warning("automatic_discovery_buddy_list_failed")
            failures.append("이웃 목록")

        neighbor_posts_added = await refresh_neighbors_from_rss()
        search_posts_added = 0
        search_provider_used = False
        for search in discovery.list_searches():
            if not search.enabled:
                continue
            try:
                search_posts_added += await refresh_saved_search(search)
                search_provider_used = True
            except SearchProviderNotConfiguredError:
                failures.append("네이버 검색 API 설정")
            except Exception:
                logger.warning("automatic_discovery_search_failed search_id=%s", search.id)
                failures.append("검색 결과")
        if failures and (neighbors_added or neighbor_posts_added or search_posts_added):
            status: Literal["success", "partial", "failed"] = "partial"
            detail = f"일부 수집에 실패했습니다: {', '.join(sorted(set(failures)))}"
        elif failures:
            status = "failed"
            detail = f"수집하지 못했습니다: {', '.join(sorted(set(failures)))}"
        else:
            status = "success"
            detail = (
                f"이웃 {neighbors_added}개, 이웃 새 글 {neighbor_posts_added}개, "
                f"검색 후보 {search_posts_added}개를 확인했습니다."
            )
        search_provider: Literal["naver_open_api", "none"] = (
            "naver_open_api" if search_provider_used else "none"
        )
        discovery.record_automatic_sync(status=status, detail=detail)
        return AutomaticDiscoverySyncResponse(
            neighbors_added=neighbors_added,
            neighbor_posts_added=neighbor_posts_added,
            search_posts_added=search_posts_added,
            search_provider=search_provider,
            status=status,
            detail=detail,
        )

    async def run_automatic_discovery_if_due() -> None:
        automation = discovery.get_automatic_settings()
        if not automation.enabled or not automation.own_blog_id.strip():
            return
        try:
            from zoneinfo import ZoneInfo

            local_now = datetime.now(ZoneInfo(automation.timezone))
        except Exception:
            logger.warning("automatic_discovery_invalid_timezone")
            return
        if (local_now.hour, local_now.minute) < (automation.hour, automation.minute):
            return
        if not discovery.claim_automatic_sync_run(local_now.date().isoformat()):
            return
        await synchronize_automatic_discovery()

    async def run_daily_digest_if_due() -> None:
        settings_value = discovery.get_digest_settings()
        try:
            from zoneinfo import ZoneInfo

            local_now = datetime.now(ZoneInfo(settings_value.timezone))
        except Exception:
            logger.warning("discovery_digest_invalid_timezone")
            return
        if (local_now.hour, local_now.minute) < (settings_value.hour, settings_value.minute):
            return
        await refresh_neighbors_from_rss()
        queued_posts = discovery.list_posts(DiscoverySource.NEIGHBOR)
        local_date = local_now.date().isoformat()
        if not discovery.claim_digest_run(local_date, neighbor_post_count=len(queued_posts)):
            return
        if settings_value.email_enabled and _smtp_configured(settings):
            body = _digest_email_body(queued_posts)
            try:
                await asyncio.to_thread(
                    _smtp_sender(settings).send, subject="네이버 블로그 새 글 요약", body=body
                )
            except Exception:
                logger.warning("discovery_digest_email_failed")
            else:
                discovery.mark_digest_email_sent(local_date)

    async def discovery_scheduler() -> None:
        while True:
            try:
                await run_automatic_discovery_if_due()
                await run_daily_digest_if_due()
            except Exception:
                logger.exception("discovery_scheduler_failed")
            await asyncio.sleep(60)

    def _track_generation(task: asyncio.Task[GenerationResult]) -> None:
        pending_generations.add(task)
        task.add_done_callback(finish_generation_task)

    def finish_generation_task(task: asyncio.Task[GenerationResult]) -> None:
        pending_generations.discard(task)
        if not task.cancelled():
            task.exception()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        scheduler_task = (
            asyncio.create_task(discovery_scheduler())
            if settings.app_environment != "test"
            else None
        )
        try:
            yield
        finally:
            if scheduler_task is not None:
                scheduler_task.cancel()
                await asyncio.gather(scheduler_task, return_exceptions=True)
            if pending_generations:
                await asyncio.gather(*pending_generations, return_exceptions=True)
            await engagement_runs_service.shutdown()
            await staging_service.shutdown()
            await session_batches.shutdown()
            provider_registry.close()
            await browser_sessions.shutdown()
            close = getattr(selected_generator, "close", None)
            if close is not None:
                close()
            engine.dispose()

    app = ContractFastAPI(
        title="Naver Blog Assistant Local API",
        version="1.0.0",
        description="Loopback-only API for human-reviewed comment recommendations.",
        lifespan=lifespan,
    )
    app.state.database_engine = engine
    app.state.browser_sessions = browser_sessions
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

    register_automation_session_routes(
        app,
        sessions=browser_sessions,
        problem_metadata=_problem_metadata,
        extractions=article_extractions,
    )
    blog_catalog = CollectReferencePosts(browser_sessions, SqliteBlogCatalogRepository(engine))

    def _body_tag_cap() -> int:
        """Return the configured cap for tags inserted into the body."""
        payload = read_setting.execute(AppSettingKind.WRITING_PROFILE).payload
        return int(payload["body_tag_cap"])

    def _reference_bodies(category_no: int | None, limit: int) -> tuple[ReferenceBody, ...]:
        """Return cached reference titles for one category; bodies are read at request time."""
        if category_no is None or limit < 1:
            return ()
        return tuple(
            ReferenceBody(title=post.title, body="")
            for post in blog_catalog.references(category_no, limit=limit)
        )

    def _owner_blog_id() -> str:
        """Return the configured own blog id, or an empty string before it is saved."""
        return discovery.get_automatic_settings().own_blog_id.strip()

    draft_repository = SqlitePostDraftRepository(engine)
    publish_run_repository = SqlitePublishRunRepository(engine)
    session_repository = SqliteSessionRepository(engine)
    draft_image_store = DraftImageStore(_media_root(settings))
    compose_post = ComposePost(draft_repository)
    staging_service = StagePostService(
        runs=publish_run_repository,
        drafts=draft_repository,
        stage=StagePost(browser_sessions),
        owner_blog_id=_owner_blog_id,
        media_root=_media_root(settings),
        body_tag_cap=_body_tag_cap,
    )
    attempt_repository = SqliteLlmAttemptRepository(engine)
    call_budget = CallBudget(read_setting=read_setting, attempts=attempt_repository)
    fanout_generation = _configured_fanout(
        settings=settings,
        registry=provider_registry,
        repository=repository,
        personalization=repository,
        attempts=attempt_repository,
        budget=call_budget,
    )

    register_comment_routes(
        app,
        extractions=article_extractions,
        generate=generate,
        planner=generation_planner,
        problem_metadata=_problem_metadata,
        timeout_seconds=settings.generation_timeout_seconds,
        track=_track_generation,
        fanout=fanout_generation,
        selection_for=lambda provider, model: provider_registry.selection(
            LlmProvider(provider), model
        ),
    )
    register_engagement_routes(
        app,
        runs=engagement_runs_service,
        problem_metadata=_problem_metadata,
    )
    register_llm_routes(
        app,
        availability=provider_registry.availability,
        problem_metadata=_problem_metadata,
    )
    register_blog_routes(
        app,
        catalog=blog_catalog,
        owner_blog_id=_owner_blog_id,
        problem_metadata=_problem_metadata,
    )
    session_batches = RunSession(
        sessions=session_repository,
        queue=_SessionQueue(discovery),
        runner=SessionPostRunner(
            extract=article_extractions,
            planner=generation_planner,
            generate=generate,
            review=review,
            runs=engagement_runs_service,
            read_setting=read_setting,
        ),
    )

    register_session_routes(
        app,
        sessions=session_batches,
        store=session_repository,
        problem_metadata=_problem_metadata,
    )
    register_staging_routes(
        app,
        staging=staging_service,
        problem_metadata=_problem_metadata,
    )
    register_draft_routes(
        app,
        drafts=draft_repository,
        compose=compose_post,
        images=draft_image_store,
        references=_reference_bodies,
        client_for=provider_registry.client,
        problem_metadata=_problem_metadata,
    )
    register_settings_routes(
        app,
        read_setting=read_setting,
        save_setting=save_setting,
        problem_metadata=_problem_metadata,
    )
    if not register_app_mount(app):
        logger.info("web_app_assets_missing run `npm --prefix client run build`")

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

    @app.get(
        "/api/v1/status",
        response_model=ServiceStatusResponse,
        responses={400: _problem_metadata("The HTTP request is malformed.")},
        tags=["System"],
        operation_id="getServiceStatus",
    )
    def service_status() -> ServiceStatusResponse:
        generator_model = (
            settings.openai_model if settings.generator_mode == "openai" else "deterministic-fake"
        )
        return ServiceStatusResponse(
            status="ready",
            api_version=app.version,
            app_environment=settings.app_environment,
            database="ready",
            generator_mode=settings.generator_mode,
            generator_model=generator_model,
        )

    @app.get(
        "/api/v1/recommendations",
        response_model=RecommendationHistoryResponse,
        responses={422: _problem_metadata("History query is invalid.")},
        tags=["Recommendations"],
        operation_id="listRecommendations",
    )
    def list_recent_recommendations(
        limit: Annotated[int, Query(ge=1, le=50)] = 20,
    ) -> RecommendationHistoryResponse:
        return RecommendationHistoryResponse(
            items=[
                RecommendationHistoryItemResponse.from_domain(recommendation)
                for recommendation in list_recommendations.execute(limit=limit)
            ]
        )

    @app.post(
        "/api/v1/recommendations",
        response_model=RecommendationResponse,
        status_code=201,
        responses={
            200: _recommendation_metadata("Stored response replayed."),
            201: _recommendation_metadata("Recommendation generated and stored."),
            409: _problem_metadata(
                "Idempotency or processing conflict.", idempotency_replayed=True
            ),
            413: _problem_metadata("Request body is too large."),
            422: _problem_metadata("Request validation failed."),
            429: _problem_metadata("Generation was rate limited.", retry_after=True),
            502: _problem_metadata("Generation was refused or invalid.", idempotency_replayed=True),
            503: _problem_metadata(
                "Generation dependency is unavailable.", idempotency_replayed=True
            ),
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
        preferences = payload.to_generation_preferences()
        try:
            generation_task = asyncio.create_task(
                asyncio.to_thread(
                    generate.execute,
                    post=post,
                    preferences=preferences,
                    personalization_mode=payload.to_personalization_mode(),
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
        except GenerationInvalidError as error:
            raise ApiError(
                502,
                "generation_invalid",
                "Invalid generation result",
                "The generator returned candidates that did not satisfy the contract.",
            ) from error
        except GenerationIndeterminateError as error:
            raise ApiError(
                409,
                "generation_indeterminate",
                "Generation outcome indeterminate",
                "The provider attempt may have started, so this key cannot be retried safely.",
            ) from error
        except ReplayedGenerationFailure as error:
            failure = error.failure
            raise ApiError(
                failure.status,
                failure.code,
                failure.title,
                failure.detail,
                idempotency_replayed=True,
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

    @app.delete(
        "/api/v1/recommendations/{recommendation_id}",
        status_code=204,
        responses={
            404: _problem_metadata("Recommendation was not found."),
            422: _problem_metadata("Recommendation ID is invalid."),
        },
        tags=["Recommendations"],
        operation_id="deleteRecommendation",
    )
    def delete_stored_recommendation(recommendation_id: UUID) -> Response:
        try:
            delete_recommendation.execute(recommendation_id)
        except RecommendationNotFoundError as error:
            raise _not_found() from error
        return Response(status_code=204)

    @app.delete(
        "/api/v1/personalization/examples",
        status_code=204,
        responses={400: _problem_metadata("The HTTP request is malformed.")},
        tags=["Personalization"],
        operation_id="clearPersonalizationExamples",
    )
    def clear_stored_personalization_examples() -> Response:
        clear_personalization_examples.execute()
        return Response(status_code=204)

    @app.get(
        "/api/v1/engagement-runs",
        response_model=EngagementRunListResponse,
        responses={422: _problem_metadata("Engagement history query is invalid.")},
        tags=["Engagement"],
        operation_id="listEngagementRuns",
    )
    def list_engagement_runs(
        limit: Annotated[int, Query(ge=1, le=50)] = 20,
    ) -> EngagementRunListResponse:
        return EngagementRunListResponse(
            items=[EngagementRunResponse.from_domain(run) for run in engagements.list_recent(limit)]
        )

    @app.post(
        "/api/v1/engagement-runs",
        response_model=EngagementRunResponse,
        status_code=201,
        responses={
            200: {
                "model": EngagementRunResponse,
                "description": "Existing run resumed.",
                "headers": {"Engagement-Replayed": ENGAGEMENT_REPLAYED_HEADER},
            },
            201: {
                "model": EngagementRunResponse,
                "description": "A new engagement run was stored.",
                "headers": {"Engagement-Replayed": ENGAGEMENT_REPLAYED_HEADER},
            },
            404: _problem_metadata("The discovery post or recommendation was not found."),
            409: _problem_metadata("The approved sources cannot start this engagement run."),
            422: _problem_metadata("The engagement start request is invalid."),
        },
        tags=["Engagement"],
        operation_id="startEngagementRun",
    )
    def start_engagement_run(
        payload: EngagementRunStartRequest,
        response: Response,
    ) -> EngagementRunResponse:
        try:
            result = engagements.start(
                approval_id=payload.approval_id,
                discovery_post_id=payload.discovery_post_id,
                recommendation_id=payload.recommendation_id,
            )
        except LookupError as error:
            raise ApiError(
                404,
                "engagement_source_not_found",
                "Engagement source not found",
                "The selected discovery post or recommendation was not found.",
            ) from error
        except ValueError as error:
            code, detail = _engagement_start_conflict(error)
            raise ApiError(
                409,
                code,
                "Engagement conflict",
                detail,
            ) from error
        response.status_code = 201 if result.created else 200
        response.headers["Engagement-Replayed"] = str(not result.created).lower()
        return EngagementRunResponse.from_domain(result.run)

    @app.post(
        "/api/v1/engagement-runs/{run_id}/manual-completion",
        response_model=EngagementRunResponse,
        responses={
            404: _problem_metadata("The engagement run was not found."),
            409: _problem_metadata("The engagement run cannot be manually finalized."),
            422: _problem_metadata("Manual engagement completion is invalid."),
        },
        tags=["Engagement"],
        operation_id="completeEngagementManually",
    )
    def complete_engagement_manually(
        run_id: UUID,
        payload: ManualEngagementCompletionRequest,
    ) -> EngagementRunResponse:
        try:
            run = engagements.complete_manually(
                run_id,
                completed_steps=tuple(EngagementStepName(step) for step in payload.completed_steps),
            )
        except LookupError as error:
            raise ApiError(
                404,
                "engagement_run_not_found",
                "Engagement run not found",
                "The selected engagement run was not found.",
            ) from error
        except ValueError as error:
            raise ApiError(
                409,
                "engagement_manual_completion_conflict",
                "Manual engagement completion conflict",
                "The selected engagement result cannot be manually finalized.",
            ) from error
        return EngagementRunResponse.from_domain(run)

    @app.get(
        "/api/v1/engagement-runs/by-post/{post_id}",
        response_model=EngagementRunResponse,
        responses={404: _problem_metadata("The discovery post has no engagement run.")},
        tags=["Engagement"],
        operation_id="getEngagementRunForPost",
    )
    def get_engagement_run_for_post(post_id: UUID) -> EngagementRunResponse:
        run = engagements.get_for_post(post_id)
        if run is None:
            raise ApiError(
                404,
                "engagement_run_not_found",
                "Engagement run not found",
                "The selected discovery post has no engagement run.",
            )
        return EngagementRunResponse.from_domain(run)

    @app.get(
        "/api/v1/engagement-runs/{run_id}",
        response_model=EngagementRunResponse,
        responses={404: _problem_metadata("The engagement run was not found.")},
        tags=["Engagement"],
        operation_id="getEngagementRun",
    )
    def get_engagement_run(run_id: UUID) -> EngagementRunResponse:
        run = engagements.get(run_id)
        if run is None:
            raise ApiError(
                404,
                "engagement_run_not_found",
                "Engagement run not found",
                "The selected engagement run was not found.",
            )
        return EngagementRunResponse.from_domain(run)

    @app.patch(
        "/api/v1/engagement-runs/{run_id}/steps/{step_name}",
        response_model=EngagementRunResponse,
        responses={
            404: _problem_metadata("The engagement run was not found."),
            409: _problem_metadata("The engagement step transition is not allowed."),
            422: _problem_metadata("The engagement step result is invalid."),
        },
        tags=["Engagement"],
        operation_id="transitionEngagementStep",
    )
    def transition_engagement_step(
        run_id: UUID,
        step_name: EngagementStepName,
        payload: EngagementStepTransitionRequest,
    ) -> EngagementRunResponse:
        try:
            run = engagements.transition_step(
                run_id,
                step_name,
                payload.to_state(),
                result_code=payload.result_code,
            )
        except LookupError as error:
            raise ApiError(
                404,
                "engagement_run_not_found",
                "Engagement run not found",
                "The selected engagement run was not found.",
            ) from error
        except (DomainValidationError, ValueError) as error:
            raise ApiError(
                409,
                "engagement_transition_conflict",
                "Engagement transition conflict",
                "The engagement step cannot move to the requested state.",
            ) from error
        return EngagementRunResponse.from_domain(run)

    @app.get(
        "/api/v1/discovery/neighbors",
        response_model=NeighborListResponse,
        tags=["Discovery"],
        operation_id="listDiscoveryNeighbors",
    )
    def list_discovery_neighbors() -> NeighborListResponse:
        return NeighborListResponse(
            items=[NeighborResponse.from_domain(item) for item in discovery.list_neighbors()]
        )

    @app.post(
        "/api/v1/discovery/neighbors",
        response_model=NeighborResponse,
        status_code=201,
        responses={422: _problem_metadata("Neighbor data is invalid.")},
        tags=["Discovery"],
        operation_id="saveDiscoveryNeighbor",
    )
    def save_discovery_neighbor(payload: NeighborRequest) -> NeighborResponse:
        try:
            result = discovery.save_neighbor(
                name=payload.name.strip(),
                blog_url=payload.blog_url.strip(),
                blog_id=payload.blog_id.strip(),
                enabled=payload.enabled,
            )
        except DomainValidationError as error:
            raise ApiError(
                422, "invalid_neighbor", "Invalid neighbor", "Neighbor data is invalid."
            ) from error
        return NeighborResponse.from_domain(result)

    @app.get(
        "/api/v1/discovery/searches",
        response_model=SavedSearchListResponse,
        tags=["Discovery"],
        operation_id="listDiscoverySearches",
    )
    def list_discovery_searches() -> SavedSearchListResponse:
        return SavedSearchListResponse(
            items=[SavedSearchResponse.from_domain(item) for item in discovery.list_searches()]
        )

    @app.post(
        "/api/v1/discovery/searches",
        response_model=SavedSearchResponse,
        status_code=201,
        responses={422: _problem_metadata("Saved search data is invalid.")},
        tags=["Discovery"],
        operation_id="saveDiscoverySearch",
    )
    def save_discovery_search(payload: SavedSearchRequest) -> SavedSearchResponse:
        try:
            result = discovery.save_search(
                query=payload.query.strip(),
                excluded_terms=tuple(term.strip() for term in payload.excluded_terms),
                freshness_days=payload.freshness_days,
                enabled=payload.enabled,
            )
        except DomainValidationError as error:
            raise ApiError(
                422, "invalid_search", "Invalid saved search", "Saved search data is invalid."
            ) from error
        return SavedSearchResponse.from_domain(result)

    @app.delete(
        "/api/v1/discovery/searches/{search_id}",
        status_code=204,
        responses={404: _problem_metadata("The selected saved search was not found.")},
        tags=["Discovery"],
        operation_id="deleteDiscoverySearch",
    )
    def delete_discovery_search(search_id: UUID) -> Response:
        if not discovery.delete_search(search_id):
            raise _discovery_not_found()
        return Response(status_code=204)

    @app.post(
        "/api/v1/discovery/searches/{search_id}/refresh",
        response_model=DiscoverySearchRefreshResponse,
        responses={
            404: _problem_metadata("The selected saved search was not found."),
            409: _problem_metadata("Naver Search API credentials are not configured."),
        },
        tags=["Discovery"],
        operation_id="refreshDiscoverySearch",
    )
    async def refresh_discovery_search(search_id: UUID) -> DiscoverySearchRefreshResponse:
        search = next((item for item in discovery.list_searches() if item.id == search_id), None)
        if search is None:
            raise _discovery_not_found()
        if not search.enabled:
            return DiscoverySearchRefreshResponse(
                imported_count=0,
                provider="naver_open_api",
                detail="비활성화된 검색어는 갱신하지 않습니다.",
            )
        try:
            imported = await refresh_saved_search(search)
        except SearchProviderNotConfiguredError:
            raise ApiError(
                409,
                "discovery_search_not_configured",
                "Naver Search API is not configured",
                (
                    "신규 이웃 검색에는 NAVER_SEARCH_CLIENT_ID와 "
                    "NAVER_SEARCH_CLIENT_SECRET 설정이 필요합니다."
                ),
            ) from None
        except Exception:
            logger.warning("discovery_search_refresh_failed search_id=%s", search_id)
            raise ApiError(
                502,
                "discovery_search_unavailable",
                "Discovery search is unavailable",
                "신규 이웃 검색 결과를 가져오지 못했습니다.",
            ) from None
        return DiscoverySearchRefreshResponse(
            imported_count=imported,
            provider="naver_open_api",
            detail=f"공식 네이버 검색 API에서 검색 후보 {imported}개를 확인했습니다.",
        )

    @app.post(
        "/api/v1/discovery/import",
        response_model=DiscoveryImportResponse,
        responses={
            404: _problem_metadata("The selected discovery owner was not found."),
            422: _problem_metadata("Discovery import is invalid."),
        },
        tags=["Discovery"],
        operation_id="importDiscoveryPosts",
    )
    def import_discovery_posts(payload: DiscoveryImportRequest) -> DiscoveryImportResponse:
        source = DiscoverySource(payload.source)
        posts = tuple(item.to_domain() for item in payload.posts)
        if source is DiscoverySource.NEIGHBOR:
            assert payload.neighbor_id is not None
            if payload.neighbor_id not in {item.id for item in discovery.list_neighbors()}:
                raise _discovery_not_found()
        else:
            assert payload.search_id is not None
            search = next(
                (item for item in discovery.list_searches() if item.id == payload.search_id), None
            )
            if search is None:
                raise _discovery_not_found()
            if not search.enabled:
                return DiscoveryImportResponse(imported_count=0)
            posts = filter_saved_search_posts(search, posts, now=datetime.now(UTC))
        try:
            count = discovery.import_posts(
                source=source,
                neighbor_id=payload.neighbor_id,
                search_id=payload.search_id,
                posts=posts,
            )
        except DomainValidationError as error:
            raise ApiError(
                422,
                "invalid_discovery_post",
                "Invalid discovery post",
                "Discovery post data is invalid.",
            ) from error
        return DiscoveryImportResponse(imported_count=count)

    @app.get(
        "/api/v1/discovery/queue",
        response_model=DiscoveryQueueResponse,
        responses={422: _problem_metadata("Discovery source is invalid.")},
        tags=["Discovery"],
        operation_id="listDiscoveryQueue",
    )
    def list_discovery_queue(
        source: Annotated[Literal["neighbor", "search"], Query()],
    ) -> DiscoveryQueueResponse:
        posts = discovery.list_posts(DiscoverySource(source))
        if source == "search":
            searches = {search.id: search for search in discovery.list_searches() if search.enabled}
            visible_posts = []
            for post in posts:
                search = searches.get(post.search_id) if post.search_id is not None else None
                if search is not None and saved_search_title_matches(search, post.title):
                    visible_posts.append(post)
            posts = tuple(visible_posts)
        return DiscoveryQueueResponse(
            items=[DiscoveryPostResponse.from_domain(item) for item in posts]
        )

    @app.patch(
        "/api/v1/discovery/queue/{post_id}",
        response_model=DiscoveryPostResponse,
        responses={
            404: _problem_metadata("The discovery post was not found."),
            422: _problem_metadata("Discovery post state is invalid."),
        },
        tags=["Discovery"],
        operation_id="updateDiscoveryPostState",
    )
    def update_discovery_post_state(
        post_id: UUID,
        payload: DiscoveryPostStateRequest,
    ) -> DiscoveryPostResponse:
        result = discovery.update_post_state(post_id, DiscoveryState(payload.state))
        if result is None:
            raise _discovery_not_found()
        return DiscoveryPostResponse.from_domain(result)

    @app.get(
        "/api/v1/discovery/automation-settings",
        response_model=AutomaticDiscoverySettingsResponse,
        tags=["Discovery"],
        operation_id="getAutomaticDiscoverySettings",
    )
    def get_automatic_discovery_settings() -> AutomaticDiscoverySettingsResponse:
        return AutomaticDiscoverySettingsResponse.from_domain(discovery.get_automatic_settings())

    @app.put(
        "/api/v1/discovery/automation-settings",
        response_model=AutomaticDiscoverySettingsResponse,
        responses={422: _problem_metadata("Automatic discovery settings are invalid.")},
        tags=["Discovery"],
        operation_id="saveAutomaticDiscoverySettings",
    )
    def save_automatic_discovery_settings(
        payload: AutomaticDiscoverySettingsRequest,
    ) -> AutomaticDiscoverySettingsResponse:
        previous = discovery.get_automatic_settings()
        try:
            result = discovery.save_automatic_settings(payload.to_domain(previous=previous))
        except DomainValidationError as error:
            raise ApiError(
                422,
                "invalid_automatic_discovery_settings",
                "Invalid automatic discovery settings",
                "Automatic discovery settings are invalid.",
            ) from error
        return AutomaticDiscoverySettingsResponse.from_domain(result)

    @app.post(
        "/api/v1/discovery/sync",
        response_model=AutomaticDiscoverySyncResponse,
        tags=["Discovery"],
        operation_id="syncAutomaticDiscovery",
    )
    async def sync_automatic_discovery() -> AutomaticDiscoverySyncResponse:
        return await synchronize_automatic_discovery()

    @app.get(
        "/api/v1/discovery/digest-settings",
        response_model=DigestSettingsResponse,
        tags=["Discovery"],
        operation_id="getDiscoveryDigestSettings",
    )
    def get_discovery_digest_settings() -> DigestSettingsResponse:
        return DigestSettingsResponse.from_domain(
            discovery.get_digest_settings(), smtp_configured=_smtp_configured(settings)
        )

    @app.put(
        "/api/v1/discovery/digest-settings",
        response_model=DigestSettingsResponse,
        responses={422: _problem_metadata("Digest settings are invalid.")},
        tags=["Discovery"],
        operation_id="saveDiscoveryDigestSettings",
    )
    def save_discovery_digest_settings(payload: DigestSettingsRequest) -> DigestSettingsResponse:
        try:
            result = discovery.save_digest_settings(payload.to_domain())
        except DomainValidationError as error:
            raise ApiError(
                422,
                "invalid_digest_settings",
                "Invalid digest settings",
                "Digest settings are invalid.",
            ) from error
        return DigestSettingsResponse.from_domain(
            result, smtp_configured=_smtp_configured(settings)
        )

    @app.post(
        "/api/v1/discovery/refresh-neighbors",
        response_model=DiscoveryImportResponse,
        tags=["Discovery"],
        operation_id="refreshDiscoveryNeighbors",
    )
    async def refresh_discovery_neighbors() -> DiscoveryImportResponse:
        return DiscoveryImportResponse(imported_count=await refresh_neighbors_from_rss())

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
                personalization_eligible=(
                    payload.personalization_eligible
                    if "personalization_eligible" in fields
                    else None
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


class _SessionQueue:
    """Read the queued posts one session may process."""

    def __init__(self, discovery: Any) -> None:
        self._discovery = discovery

    def list_queue(self, source: DiscoverySource) -> list[Any]:
        """Return the queued posts for one source, newest first."""
        return [
            post
            for post in self._discovery.list_posts(source)
            if post.state is DiscoveryState.QUEUED
        ]


def _media_root(settings: ApiSettings) -> Path:
    """Return the directory that holds uploaded draft images."""
    if settings.draft_media_dir.strip():
        return Path(settings.draft_media_dir).expanduser()
    database = make_url(settings.database_url).database
    base = Path(database).expanduser().parent if database else Path("data")
    return base / "media"


def _configured_generator(settings: ApiSettings) -> CommentGenerator:
    if settings.generator_mode == "fake":
        return DeterministicFakeGenerator()
    from naver_blog_assistant.infrastructure.generators.openai import OpenAICommentGenerator

    return OpenAICommentGenerator(
        api_key=settings.openai_api_key,
        model=settings.openai_model,
        reasoning_effort=settings.openai_reasoning_effort,
        timeout_seconds=settings.openai_timeout_seconds,
        max_output_tokens=settings.openai_max_output_tokens,
    )


def _configured_registry(settings: ApiSettings) -> ProviderRegistry:
    """Build the provider registry from process configuration only."""
    return ProviderRegistry(
        api_keys={
            LlmProvider.OPENAI: settings.openai_api_key,
            LlmProvider.GEMINI: settings.gemini_api_key,
            LlmProvider.ANTHROPIC: settings.anthropic_api_key,
        },
        models={
            LlmProvider.OPENAI: settings.openai_model,
            LlmProvider.GEMINI: settings.gemini_model,
            LlmProvider.ANTHROPIC: settings.anthropic_model,
        },
    )


def _configured_fanout(
    *,
    settings: ApiSettings,
    registry: ProviderRegistry,
    repository: Any,
    personalization: Any,
    attempts: SqliteLlmAttemptRepository,
    budget: CallBudget,
) -> FanOutGeneration | None:
    """Build one generator per configured provider, or nothing in fake mode."""
    if settings.generator_mode == "fake":
        return None
    generators: dict[str, GenerateRecommendation] = {}
    for provider in registry.configured():
        selection = registry.selection(provider)
        generators[provider.value] = GenerateRecommendation(
            generator=ProviderCommentGenerator(
                registry.client(selection),
                timeout_seconds=settings.openai_timeout_seconds,
                max_output_tokens=settings.openai_max_output_tokens,
            ),
            idempotency=repository,
            personalization=personalization,
        )
    if not generators:
        return None
    return FanOutGeneration(
        generators=generators,
        attempts=attempts,
        budget=budget,
        timeout_seconds=settings.generation_timeout_seconds,
    )


def _engagement_start_conflict(error: ValueError) -> tuple[str, str]:
    message = str(error)
    if "approval is already bound" in message:
        return (
            "engagement_approval_bound",
            "This approval token is already bound to a different engagement run.",
        )
    if "discovery post is already bound" in message:
        return (
            "engagement_post_recommendation_mismatch",
            "This discovery post is already linked to a different recommendation.",
        )
    if "recommendation does not belong" in message:
        return (
            "engagement_source_mismatch",
            "The selected recommendation does not belong to the discovery post.",
        )
    if "recommendation must be approved" in message:
        return (
            "engagement_recommendation_not_approved",
            "Only an approved recommendation can start a new engagement run.",
        )
    if "publisher blog id" in message:
        return (
            "engagement_publisher_missing",
            "A new-neighbor candidate needs its publisher blog ID before engagement can start.",
        )
    return (
        "engagement_conflict",
        "The selected post and approved recommendation cannot start this run.",
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


def _discovery_not_found() -> ApiError:
    return ApiError(
        404,
        "discovery_not_found",
        "Discovery item not found",
        "The selected local discovery item was not found.",
    )


def _smtp_configured(settings: ApiSettings) -> bool:
    return all(
        value.strip()
        for value in (
            settings.digest_smtp_host,
            settings.digest_smtp_username,
            settings.digest_smtp_password,
            settings.digest_email_from,
            settings.digest_email_to,
        )
    )


def _smtp_sender(settings: ApiSettings) -> SmtpDigestSender:
    return SmtpDigestSender(
        host=settings.digest_smtp_host,
        port=settings.digest_smtp_port,
        username=settings.digest_smtp_username,
        password=settings.digest_smtp_password,
        sender=settings.digest_email_from,
        recipient=settings.digest_email_to,
        security=settings.digest_smtp_security,
    )


def _digest_email_body(posts: tuple[object, ...]) -> str:
    lines = ["오늘 확인된 이웃 블로그 대기열입니다.", ""]
    for post in posts[:20]:
        title = getattr(post, "title", "")
        source_url = getattr(post, "source_url", "")
        published_at = getattr(post, "published_at", None)
        published_text = published_at.isoformat() if published_at is not None else "게시 시각 미상"
        lines.extend((f"- {title} ({published_text})", str(source_url)))
    if len(posts) > 20:
        lines.append(f"외 {len(posts) - 20}개는 Side Panel 대기열에서 확인하세요.")
    if not posts:
        lines.append("현재 대기 중인 새 글이 없습니다.")
    return "\n".join(lines)


class _LocallyRateLimitedGenerator:
    """Limit only calls that reach generation, so idempotent replays stay available."""

    def __init__(self, generator: CommentGenerator, limiter: LocalRateLimiter) -> None:
        self._generator = generator
        self._limiter = limiter

    def generate(self, post: CapturedPost, preferences: GenerationPreferences) -> GenerationOutput:
        retry_after = self._limiter.acquire()
        if retry_after is not None:
            raise _LocalRateLimitError(retry_after)
        return self._generator.generate(post, preferences)

    def generate_with_style(
        self,
        post: CapturedPost,
        preferences: GenerationPreferences,
        style_examples: tuple[str, ...],
    ) -> GenerationOutput:
        retry_after = self._limiter.acquire()
        if retry_after is not None:
            raise _LocalRateLimitError(retry_after)
        generate_with_style = getattr(self._generator, "generate_with_style", None)
        if callable(generate_with_style):
            return generate_with_style(post, preferences, style_examples)
        return self._generator.generate(post, preferences)


class _LocalRateLimitError(GenerationRateLimitedError, GenerationNotStartedError):
    """Signal a safe-to-release local rejection before provider work starts."""
