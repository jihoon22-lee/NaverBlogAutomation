"""Use cases for the locally owned browser automation surface."""

from naver_blog_assistant.application.automation.errors import (
    AutomationError,
    BrowserSessionAlreadyRunningError,
    BrowserSessionBusyError,
    BrowserSessionNotRunningError,
    BrowserSessionOperationFailedError,
    BrowserSessionUnavailableError,
)
from naver_blog_assistant.application.automation.session import (
    LOGIN_PROBE_URL,
    LOGIN_STATE_EXPRESSION,
    BrowserSessionManager,
)

__all__ = [
    "LOGIN_PROBE_URL",
    "LOGIN_STATE_EXPRESSION",
    "AutomationError",
    "BrowserSessionAlreadyRunningError",
    "BrowserSessionBusyError",
    "BrowserSessionManager",
    "BrowserSessionNotRunningError",
    "BrowserSessionOperationFailedError",
    "BrowserSessionUnavailableError",
]
