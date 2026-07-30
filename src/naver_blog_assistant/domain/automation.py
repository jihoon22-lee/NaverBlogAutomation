"""Domain state for the locally owned browser automation surface."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Final

from naver_blog_assistant.domain.models import DomainValidationError


class BrowserSessionState(StrEnum):
    """Lifecycle of the single browser context owned by the local service."""

    STOPPED = "stopped"
    LAUNCHING = "launching"
    READY = "ready"
    CLOSING = "closing"


class BrowserLoginState(StrEnum):
    """Sign-in state observed on a public Naver page without reading credentials."""

    UNKNOWN = "unknown"
    ANONYMOUS = "anonymous"
    AUTHENTICATED = "authenticated"


class TriggerKind(StrEnum):
    """Why an engagement run was started."""

    MANUAL = "manual"
    SESSION = "session"
    SCHEDULE = "schedule"


_ALLOWED_SESSION_TRANSITIONS: dict[BrowserSessionState, frozenset[BrowserSessionState]] = {
    BrowserSessionState.STOPPED: frozenset({BrowserSessionState.LAUNCHING}),
    BrowserSessionState.LAUNCHING: frozenset(
        {BrowserSessionState.READY, BrowserSessionState.STOPPED}
    ),
    BrowserSessionState.READY: frozenset({BrowserSessionState.CLOSING}),
    BrowserSessionState.CLOSING: frozenset({BrowserSessionState.STOPPED}),
}


def assert_session_transition(current: BrowserSessionState, target: BrowserSessionState) -> None:
    """Reject any lifecycle transition that the session state machine does not allow."""
    if target not in _ALLOWED_SESSION_TRANSITIONS[current]:
        raise DomainValidationError(
            f"browser session cannot move from {current.value} to {target.value}"
        )


@dataclass(frozen=True, slots=True)
class BrowserSessionStatus:
    """Redacted snapshot returned to the local web app."""

    state: BrowserSessionState
    login: BrowserLoginState
    driver: str
    headless: bool
    profile_dir: str
    open_pages: int
    detail: str | None = None

    def __post_init__(self) -> None:
        if not self.driver.strip():
            raise DomainValidationError("browser session status requires a driver name")
        if self.open_pages < 0:
            raise DomainValidationError("open page count cannot be negative")
        if self.state is not BrowserSessionState.READY and self.open_pages != 0:
            raise DomainValidationError("only a ready session can report open pages")
        if (
            self.state is not BrowserSessionState.READY
            and self.login is not BrowserLoginState.UNKNOWN
        ):
            raise DomainValidationError("login state is observable only while the session is ready")


MAX_ARTICLE_BODY_CODE_POINTS: Final = 100_000
MAX_ARTICLE_TITLE_CODE_POINTS: Final = 300
MIN_ARTICLE_BODY_CODE_POINTS: Final = 20
ARTICLE_PREVIEW_CODE_POINTS: Final = 1_200


@dataclass(frozen=True, slots=True)
class ArticleExtraction:
    """One in-memory article capture bounded to the generation request limits."""

    source_url: str
    title: str
    body: str = field(repr=False, compare=False)
    original_length: int = 0
    truncated: bool = False
    selector_kind: str = "modern"

    def __post_init__(self) -> None:
        if not self.source_url.strip():
            raise DomainValidationError("extraction requires a source URL")
        if not self.title.strip():
            raise DomainValidationError("extraction requires a title")
        transmitted = self.transmitted_length
        if transmitted < MIN_ARTICLE_BODY_CODE_POINTS:
            raise DomainValidationError("extraction body is too short")
        if transmitted > MAX_ARTICLE_BODY_CODE_POINTS:
            raise DomainValidationError("extraction body exceeds the request limit")
        if len(self.title) > MAX_ARTICLE_TITLE_CODE_POINTS:
            raise DomainValidationError("extraction title exceeds the contract limit")
        if self.original_length < transmitted:
            raise DomainValidationError("original length cannot be smaller than the bounded body")
        if self.truncated and self.original_length == transmitted:
            raise DomainValidationError("a truncated capture must report a larger original length")

    @property
    def transmitted_length(self) -> int:
        """Return the code-point count that would be sent for generation."""
        return len(self.body)

    @property
    def preview(self) -> str:
        """Return a bounded preview for human review."""
        return self.body[:ARTICLE_PREVIEW_CODE_POINTS]
