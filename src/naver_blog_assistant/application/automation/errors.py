"""Application errors for the browser automation surface."""

from __future__ import annotations


class AutomationError(Exception):
    """Base class for automation failures that map to stable transport codes."""


class BrowserSessionAlreadyRunningError(AutomationError):
    """Raised when a second launch is requested while one session already owns the profile."""


class BrowserSessionNotRunningError(AutomationError):
    """Raised when an operation requires a live session that does not exist."""


class BrowserSessionBusyError(AutomationError):
    """Raised when another lifecycle operation is still in progress."""


class BrowserSessionUnavailableError(AutomationError):
    """Raised when the configured driver or browser cannot start."""


class BrowserSessionOperationFailedError(AutomationError):
    """Raised when a live session rejects navigation, evaluation, or capture."""


class ArticleExtractionFailedError(AutomationError):
    """Raised with a stable code when an article cannot be captured for review."""

    CODES = frozenset({"unsupported_url", "empty_article", "short_article", "extraction_failed"})

    def __init__(self, code: str) -> None:
        if code not in self.CODES:
            raise ValueError(f"{code} is not a known extraction failure code")
        super().__init__(code)
        self.code = code
