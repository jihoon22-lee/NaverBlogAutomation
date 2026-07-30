"""Use cases for the locally owned browser automation surface."""

from naver_blog_assistant.application.automation.errors import (
    ArticleExtractionFailedError,
    AutomationError,
    BrowserSessionAlreadyRunningError,
    BrowserSessionBusyError,
    BrowserSessionNotRunningError,
    BrowserSessionOperationFailedError,
    BrowserSessionUnavailableError,
)
from naver_blog_assistant.application.automation.extract_article import (
    SUPPORTED_HOSTS,
    ExtractArticle,
    normalize_request_text,
    parse_supported_article_url,
)
from naver_blog_assistant.application.automation.session import (
    LOGIN_PROBE_URL,
    LOGIN_STATE_EXPRESSION,
    BrowserSessionManager,
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
]
