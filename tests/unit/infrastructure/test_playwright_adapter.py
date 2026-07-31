"""Error mapping for the Playwright-family adapter without starting a browser.

Stub library objects keep these checks deterministic; a real Chromium is exercised separately in
`tests/integration/infrastructure/test_playwright_browser_driver.py`.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from naver_blog_assistant.infrastructure.browser.playwright_driver import (
    PlaywrightContext,
    PlaywrightFrame,
    PlaywrightPage,
)
from naver_blog_assistant.ports.browser import BrowserOperationError


class _LibraryError(Exception):
    """Stands in for a driver-specific exception type."""


class _StubFrame:
    def __init__(self, *, url: str = "https://blog.naver.com/example", failing: bool = False):
        self.url = url
        self._failing = failing
        self.calls: list[tuple[str, Any]] = []

    async def evaluate(self, expression: str, argument: Any = None) -> Any:
        if self._failing:
            raise _LibraryError("execution context destroyed")
        self.calls.append((expression, argument))
        return "ok"


class _StubLocator:
    def __init__(self, page: _StubPage, selector: str, *, failing: bool) -> None:
        self._page = page
        self._selector = selector
        self._failing = failing

    @property
    def first(self) -> _StubLocator:
        return self

    def _record(self, name: str, *args: Any) -> None:
        if self._failing:
            raise _LibraryError(f"{name} failed")
        self._page.actions.append((name, self._selector, *args))

    async def scroll_into_view_if_needed(self, *, timeout: float) -> None:
        self._record("scroll_into_view", timeout)

    async def click(self, *, timeout: float) -> None:
        self._record("click", timeout)

    async def fill(self, value: str, *, timeout: float) -> None:
        self._record("fill", value, timeout)

    async def type(self, text: str, delay: float) -> None:  # noqa: A003 - library method name
        self._record("type", text, delay)

    async def select_option(self, value: str, *, timeout: float) -> None:
        self._record("select_option", value, timeout)


class _StubMouse:
    def __init__(self, page: _StubPage, *, failing: bool) -> None:
        self._page = page
        self._failing = failing

    async def wheel(self, x: int, y: int) -> None:
        if self._failing:
            raise _LibraryError("wheel failed")
        self._page.actions.append(("wheel", x, y))


class _StubPage:
    def __init__(self, *, failing: bool = False, frames: list[_StubFrame] | None = None):
        self.url = "https://blog.naver.com/example/1"
        self.frames = frames or [_StubFrame()]
        self._failing = failing
        self.navigations: list[tuple[str, float, str]] = []
        self.actions: list[tuple[Any, ...]] = []
        self.closed = False
        self.front = 0
        self.mouse = _StubMouse(self, failing=failing)

    def locator(self, selector: str) -> _StubLocator:
        return _StubLocator(self, selector, failing=self._failing)

    async def wait_for_timeout(self, milliseconds: float) -> None:
        if self._failing:
            raise _LibraryError("wait failed")
        self.actions.append(("wait_for_timeout", milliseconds))

    async def goto(self, url: str, *, timeout: float, wait_until: str) -> None:
        if self._failing:
            raise _LibraryError("net::ERR_ABORTED")
        self.navigations.append((url, timeout, wait_until))

    async def evaluate(self, expression: str, argument: Any = None) -> Any:
        if self._failing:
            raise _LibraryError("evaluation failed")
        return len(expression)

    async def screenshot(self, *, type: str) -> bytes:  # noqa: A002 - library keyword name
        if self._failing:
            raise _LibraryError("capture failed")
        return b"\x89PNG" + type.encode()

    async def close(self) -> None:
        if self._failing:
            raise _LibraryError("target closed")
        self.closed = True

    async def bring_to_front(self) -> None:
        if self._failing:
            raise _LibraryError("no window")
        self.front += 1


class _StubContext:
    def __init__(self, *, pages: list[_StubPage] | None = None, failing: bool = False):
        self.pages = pages if pages is not None else [_StubPage()]
        self._failing = failing
        self.closed = False

    async def new_page(self) -> _StubPage:
        if self._failing:
            raise _LibraryError("too many tabs")
        page = _StubPage()
        self.pages.append(page)
        return page

    async def close(self) -> None:
        self.closed = True


class _StubRuntime:
    def __init__(self) -> None:
        self.stopped = 0

    async def stop(self) -> None:
        self.stopped += 1


def test_navigation_uses_millisecond_timeout_and_dom_content_loaded() -> None:
    stub = _StubPage()

    asyncio.run(PlaywrightPage(stub).goto("https://blog.naver.com/example/1", timeout_seconds=5))

    assert stub.navigations == [("https://blog.naver.com/example/1", 5_000, "domcontentloaded")]


def test_navigation_falls_back_to_the_default_timeout() -> None:
    stub = _StubPage()

    asyncio.run(PlaywrightPage(stub).goto("https://blog.naver.com/example/1"))

    assert stub.navigations[0][1] == 20_000


def test_navigation_failure_maps_to_a_browser_operation_error() -> None:
    with pytest.raises(BrowserOperationError, match="navigation failed"):
        asyncio.run(PlaywrightPage(_StubPage(failing=True)).goto("https://blog.naver.com/"))


def test_page_evaluation_failure_maps_to_a_browser_operation_error() -> None:
    with pytest.raises(BrowserOperationError, match="page evaluation failed"):
        asyncio.run(PlaywrightPage(_StubPage(failing=True)).evaluate("() => 1"))


def test_screenshot_requests_png_bytes() -> None:
    image = asyncio.run(PlaywrightPage(_StubPage()).screenshot())

    assert image.startswith(b"\x89PNG")
    assert image.endswith(b"png")


def test_a_click_scrolls_the_target_into_view_first() -> None:
    stub = _StubPage()

    asyncio.run(PlaywrightPage(stub).click("#like", timeout_seconds=3))

    assert stub.actions == [("scroll_into_view", "#like", 3_000), ("click", "#like", 3_000)]


def test_a_click_falls_back_to_the_default_action_timeout() -> None:
    stub = _StubPage()

    asyncio.run(PlaywrightPage(stub).click("#like"))

    assert stub.actions[0][2] == 10_000


def test_click_failure_maps_to_a_browser_operation_error() -> None:
    with pytest.raises(BrowserOperationError, match="trusted click failed"):
        asyncio.run(PlaywrightPage(_StubPage(failing=True)).click("#like"))


def test_typing_clears_the_field_before_sending_key_events() -> None:
    stub = _StubPage()

    asyncio.run(PlaywrightPage(stub).type_text("#editor", "댓글", timeout_seconds=2))

    assert [action[0] for action in stub.actions] == [
        "scroll_into_view",
        "click",
        "fill",
        "type",
    ]
    assert stub.actions[2] == ("fill", "#editor", "", 2_000)
    assert stub.actions[3] == ("type", "#editor", "댓글", 25)


def test_typing_failure_maps_to_a_browser_operation_error() -> None:
    with pytest.raises(BrowserOperationError, match="trusted typing failed"):
        asyncio.run(PlaywrightPage(_StubPage(failing=True)).type_text("#editor", "댓글"))


def test_selecting_an_option_passes_the_value_and_timeout() -> None:
    stub = _StubPage()

    asyncio.run(PlaywrightPage(stub).select_option("#group", "1", timeout_seconds=4))

    assert stub.actions == [("select_option", "#group", "1", 4_000)]


def test_option_selection_failure_maps_to_a_browser_operation_error() -> None:
    with pytest.raises(BrowserOperationError, match="option selection failed"):
        asyncio.run(PlaywrightPage(_StubPage(failing=True)).select_option("#group", "1"))


def test_scrolling_uses_the_mouse_wheel() -> None:
    stub = _StubPage()

    asyncio.run(PlaywrightPage(stub).scroll_by(400))

    assert stub.actions == [("wheel", 0, 400)]


def test_scrolling_failure_maps_to_a_browser_operation_error() -> None:
    with pytest.raises(BrowserOperationError, match="scrolling failed"):
        asyncio.run(PlaywrightPage(_StubPage(failing=True)).scroll_by(400))


def test_waiting_converts_seconds_to_milliseconds_and_clamps_negatives() -> None:
    stub = _StubPage()
    page = PlaywrightPage(stub)

    asyncio.run(page.wait(0.25))
    asyncio.run(page.wait(-5))

    assert stub.actions == [("wait_for_timeout", 250.0), ("wait_for_timeout", 0.0)]


def test_waiting_failure_maps_to_a_browser_operation_error() -> None:
    with pytest.raises(BrowserOperationError, match="waiting failed"):
        asyncio.run(PlaywrightPage(_StubPage(failing=True)).wait(0.1))


def test_screenshot_failure_maps_to_a_browser_operation_error() -> None:
    with pytest.raises(BrowserOperationError, match="screenshot failed"):
        asyncio.run(PlaywrightPage(_StubPage(failing=True)).screenshot())


def test_close_ignores_an_already_closed_target() -> None:
    asyncio.run(PlaywrightPage(_StubPage(failing=True)).close())


def test_page_exposes_the_current_url_and_wrapped_frames() -> None:
    page = PlaywrightPage(_StubPage(frames=[_StubFrame(), _StubFrame(url="https://frame")]))

    assert page.url == "https://blog.naver.com/example/1"
    assert [frame.url for frame in page.frames] == [
        "https://blog.naver.com/example",
        "https://frame",
    ]


def test_frame_evaluation_returns_values_and_maps_failures() -> None:
    frame = _StubFrame()

    assert asyncio.run(PlaywrightFrame(frame).evaluate("() => 1", {"a": 1})) == "ok"
    assert frame.calls == [("() => 1", {"a": 1})]
    with pytest.raises(BrowserOperationError, match="frame evaluation failed"):
        asyncio.run(PlaywrightFrame(_StubFrame(failing=True)).evaluate("() => 1"))


def test_context_wraps_pages_and_opens_new_tabs() -> None:
    stub = _StubContext()
    context = PlaywrightContext(stub, _StubRuntime())

    page = asyncio.run(context.new_page())

    assert len(context.pages) == 2
    assert page.url == "https://blog.naver.com/example/1"


def test_new_tab_failure_maps_to_a_browser_operation_error() -> None:
    context = PlaywrightContext(_StubContext(failing=True), _StubRuntime())

    with pytest.raises(BrowserOperationError, match="could not open a new tab"):
        asyncio.run(context.new_page())


def test_focus_requires_at_least_one_tab() -> None:
    context = PlaywrightContext(_StubContext(pages=[]), _StubRuntime())

    with pytest.raises(BrowserOperationError, match="no tab to focus"):
        asyncio.run(context.bring_to_front())


def test_focus_raises_the_first_tab() -> None:
    page = _StubPage()
    context = PlaywrightContext(_StubContext(pages=[page]), _StubRuntime())

    asyncio.run(context.bring_to_front())

    assert page.front == 1


def test_focus_failure_maps_to_a_browser_operation_error() -> None:
    context = PlaywrightContext(_StubContext(pages=[_StubPage(failing=True)]), _StubRuntime())

    with pytest.raises(BrowserOperationError, match="could not focus"):
        asyncio.run(context.bring_to_front())


def test_close_stops_the_runtime_even_when_the_context_fails() -> None:
    runtime = _StubRuntime()

    class _FailingContext(_StubContext):
        async def close(self) -> None:
            raise _LibraryError("context stuck")

    context = PlaywrightContext(_FailingContext(), runtime)

    with pytest.raises(_LibraryError):
        asyncio.run(context.close())
    assert runtime.stopped == 1


def test_close_stops_the_runtime_after_a_clean_shutdown() -> None:
    stub = _StubContext()
    runtime = _StubRuntime()

    asyncio.run(PlaywrightContext(stub, runtime).close())

    assert stub.closed is True
    assert runtime.stopped == 1
