"""Adapter that drives a persistent-profile Chromium context through Playwright's async API.

`patchright` and `playwright` expose the same async surface, so this adapter imports the configured
module by name and keeps the launch arguments identical. No user agent, header, locale, timezone, or
viewport override is applied: a consistent real profile is safer than a spoofed one.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any

from naver_blog_assistant.ports.browser import (
    BrowserLaunchError,
    BrowserOperationError,
    FrameHandle,
    PageHandle,
)

DEFAULT_NAVIGATION_TIMEOUT_SECONDS = 20.0
_REMOVED_LAUNCH_ARGUMENTS = ("--enable-automation",)


@dataclass(slots=True)
class PlaywrightFrame:
    """Read-only view of one document inside a live page."""

    _frame: Any

    @property
    def url(self) -> str:
        return str(self._frame.url)

    async def evaluate(self, expression: str, argument: Any = None) -> Any:
        try:
            return await self._frame.evaluate(expression, argument)
        except Exception as error:  # noqa: BLE001 - provider exception types are library specific
            raise BrowserOperationError("frame evaluation failed") from error


@dataclass(slots=True)
class PlaywrightPage:
    """One live tab exposed through the browser port."""

    _page: Any

    @property
    def url(self) -> str:
        return str(self._page.url)

    @property
    def frames(self) -> Sequence[FrameHandle]:
        return tuple(PlaywrightFrame(frame) for frame in self._page.frames)

    async def goto(self, url: str, *, timeout_seconds: float | None = None) -> None:
        timeout = (
            timeout_seconds if timeout_seconds is not None else DEFAULT_NAVIGATION_TIMEOUT_SECONDS
        )
        try:
            await self._page.goto(url, timeout=timeout * 1_000, wait_until="domcontentloaded")
        except Exception as error:  # noqa: BLE001 - provider exception types are library specific
            raise BrowserOperationError("navigation failed") from error

    async def evaluate(self, expression: str, argument: Any = None) -> Any:
        try:
            return await self._page.evaluate(expression, argument)
        except Exception as error:  # noqa: BLE001 - provider exception types are library specific
            raise BrowserOperationError("page evaluation failed") from error

    async def screenshot(self) -> bytes:
        try:
            return bytes(await self._page.screenshot(type="png"))
        except Exception as error:  # noqa: BLE001 - provider exception types are library specific
            raise BrowserOperationError("screenshot failed") from error

    async def close(self) -> None:
        try:
            await self._page.close()
        except Exception:  # noqa: BLE001 - a closed target must not fail cleanup
            return


@dataclass(slots=True)
class PlaywrightContext:
    """A persistent-profile context plus the driver runtime that owns it."""

    _context: Any
    _runtime: Any

    @property
    def pages(self) -> Sequence[PageHandle]:
        return tuple(PlaywrightPage(page) for page in self._context.pages)

    async def new_page(self) -> PageHandle:
        try:
            return PlaywrightPage(await self._context.new_page())
        except Exception as error:  # noqa: BLE001 - provider exception types are library specific
            raise BrowserOperationError("could not open a new tab") from error

    async def bring_to_front(self) -> None:
        pages = self._context.pages
        if not pages:
            raise BrowserOperationError("the session has no tab to focus")
        try:
            await pages[0].bring_to_front()
        except Exception as error:  # noqa: BLE001 - provider exception types are library specific
            raise BrowserOperationError("could not focus the browser window") from error

    async def close(self) -> None:
        try:
            await self._context.close()
        finally:
            await self._runtime.stop()


@dataclass(slots=True)
class PlaywrightBrowserDriver:
    """Launch one persistent Chromium context using the configured driver module."""

    name: str
    module_name: str

    async def launch(
        self,
        *,
        profile_dir: Path,
        headless: bool,
        channel: str | None = None,
    ) -> PlaywrightContext:
        try:
            module = import_module(self.module_name)
        except ImportError as error:
            raise BrowserLaunchError(f"{self.name} is not installed") from error
        profile_dir.mkdir(parents=True, exist_ok=True)
        # `async_playwright()` returns a context manager; the started object owns `stop()`.
        runtime = await module.async_playwright().start()
        options: dict[str, Any] = {
            "user_data_dir": str(profile_dir),
            "headless": headless,
            "no_viewport": True,
            "ignore_default_args": list(_REMOVED_LAUNCH_ARGUMENTS),
        }
        if channel:
            options["channel"] = channel
        try:
            context = await runtime.chromium.launch_persistent_context(**options)
        except Exception as error:  # noqa: BLE001 - provider exception types are library specific
            await runtime.stop()
            reason = str(error).strip().splitlines()[0] if str(error).strip() else "unknown reason"
            raise BrowserLaunchError(
                f"could not start the automation browser: {reason[:200]}"
            ) from error
        return PlaywrightContext(context, runtime)
