"""Lifecycle, login observation, and failure scenarios for the browser session manager."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from naver_blog_assistant.application.automation import (
    LOGIN_PROBE_URL,
    LOGIN_STATE_EXPRESSION,
    BrowserSessionAlreadyRunningError,
    BrowserSessionBusyError,
    BrowserSessionManager,
    BrowserSessionNotRunningError,
    BrowserSessionOperationFailedError,
    BrowserSessionUnavailableError,
)
from naver_blog_assistant.domain import BrowserLoginState, BrowserSessionState
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver

PROFILE = Path("/profiles/automation")


def manager(driver: FakeBrowserDriver, *, headless: bool = True) -> BrowserSessionManager:
    return BrowserSessionManager(driver, profile_dir=PROFILE, headless=headless, channel="chrome")


def driver_with_login(state: Any) -> FakeBrowserDriver:
    return FakeBrowserDriver(page_results={LOGIN_STATE_EXPRESSION: state})


def test_status_before_launch_reports_a_stopped_session() -> None:
    status = manager(FakeBrowserDriver()).status()

    assert status.state is BrowserSessionState.STOPPED
    assert status.login is BrowserLoginState.UNKNOWN
    assert status.open_pages == 0
    assert status.profile_dir == str(PROFILE)


def test_launch_opens_the_profile_and_observes_authentication() -> None:
    driver = driver_with_login("authenticated")
    sessions = manager(driver, headless=False)

    status = asyncio.run(sessions.launch())

    assert status.state is BrowserSessionState.READY
    assert status.login is BrowserLoginState.AUTHENTICATED
    assert driver.launches == [(PROFILE, False, "chrome")]
    assert driver.contexts[0].open_tabs[0].navigations == [LOGIN_PROBE_URL]


def test_launch_reports_an_anonymous_session_when_a_login_form_is_present() -> None:
    sessions = manager(driver_with_login("anonymous"))

    status = asyncio.run(sessions.launch())

    assert status.login is BrowserLoginState.ANONYMOUS


@pytest.mark.parametrize("observed", [None, "", "signed-in", 3, {"state": "authenticated"}])
def test_unrecognized_login_probe_results_fail_closed_to_unknown(observed: Any) -> None:
    sessions = manager(driver_with_login(observed))

    status = asyncio.run(sessions.launch())

    assert status.login is BrowserLoginState.UNKNOWN


def test_login_probe_navigation_failure_keeps_the_session_ready_with_a_detail() -> None:
    sessions = manager(FakeBrowserDriver(page_navigation_failure="navigation blocked"))

    status = asyncio.run(sessions.launch())

    assert status.state is BrowserSessionState.READY
    assert status.login is BrowserLoginState.UNKNOWN
    assert status.detail == "로그인 상태를 확인하지 못했습니다."


def test_login_probe_evaluation_failure_falls_back_to_unknown() -> None:
    driver = driver_with_login("authenticated")
    sessions = manager(driver)

    async def scenario() -> Any:
        await sessions.launch()
        driver.contexts[0].open_tabs[0].evaluate_failure = "isolated context missing"
        return await sessions.refresh_login_state()

    status = asyncio.run(scenario())

    assert status.login is BrowserLoginState.UNKNOWN
    assert status.detail == "로그인 상태를 확인하지 못했습니다."


def test_login_probe_tab_failure_keeps_the_session_ready() -> None:
    sessions = manager(FakeBrowserDriver(new_page_failure="tab limit reached"))

    status = asyncio.run(sessions.launch())

    assert status.state is BrowserSessionState.READY
    assert status.login is BrowserLoginState.UNKNOWN
    assert status.open_pages == 0


def test_second_launch_is_rejected_while_a_session_is_running() -> None:
    sessions = manager(driver_with_login("authenticated"))

    async def scenario() -> None:
        await sessions.launch()
        await sessions.launch()

    with pytest.raises(BrowserSessionAlreadyRunningError):
        asyncio.run(scenario())


def test_launch_failure_returns_the_session_to_stopped() -> None:
    sessions = manager(FakeBrowserDriver(launch_failure="chrome channel missing"))

    with pytest.raises(BrowserSessionUnavailableError, match="chrome channel missing"):
        asyncio.run(sessions.launch())
    assert sessions.state is BrowserSessionState.STOPPED
    assert sessions.status().detail is not None


def test_launch_is_possible_again_after_a_failed_attempt() -> None:
    driver = FakeBrowserDriver(launch_failure="chrome channel missing")
    sessions = manager(driver)

    async def scenario() -> Any:
        with pytest.raises(BrowserSessionUnavailableError):
            await sessions.launch()
        driver.launch_failure = None
        driver.page_results = {LOGIN_STATE_EXPRESSION: "authenticated"}
        return await sessions.launch()

    status = asyncio.run(scenario())

    assert status.state is BrowserSessionState.READY


def test_close_releases_the_context_and_resets_login_state() -> None:
    driver = driver_with_login("authenticated")
    sessions = manager(driver)

    async def scenario() -> Any:
        await sessions.launch()
        return await sessions.close()

    status = asyncio.run(scenario())

    assert status.state is BrowserSessionState.STOPPED
    assert status.login is BrowserLoginState.UNKNOWN
    assert status.open_pages == 0
    assert driver.contexts[0].closed is True


def test_close_without_a_session_is_rejected() -> None:
    with pytest.raises(BrowserSessionNotRunningError):
        asyncio.run(manager(FakeBrowserDriver()).close())


def test_close_failure_still_releases_the_session_and_reports_the_error() -> None:
    driver = driver_with_login("authenticated")
    sessions = manager(driver)

    async def scenario() -> None:
        await sessions.launch()
        driver.contexts[0].close_failure = "context did not exit"
        await sessions.close()

    with pytest.raises(BrowserSessionOperationFailedError, match="context did not exit"):
        asyncio.run(scenario())
    assert sessions.state is BrowserSessionState.STOPPED
    assert sessions.status().detail is not None


def test_focus_raises_the_window_on_a_live_session() -> None:
    driver = driver_with_login("authenticated")
    sessions = manager(driver)

    async def scenario() -> Any:
        await sessions.launch()
        return await sessions.focus()

    status = asyncio.run(scenario())

    assert status.state is BrowserSessionState.READY
    assert driver.contexts[0].front_requests == 1


def test_focus_without_a_session_is_rejected() -> None:
    with pytest.raises(BrowserSessionNotRunningError):
        asyncio.run(manager(FakeBrowserDriver()).focus())


def test_screenshot_returns_bytes_from_the_live_tab() -> None:
    sessions = manager(driver_with_login("authenticated"))

    async def scenario() -> bytes:
        await sessions.launch()
        return await sessions.screenshot()

    image = asyncio.run(scenario())

    assert image.startswith(b"\x89PNG")


def test_screenshot_without_a_session_is_rejected() -> None:
    with pytest.raises(BrowserSessionNotRunningError):
        asyncio.run(manager(FakeBrowserDriver()).screenshot())


def test_screenshot_failure_maps_to_an_operation_error() -> None:
    driver = driver_with_login("authenticated")
    sessions = manager(driver)

    async def scenario() -> bytes:
        await sessions.launch()
        driver.contexts[0].open_tabs[0].screenshot_failure = "capture rejected"
        return await sessions.screenshot()

    with pytest.raises(BrowserSessionOperationFailedError, match="capture rejected"):
        asyncio.run(scenario())


def test_refresh_login_state_re_observes_a_live_session() -> None:
    driver = driver_with_login("anonymous")
    sessions = manager(driver)

    async def scenario() -> Any:
        first = await sessions.launch()
        driver.contexts[0].open_tabs[0].results[LOGIN_STATE_EXPRESSION] = "authenticated"
        second = await sessions.refresh_login_state()
        return first, second

    first, second = asyncio.run(scenario())

    assert first.login is BrowserLoginState.ANONYMOUS
    assert second.login is BrowserLoginState.AUTHENTICATED


def test_refresh_login_state_without_a_session_is_rejected() -> None:
    with pytest.raises(BrowserSessionNotRunningError):
        asyncio.run(manager(FakeBrowserDriver()).refresh_login_state())


def test_primary_page_is_reused_across_operations() -> None:
    driver = driver_with_login("authenticated")
    sessions = manager(driver)

    async def scenario() -> tuple[int, bool]:
        await sessions.launch()
        first = await sessions.primary_page()
        second = await sessions.primary_page()
        return len(driver.contexts[0].pages), first is second

    open_pages, reused = asyncio.run(scenario())

    assert open_pages == 1
    assert reused is True


def test_shutdown_is_safe_without_a_session() -> None:
    sessions = manager(FakeBrowserDriver())

    asyncio.run(sessions.shutdown())

    assert sessions.state is BrowserSessionState.STOPPED


def test_shutdown_closes_a_live_session_and_ignores_close_failures() -> None:
    driver = driver_with_login("authenticated")
    sessions = manager(driver)

    async def scenario() -> None:
        await sessions.launch()
        driver.contexts[0].close_failure = "context did not exit"
        await sessions.shutdown()

    asyncio.run(scenario())

    assert sessions.state is BrowserSessionState.STOPPED


def test_focus_failure_maps_to_an_operation_error() -> None:
    driver = driver_with_login("authenticated")
    sessions = manager(driver)

    async def scenario() -> None:
        await sessions.launch()
        driver.contexts[0].front_failure = "window manager unavailable"
        await sessions.focus()

    with pytest.raises(BrowserSessionOperationFailedError, match="window manager unavailable"):
        asyncio.run(scenario())


class _SlowDriver:
    """Driver whose launch blocks until the test releases it, exposing in-flight states."""

    name = "slow-fake"

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.started = asyncio.Event()
        self.inner = driver_with_login("authenticated")

    async def launch(self, **kwargs: Any) -> Any:
        self.started.set()
        await self.release.wait()
        return await self.inner.launch(**kwargs)


def test_concurrent_launch_is_rejected_while_the_first_is_still_starting() -> None:
    slow = _SlowDriver()
    sessions = BrowserSessionManager(slow, profile_dir=PROFILE, headless=True)

    async def scenario() -> None:
        first = asyncio.create_task(sessions.launch())
        await slow.started.wait()
        assert sessions.state is BrowserSessionState.LAUNCHING
        try:
            with pytest.raises(BrowserSessionBusyError):
                await sessions.launch()
            with pytest.raises(BrowserSessionBusyError):
                await sessions.close()
        finally:
            slow.release.set()
            await first

    asyncio.run(scenario())
    assert sessions.state is BrowserSessionState.READY


def test_status_during_launch_reports_no_pages_and_unknown_login() -> None:
    slow = _SlowDriver()
    sessions = BrowserSessionManager(slow, profile_dir=PROFILE, headless=True)

    async def scenario() -> Any:
        first = asyncio.create_task(sessions.launch())
        await slow.started.wait()
        snapshot = sessions.status()
        slow.release.set()
        await first
        return snapshot

    snapshot = asyncio.run(scenario())

    assert snapshot.state is BrowserSessionState.LAUNCHING
    assert snapshot.login is BrowserLoginState.UNKNOWN
    assert snapshot.open_pages == 0
