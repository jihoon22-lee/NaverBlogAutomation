"""Own exactly one browser session for the local automation surface.

The session is a persistent-profile window that the user signs in to manually. This module never
reads credentials or cookies: it observes only a public page's sign-in affordances, and it fails
closed when the state cannot be determined.
"""

from __future__ import annotations

from contextlib import suppress
from pathlib import Path
from typing import Final

from naver_blog_assistant.application.automation.errors import (
    BrowserSessionAlreadyRunningError,
    BrowserSessionBusyError,
    BrowserSessionNotRunningError,
    BrowserSessionOperationFailedError,
    BrowserSessionUnavailableError,
)
from naver_blog_assistant.domain.automation import (
    BrowserLoginState,
    BrowserSessionState,
    BrowserSessionStatus,
    assert_session_transition,
)
from naver_blog_assistant.ports.browser import (
    BrowserContextHandle,
    BrowserDriver,
    BrowserLaunchError,
    BrowserOperationError,
    PageHandle,
)

LOGIN_PROBE_URL: Final = "https://blog.naver.com/"
LOGIN_PROBE_TIMEOUT_SECONDS: Final = 20.0
LOGIN_STATE_EXPRESSION: Final = """() => {
  const hrefs = Array.from(document.querySelectorAll('a[href]')).map(
    (anchor) => anchor.getAttribute('href') || ''
  );
  if (hrefs.some((href) => href.includes('nid.naver.com/nidlogin.logout'))) return 'authenticated';
  if (document.querySelector('.btn_logout, [data-click-area="gnb.logout"]')) return 'authenticated';
  if (hrefs.some((href) => href.includes('nid.naver.com/nidlogin.login'))) return 'anonymous';
  if (document.querySelector('#id.int_id, form[action*="nidlogin.login"]')) return 'anonymous';
  return 'unknown';
}"""


class BrowserSessionManager:
    """Serialize lifecycle operations on the single locally owned browser context."""

    def __init__(
        self,
        driver: BrowserDriver,
        *,
        profile_dir: Path,
        headless: bool,
        channel: str | None = None,
        login_probe_url: str = LOGIN_PROBE_URL,
    ) -> None:
        self._driver = driver
        self._profile_dir = profile_dir
        self._headless = headless
        self._channel = channel
        self._login_probe_url = login_probe_url
        self._state = BrowserSessionState.STOPPED
        self._login = BrowserLoginState.UNKNOWN
        self._context: BrowserContextHandle | None = None
        self._detail: str | None = None

    @property
    def state(self) -> BrowserSessionState:
        """Return the current lifecycle state."""
        return self._state

    def status(self) -> BrowserSessionStatus:
        """Return a redacted snapshot without touching the browser."""
        context = self._context
        return BrowserSessionStatus(
            state=self._state,
            login=self._login,
            driver=self._driver.name,
            headless=self._headless,
            profile_dir=str(self._profile_dir),
            open_pages=len(context.pages) if context is not None else 0,
            detail=self._detail,
        )

    async def launch(self) -> BrowserSessionStatus:
        """Start the session, then observe the public sign-in state once."""
        if self._state is BrowserSessionState.READY:
            raise BrowserSessionAlreadyRunningError("the automation browser is already running")
        if self._state is not BrowserSessionState.STOPPED:
            raise BrowserSessionBusyError("another browser lifecycle operation is in progress")
        assert_session_transition(self._state, BrowserSessionState.LAUNCHING)
        self._state = BrowserSessionState.LAUNCHING
        self._detail = None
        try:
            context = await self._driver.launch(
                profile_dir=self._profile_dir,
                headless=self._headless,
                channel=self._channel,
            )
        except BrowserLaunchError as error:
            self._state = BrowserSessionState.STOPPED
            self._detail = "브라우저를 시작하지 못했습니다."
            raise BrowserSessionUnavailableError(str(error)) from error
        self._context = context
        assert_session_transition(self._state, BrowserSessionState.READY)
        self._state = BrowserSessionState.READY
        self._login = await self._probe_login_state()
        return self.status()

    async def close(self) -> BrowserSessionStatus:
        """Close the session and release the profile lock."""
        if self._state is BrowserSessionState.STOPPED:
            raise BrowserSessionNotRunningError("the automation browser is not running")
        if self._state is not BrowserSessionState.READY:
            raise BrowserSessionBusyError("another browser lifecycle operation is in progress")
        context = self._context
        assert_session_transition(self._state, BrowserSessionState.CLOSING)
        self._state = BrowserSessionState.CLOSING
        try:
            if context is not None:
                await context.close()
        except BrowserOperationError as error:
            self._reset("브라우저를 정상 종료하지 못해 세션을 해제했습니다.")
            raise BrowserSessionOperationFailedError(str(error)) from error
        self._reset(None)
        return self.status()

    async def focus(self) -> BrowserSessionStatus:
        """Raise the automation window so the user can sign in or inspect it."""
        context = self._require_ready()
        try:
            await context.bring_to_front()
        except BrowserOperationError as error:
            raise BrowserSessionOperationFailedError(str(error)) from error
        return self.status()

    async def screenshot(self) -> bytes:
        """Return one in-memory PNG capture of the active tab."""
        page = await self.primary_page()
        try:
            return await page.screenshot()
        except BrowserOperationError as error:
            raise BrowserSessionOperationFailedError(str(error)) from error

    async def refresh_login_state(self) -> BrowserSessionStatus:
        """Re-observe the public sign-in state on a live session."""
        self._require_ready()
        self._login = await self._probe_login_state()
        return self.status()

    async def primary_page(self) -> PageHandle:
        """Return the reused automation tab, opening one when the context has none."""
        context = self._require_ready()
        existing = context.pages
        if existing:
            return existing[0]
        try:
            return await context.new_page()
        except BrowserOperationError as error:
            raise BrowserSessionOperationFailedError(str(error)) from error

    async def shutdown(self) -> None:
        """Best-effort cleanup used during application shutdown."""
        context = self._context
        if context is None:
            return
        with suppress(BrowserOperationError):
            await context.close()
        self._reset(None)

    def _require_ready(self) -> BrowserContextHandle:
        if self._state is not BrowserSessionState.READY or self._context is None:
            raise BrowserSessionNotRunningError("the automation browser is not running")
        return self._context

    def _reset(self, detail: str | None) -> None:
        self._context = None
        self._login = BrowserLoginState.UNKNOWN
        self._state = BrowserSessionState.STOPPED
        self._detail = detail

    async def _probe_login_state(self) -> BrowserLoginState:
        try:
            page = await self.primary_page()
            await page.goto(self._login_probe_url, timeout_seconds=LOGIN_PROBE_TIMEOUT_SECONDS)
            observed = await page.evaluate(LOGIN_STATE_EXPRESSION)
        except BrowserOperationError, BrowserSessionOperationFailedError:
            self._detail = "로그인 상태를 확인하지 못했습니다."
            return BrowserLoginState.UNKNOWN
        if isinstance(observed, str) and observed in {state.value for state in BrowserLoginState}:
            return BrowserLoginState(observed)
        return BrowserLoginState.UNKNOWN
