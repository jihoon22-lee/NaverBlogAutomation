"""Use cases for the locally owned browser automation surface."""

from naver_blog_assistant.application.automation.collect_reference_posts import (
    BlogCatalogFailedError,
    CatalogSync,
    CollectReferencePosts,
)
from naver_blog_assistant.application.automation.errors import (
    ArticleExtractionFailedError,
    AutomationError,
    BrowserSessionAlreadyRunningError,
    BrowserSessionBusyError,
    BrowserSessionNotRunningError,
    BrowserSessionOperationFailedError,
    BrowserSessionUnavailableError,
    EngagementBlockedError,
    EngagementNotAllowedError,
)
from naver_blog_assistant.application.automation.execute_engagement import (
    CONFIRMATION_ATTEMPTS,
    EngagementProgress,
    EngagementRequest,
    ExecuteEngagement,
    StepOutcome,
)
from naver_blog_assistant.application.automation.extract_article import (
    SUPPORTED_HOSTS,
    ExtractArticle,
    normalize_request_text,
    parse_supported_article_url,
)
from naver_blog_assistant.application.automation.generate_comment import (
    MAX_COMMENT_CODE_POINTS,
    GenerationOptions,
    GenerationPlan,
    PlanGeneration,
    apply_closing_phrase,
    closing_phrase,
)
from naver_blog_assistant.application.automation.generation_keys import (
    FIRST_ATTEMPT,
    GenerationAttempt,
    GenerationKeyRegistry,
    derive_generation_key,
)
from naver_blog_assistant.application.automation.governor import (
    GovernorRefusedError,
    SafetyGovernor,
    SafetyPolicy,
)
from naver_blog_assistant.application.automation.run_engagement import (
    EngagementRunService,
    RunChannel,
    RunEvent,
)
from naver_blog_assistant.application.automation.run_session import (
    RunSession,
    SessionOutcome,
    session_snapshot,
)
from naver_blog_assistant.application.automation.run_staging import (
    StagePostService,
    StagingApproval,
)
from naver_blog_assistant.application.automation.session import (
    LOGIN_PROBE_URL,
    LOGIN_STATE_EXPRESSION,
    BrowserSessionManager,
)
from naver_blog_assistant.application.automation.session_post_runner import (
    PostAttempt,
    SessionPostRunner,
)
from naver_blog_assistant.application.automation.stage_post import (
    StagePost,
    StagingBlockedError,
    StagingRequest,
    body_text,
    staging_request,
    tag_text,
)

__all__ = [
    "LOGIN_PROBE_URL",
    "LOGIN_STATE_EXPRESSION",
    "SUPPORTED_HOSTS",
    "ArticleExtractionFailedError",
    "AutomationError",
    "BrowserSessionAlreadyRunningError",
    "BrowserSessionBusyError",
    "BrowserSessionManager",
    "BrowserSessionNotRunningError",
    "BrowserSessionOperationFailedError",
    "BrowserSessionUnavailableError",
    "ExtractArticle",
    "normalize_request_text",
    "parse_supported_article_url",
    "FIRST_ATTEMPT",
    "GenerationAttempt",
    "GenerationKeyRegistry",
    "GenerationOptions",
    "GenerationPlan",
    "MAX_COMMENT_CODE_POINTS",
    "PlanGeneration",
    "apply_closing_phrase",
    "closing_phrase",
    "derive_generation_key",
    "CONFIRMATION_ATTEMPTS",
    "EngagementBlockedError",
    "EngagementProgress",
    "EngagementRequest",
    "ExecuteEngagement",
    "StepOutcome",
    "EngagementNotAllowedError",
    "EngagementRunService",
    "RunChannel",
    "RunEvent",
    "BlogCatalogFailedError",
    "CatalogSync",
    "CollectReferencePosts",
    "PostAttempt",
    "GovernorRefusedError",
    "RunSession",
    "SafetyGovernor",
    "SafetyPolicy",
    "SessionPostRunner",
    "SessionOutcome",
    "session_snapshot",
    "StagePost",
    "StagePostService",
    "StagingApproval",
    "StagingBlockedError",
    "StagingRequest",
    "body_text",
    "staging_request",
    "tag_text",
]
