"""Tests for browser driver selection and the deterministic in-memory driver."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from naver_blog_assistant.infrastructure.browser import (
    FakeBrowserDriver,
    PlaywrightBrowserDriver,
    create_browser_driver,
)
from naver_blog_assistant.infrastructure.browser.fake import FakeFrame, FakePage
from naver_blog_assistant.ports.browser import BrowserLaunchError, BrowserOperationError


class _Runtime:
    def __init__(self) -> None:
        self.chromium = _Chromium()
        self.stopped = False

    async def stop(self) -> None:
        self.stopped = True


class _Chromium:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def launch_persistent_context(self, **options: object) -> object:
        self.calls.append(options)
        if "channel" in options:
            raise RuntimeError("configured browser is missing")
        return _Context()


class _Context:
    async def close(self) -> None:
        return


class _AsyncPlaywright:
    def __init__(self, runtime: _Runtime) -> None:
        self._runtime = runtime

    async def start(self) -> _Runtime:
        return self._runtime


class _Module:
    def __init__(self, runtime: _Runtime) -> None:
        self._runtime = runtime

    def async_playwright(self) -> _AsyncPlaywright:
        return _AsyncPlaywright(self._runtime)


def test_patchright_is_the_default_configured_driver() -> None:
    driver = create_browser_driver("patchright")

    assert isinstance(driver, PlaywrightBrowserDriver)
    assert driver.module_name == "patchright.async_api"


def test_playwright_stays_available_as_a_fallback() -> None:
    driver = create_browser_driver("PLAYWRIGHT")

    assert isinstance(driver, PlaywrightBrowserDriver)
    assert driver.module_name == "playwright.async_api"


def test_fake_driver_is_selectable_for_tests() -> None:
    assert isinstance(create_browser_driver("  fake "), FakeBrowserDriver)


@pytest.mark.parametrize("name", ["", "selenium", "puppeteer", "patch right"])
def test_unknown_driver_names_are_rejected(name: str) -> None:
    with pytest.raises(ValueError, match="AUTOMATION_DRIVER"):
        create_browser_driver(name)


def test_missing_driver_module_reports_a_launch_error(tmp_path: Path) -> None:
    driver = PlaywrightBrowserDriver(name="missing", module_name="no_such_driver_module")

    with pytest.raises(BrowserLaunchError, match="not installed"):
        asyncio.run(driver.launch(profile_dir=tmp_path, headless=True))


def test_configured_channel_falls_back_to_bundled_chromium(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = _Runtime()
    monkeypatch.setattr(
        "naver_blog_assistant.infrastructure.browser.playwright_driver.import_module",
        lambda _: _Module(runtime),
    )
    driver = PlaywrightBrowserDriver(name="patchright", module_name="patchright.async_api")

    context = asyncio.run(driver.launch(profile_dir=tmp_path, headless=True, channel="chrome"))

    assert runtime.chromium.calls[0]["channel"] == "chrome"
    assert "channel" not in runtime.chromium.calls[1]
    asyncio.run(context.close())
    assert runtime.stopped


def test_fake_launch_records_profile_headless_and_channel(tmp_path: Path) -> None:
    driver = FakeBrowserDriver()

    context = asyncio.run(driver.launch(profile_dir=tmp_path, headless=True, channel="chrome"))

    assert driver.launches == [(tmp_path, True, "chrome")]
    assert context.pages == ()


def test_fake_launch_failure_surfaces_as_launch_error(tmp_path: Path) -> None:
    driver = FakeBrowserDriver(launch_failure="binary missing")

    with pytest.raises(BrowserLaunchError, match="binary missing"):
        asyncio.run(driver.launch(profile_dir=tmp_path, headless=False))


def test_fake_page_records_navigation_and_evaluation(tmp_path: Path) -> None:
    driver = FakeBrowserDriver(page_results={"probe": "authenticated"})

    async def scenario() -> tuple[str, object, int]:
        context = await driver.launch(profile_dir=tmp_path, headless=True)
        page = await context.new_page()
        await page.goto("https://blog.naver.com/")
        observed = await page.evaluate("probe")
        image = await page.screenshot()
        return page.url, observed, len(image)

    url, observed, image_size = asyncio.run(scenario())

    assert url == "https://blog.naver.com/"
    assert observed == "authenticated"
    assert image_size > 0


def test_fake_page_reports_main_frame_and_child_frames(tmp_path: Path) -> None:
    driver = FakeBrowserDriver()

    async def scenario() -> tuple[int, str]:
        context = await driver.launch(profile_dir=tmp_path, headless=True)
        page = await context.new_page()
        assert isinstance(page, FakePage)
        page.child_frames.append(FakeFrame(url="https://blog.naver.com/frame", results={"*": 1}))
        await page.goto("https://blog.naver.com/main")
        return len(page.frames), page.frames[1].url

    frame_count, child_url = asyncio.run(scenario())

    assert frame_count == 2
    assert child_url == "https://blog.naver.com/frame"


def test_fake_page_operations_fail_after_close(tmp_path: Path) -> None:
    driver = FakeBrowserDriver()

    async def scenario() -> None:
        context = await driver.launch(profile_dir=tmp_path, headless=True)
        page = await context.new_page()
        await page.close()
        await page.goto("https://blog.naver.com/")

    with pytest.raises(BrowserOperationError, match="already closed"):
        asyncio.run(scenario())


def test_fake_context_closes_every_open_tab(tmp_path: Path) -> None:
    driver = FakeBrowserDriver()

    async def scenario() -> tuple[int, bool]:
        context = await driver.launch(profile_dir=tmp_path, headless=True)
        await context.new_page()
        await context.new_page()
        await context.close()
        return len(context.pages), context.closed

    open_pages, closed = asyncio.run(scenario())

    assert open_pages == 0
    assert closed is True


def test_fake_frame_evaluation_failure_is_reported(tmp_path: Path) -> None:
    frame = FakeFrame(failure="isolated context missing")

    with pytest.raises(BrowserOperationError, match="isolated context missing"):
        asyncio.run(frame.evaluate("() => 1"))
    assert tmp_path.exists()
