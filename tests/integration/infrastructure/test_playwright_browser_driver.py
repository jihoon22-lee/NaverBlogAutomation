"""Integration checks against a real Chromium launched by the configured driver.

These tests verify the decisions recorded in the delivery plan: a persistent profile starts, the
`--enable-automation` flag is absent so `navigator.webdriver` stays false, and evaluation works in
the isolated context that patchright uses by default. They are skipped when no browser binary is
installed so a fresh checkout without `patchright install chromium` still passes.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from importlib import import_module
from pathlib import Path
from typing import Any

import pytest

from naver_blog_assistant.application.automation import BrowserSessionManager
from naver_blog_assistant.domain import BrowserSessionState
from naver_blog_assistant.infrastructure.browser import create_browser_driver
from naver_blog_assistant.infrastructure.browser.playwright_driver import PlaywrightBrowserDriver

DRIVERS = ("patchright", "playwright")


def _browser_available(module_name: str) -> bool:
    try:
        module = import_module(module_name)
    except ImportError:
        return False

    async def probe() -> bool:
        started = await module.async_playwright().start()
        try:
            return Path(started.chromium.executable_path).exists()
        finally:
            await started.stop()

    try:
        return asyncio.run(probe())
    except Exception:
        return False


def _driver_or_skip(name: str) -> PlaywrightBrowserDriver:
    driver = create_browser_driver(name)
    assert isinstance(driver, PlaywrightBrowserDriver)
    if not _browser_available(driver.module_name):
        pytest.skip(f"{name} browser binary is not installed")
    return driver


def _run(scenario: Callable[[], Any]) -> Any:
    return asyncio.run(scenario())


@pytest.mark.parametrize("name", DRIVERS)
def test_persistent_profile_launches_and_hides_the_automation_flag(
    name: str, tmp_path: Path
) -> None:
    driver = _driver_or_skip(name)
    profile = tmp_path / "profile"

    async def scenario() -> tuple[Any, str, bool]:
        context = await driver.launch(profile_dir=profile, headless=True)
        try:
            page = await context.new_page()
            await page.goto("about:blank")
            webdriver = await page.evaluate("() => navigator.webdriver")
            agent = await page.evaluate("() => navigator.userAgent")
            return webdriver, str(agent), profile.exists()
        finally:
            await context.close()

    webdriver, agent, profile_created = _run(scenario)

    assert webdriver in (False, None)
    assert agent
    assert profile_created


@pytest.mark.parametrize("name", DRIVERS)
def test_evaluation_reads_synthetic_dom_state(name: str, tmp_path: Path) -> None:
    driver = _driver_or_skip(name)
    document = tmp_path / "post.html"
    document.write_text(
        "<html><body><a href='https://nid.naver.com/nidlogin.logout'>로그아웃</a>"
        "<p id='body'>합성 본문</p></body></html>",
        encoding="utf-8",
    )

    async def scenario() -> tuple[Any, Any]:
        context = await driver.launch(profile_dir=tmp_path / "profile", headless=True)
        try:
            page = await context.new_page()
            await page.goto(document.as_uri())
            text = await page.evaluate("() => document.getElementById('body').textContent")
            logout_links = await page.evaluate(
                "() => document.querySelectorAll('a[href*=\"nidlogin.logout\"]').length"
            )
            return text, logout_links
        finally:
            await context.close()

    text, logout_links = _run(scenario)

    assert text == "합성 본문"
    assert logout_links == 1


@pytest.mark.parametrize("name", DRIVERS)
def test_session_manager_observes_authentication_on_a_synthetic_page(
    name: str, tmp_path: Path
) -> None:
    driver = _driver_or_skip(name)
    document = tmp_path / "signed-in.html"
    document.write_text(
        "<html><body><a href='https://nid.naver.com/nidlogin.logout'>로그아웃</a></body></html>",
        encoding="utf-8",
    )
    sessions = BrowserSessionManager(
        driver,
        profile_dir=tmp_path / "profile",
        headless=True,
        login_probe_url=document.as_uri(),
    )

    async def scenario() -> tuple[Any, Any]:
        try:
            launched = await sessions.launch()
            image = await sessions.screenshot()
            return launched, image
        finally:
            await sessions.shutdown()

    launched, image = _run(scenario)

    assert launched.state is BrowserSessionState.READY
    assert launched.login.value == "authenticated"
    assert image.startswith(b"\x89PNG")
    assert sessions.state is BrowserSessionState.STOPPED


@pytest.mark.parametrize("name", DRIVERS)
def test_frames_expose_child_documents_for_later_extraction(name: str, tmp_path: Path) -> None:
    driver = _driver_or_skip(name)
    child = tmp_path / "child.html"
    child.write_text("<html><body><p>frame 본문</p></body></html>", encoding="utf-8")
    parent = tmp_path / "parent.html"
    parent.write_text(
        f"<html><body><iframe src='{child.name}'></iframe></body></html>", encoding="utf-8"
    )

    async def scenario() -> list[str]:
        context = await driver.launch(profile_dir=tmp_path / "profile", headless=True)
        try:
            page = await context.new_page()
            await page.goto(parent.as_uri())
            await asyncio.sleep(0.5)
            return [
                str(await frame.evaluate("() => document.body ? document.body.innerText : ''"))
                for frame in page.frames
            ]
        finally:
            await context.close()

    texts = _run(scenario)

    assert any("frame 본문" in text for text in texts)
