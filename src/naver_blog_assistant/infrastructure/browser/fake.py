"""In-memory browser driver used by unit tests and local development smoke checks."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from naver_blog_assistant.ports.browser import (
    BrowserLaunchError,
    BrowserOperationError,
    FrameHandle,
    PageHandle,
)


@dataclass(slots=True)
class FakeFrame:
    """One scripted document that answers evaluations from a lookup table."""

    url: str = "about:blank"
    results: dict[str, Any] = field(default_factory=dict)
    evaluations: list[tuple[str, Any]] = field(default_factory=list)
    failure: str | None = None

    async def evaluate(self, expression: str, argument: Any = None) -> Any:
        if self.failure is not None:
            raise BrowserOperationError(self.failure)
        self.evaluations.append((expression, argument))
        if expression in self.results:
            return self.results[expression]
        return self.results.get("*")


@dataclass(slots=True)
class FakePage:
    """One scripted tab that records navigation and capture requests."""

    url: str = "about:blank"
    child_frames: list[FakeFrame] = field(default_factory=list)
    results: dict[str, Any] = field(default_factory=dict)
    navigations: list[str] = field(default_factory=list)
    evaluations: list[tuple[str, Any]] = field(default_factory=list)
    screenshots: int = 0
    closed: bool = False
    navigation_failure: str | None = None
    evaluate_failure: str | None = None
    screenshot_failure: str | None = None
    screenshot_bytes: bytes = b"\x89PNG\r\n\x1a\n"

    @property
    def frames(self) -> Sequence[FrameHandle]:
        return (FakeFrame(url=self.url, results=self.results), *self.child_frames)

    async def goto(self, url: str, *, timeout_seconds: float | None = None) -> None:
        if self.closed:
            raise BrowserOperationError("page is already closed")
        if self.navigation_failure is not None:
            raise BrowserOperationError(self.navigation_failure)
        self.navigations.append(url)
        self.url = url

    async def evaluate(self, expression: str, argument: Any = None) -> Any:
        if self.closed:
            raise BrowserOperationError("page is already closed")
        if self.evaluate_failure is not None:
            raise BrowserOperationError(self.evaluate_failure)
        self.evaluations.append((expression, argument))
        if expression in self.results:
            return self.results[expression]
        return self.results.get("*")

    async def screenshot(self) -> bytes:
        if self.closed:
            raise BrowserOperationError("page is already closed")
        if self.screenshot_failure is not None:
            raise BrowserOperationError(self.screenshot_failure)
        self.screenshots += 1
        return self.screenshot_bytes

    async def close(self) -> None:
        self.closed = True


@dataclass(slots=True)
class FakeBrowserContext:
    """A scripted persistent context that tracks its own tabs and window focus."""

    open_tabs: list[FakePage] = field(default_factory=list)
    front_requests: int = 0
    closed: bool = False
    close_failure: str | None = None
    front_failure: str | None = None
    new_page_failure: str | None = None
    page_navigation_failure: str | None = None
    page_results: dict[str, Any] = field(default_factory=dict)

    @property
    def pages(self) -> Sequence[PageHandle]:
        return tuple(page for page in self.open_tabs if not page.closed)

    async def new_page(self) -> PageHandle:
        if self.closed:
            raise BrowserOperationError("context is already closed")
        if self.new_page_failure is not None:
            raise BrowserOperationError(self.new_page_failure)
        page = FakePage(
            results=dict(self.page_results),
            navigation_failure=self.page_navigation_failure,
        )
        self.open_tabs.append(page)
        return page

    async def bring_to_front(self) -> None:
        if self.closed:
            raise BrowserOperationError("context is already closed")
        if self.front_failure is not None:
            raise BrowserOperationError(self.front_failure)
        self.front_requests += 1

    async def close(self) -> None:
        if self.close_failure is not None:
            raise BrowserOperationError(self.close_failure)
        self.closed = True
        for page in self.open_tabs:
            page.closed = True


@dataclass(slots=True)
class FakeBrowserDriver:
    """Deterministic driver that never starts a real browser process."""

    name: str = "fake"
    launch_failure: str | None = None
    page_results: dict[str, Any] = field(default_factory=dict)
    page_navigation_failure: str | None = None
    new_page_failure: str | None = None
    launches: list[tuple[Path, bool, str | None]] = field(default_factory=list)
    contexts: list[FakeBrowserContext] = field(default_factory=list)

    async def launch(
        self,
        *,
        profile_dir: Path,
        headless: bool,
        channel: str | None = None,
    ) -> FakeBrowserContext:
        if self.launch_failure is not None:
            raise BrowserLaunchError(self.launch_failure)
        self.launches.append((profile_dir, headless, channel))
        context = FakeBrowserContext(
            page_results=dict(self.page_results),
            page_navigation_failure=self.page_navigation_failure,
            new_page_failure=self.new_page_failure,
        )
        self.contexts.append(context)
        return context
