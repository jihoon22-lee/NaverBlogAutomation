"""In-memory browser driver used by unit tests and local development smoke checks.

`probe_results` answers page-bundle calls by probe name, so tests can script the injected probes
without knowing how the runner serializes them.
"""

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


def answer_probe(results: dict[str, Any], expression: str, argument: Any) -> Any:
    """Return a scripted page-bundle answer, or None when the call is not a probe."""
    if not results or not isinstance(argument, dict) or "globalThis" not in expression:
        return None
    name = argument.get("name")
    if not isinstance(name, str) or name not in results:
        return None
    answers = results[name]
    if isinstance(answers, list):
        value = answers[0] if len(answers) == 1 else answers.pop(0)
    else:
        value = answers
    return {"installed": True, "value": value}


@dataclass(slots=True)
class FakeFrame:
    """One scripted document that answers evaluations from a lookup table."""

    url: str = "about:blank"
    results: dict[str, Any] = field(default_factory=dict)
    evaluations: list[tuple[str, Any]] = field(default_factory=list)
    probe_results: dict[str, Any] = field(default_factory=dict)
    failure: str | None = None

    async def evaluate(self, expression: str, argument: Any = None) -> Any:
        if self.failure is not None:
            raise BrowserOperationError(self.failure)
        self.evaluations.append((expression, argument))
        probe = answer_probe(self.probe_results, expression, argument)
        if probe is not None:
            return probe
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
    actions: list[tuple[str, str]] = field(default_factory=list)
    clicks: list[str] = field(default_factory=list)
    typed: list[tuple[str, str]] = field(default_factory=list)
    appended: list[tuple[str, str]] = field(default_factory=list)
    pressed: list[tuple[str, str]] = field(default_factory=list)
    selected: list[tuple[str, str]] = field(default_factory=list)
    scrolls: list[int] = field(default_factory=list)
    waits: list[float] = field(default_factory=list)
    attachments: list[tuple[str, tuple[str, ...]]] = field(default_factory=list)
    action_failures: dict[str, str] = field(default_factory=dict)
    probe_results: dict[str, Any] = field(default_factory=dict)
    probe_calls: list[tuple[str, tuple[Any, ...]]] = field(default_factory=list)
    click_failure: str | None = None
    type_failure: str | None = None
    screenshots: int = 0
    closed: bool = False
    navigation_failure: str | None = None
    evaluate_failure: str | None = None
    screenshot_failure: str | None = None
    screenshot_bytes: bytes = b"\x89PNG\r\n\x1a\n"

    @property
    def frames(self) -> Sequence[FrameHandle]:
        main = FakeFrame(url=self.url, results=self.results, probe_results=self.probe_results)
        return (main, *self.child_frames)

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
        probe = self._probe(expression, argument)
        if probe is not None:
            return probe
        if expression in self.results:
            return self.results[expression]
        return self.results.get("*")

    def _probe(self, expression: str, argument: Any) -> Any:
        """Answer one page-bundle call from `probe_results` when it is scripted."""
        answered = answer_probe(self.probe_results, expression, argument)
        if answered is not None and isinstance(argument, dict):
            self.probe_calls.append((str(argument.get("name")), tuple(argument.get("args") or ())))
        return answered

    async def screenshot(self) -> bytes:
        if self.closed:
            raise BrowserOperationError("page is already closed")
        if self.screenshot_failure is not None:
            raise BrowserOperationError(self.screenshot_failure)
        self.screenshots += 1
        return self.screenshot_bytes

    async def click(self, selector: str, *, timeout_seconds: float | None = None) -> None:
        del timeout_seconds
        if self.closed:
            raise BrowserOperationError("page is already closed")
        failure = self.action_failures.get(selector) or self.click_failure
        if failure is not None:
            raise BrowserOperationError(failure)
        self.actions.append(("click", selector))
        self.clicks.append(selector)

    async def type_text(
        self, selector: str, text: str, *, timeout_seconds: float | None = None
    ) -> None:
        del timeout_seconds
        if self.closed:
            raise BrowserOperationError("page is already closed")
        failure = self.action_failures.get(selector) or self.type_failure
        if failure is not None:
            raise BrowserOperationError(failure)
        self.actions.append(("type", selector))
        self.typed.append((selector, text))

    async def append_text(
        self, selector: str, text: str, *, timeout_seconds: float | None = None
    ) -> None:
        del timeout_seconds
        if self.closed:
            raise BrowserOperationError("page is already closed")
        failure = self.action_failures.get(selector) or self.type_failure
        if failure is not None:
            raise BrowserOperationError(failure)
        self.actions.append(("append", selector))
        self.appended.append((selector, text))

    async def press_key(
        self, selector: str, key: str, *, timeout_seconds: float | None = None
    ) -> None:
        del timeout_seconds
        if self.closed:
            raise BrowserOperationError("page is already closed")
        failure = self.action_failures.get(selector)
        if failure is not None:
            raise BrowserOperationError(failure)
        self.actions.append(("press", selector))
        self.pressed.append((selector, key))

    async def select_option(
        self, selector: str, value: str, *, timeout_seconds: float | None = None
    ) -> None:
        del timeout_seconds
        if self.closed:
            raise BrowserOperationError("page is already closed")
        failure = self.action_failures.get(selector)
        if failure is not None:
            raise BrowserOperationError(failure)
        self.selected.append((selector, value))

    async def set_input_files(
        self, selector: str, paths: Sequence[str], *, timeout_seconds: float | None = None
    ) -> None:
        del timeout_seconds
        if self.closed:
            raise BrowserOperationError("page is already closed")
        failure = self.action_failures.get(selector)
        if failure is not None:
            raise BrowserOperationError(failure)
        self.actions.append(("files", selector))
        self.attachments.append((selector, tuple(paths)))

    async def scroll_by(self, pixels: int) -> None:
        if self.closed:
            raise BrowserOperationError("page is already closed")
        self.scrolls.append(pixels)

    async def wait(self, seconds: float) -> None:
        if self.closed:
            raise BrowserOperationError("page is already closed")
        self.waits.append(seconds)

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
    page_probe_results: dict[str, Any] = field(default_factory=dict)

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
            probe_results=dict(self.page_probe_results),
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
    page_probe_results: dict[str, Any] = field(default_factory=dict)
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
            page_probe_results=dict(self.page_probe_results),
            page_navigation_failure=self.page_navigation_failure,
            new_page_failure=self.new_page_failure,
        )
        self.contexts.append(context)
        return context
