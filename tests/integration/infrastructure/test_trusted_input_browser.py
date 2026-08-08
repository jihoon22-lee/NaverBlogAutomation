"""Drive the trusted input actions against a real browser and synthetic fixtures.

These checks prove what a synthetic `element.click()` cannot: the adapter's click and typing arrive
as browser-generated events (`isTrusted === true`), so handlers that ignore scripted events still
run. Skipped when no browser binary is installed.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from importlib import import_module
from pathlib import Path
from typing import Any

import pytest

from naver_blog_assistant.infrastructure.browser import create_browser_driver
from naver_blog_assistant.infrastructure.browser.playwright_driver import PlaywrightBrowserDriver
from naver_blog_assistant.ports.browser import BrowserOperationError

INTERACTIVE_PAGE = """
<html><head><title>합성 조작 문서</title>
<style>body { height: 4000px; }</style></head>
<body>
  <a id="like" role="button" href="#" aria-pressed="false" data-trusted="none" data-clicks="0">
    공감
  </a>
  <textarea id="editor" data-input-trusted="none" data-input-events="0"></textarea>
  <select id="group"><option value="">선택</option><option value="1">이웃 그룹</option></select>
  <script>
    // Observations live in the DOM because `evaluate` runs in an isolated world and cannot read
    // this world's globals.
    document.getElementById("like").addEventListener("click", (event) => {
      event.preventDefault();
      const target = event.currentTarget;
      target.dataset.trusted = String(event.isTrusted);
      target.dataset.clicks = String(Number(target.dataset.clicks) + 1);
      target.setAttribute("aria-pressed", "true");
    });
    document.getElementById("editor").addEventListener("input", (event) => {
      const target = event.currentTarget;
      target.dataset.inputTrusted = String(event.isTrusted);
      target.dataset.inputEvents = String(Number(target.dataset.inputEvents) + 1);
    });
  </script>
</body></html>
"""


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


def _driver_or_skip() -> PlaywrightBrowserDriver:
    driver = create_browser_driver("patchright")
    assert isinstance(driver, PlaywrightBrowserDriver)
    if not _browser_available(driver.module_name):
        pytest.skip("the automation browser binary is not installed")
    return driver


def _run(scenario: Callable[[], Any]) -> Any:
    return asyncio.run(scenario())


def _document(tmp_path: Path, html: str) -> str:
    path = tmp_path / "interactive.html"
    path.write_text(html, encoding="utf-8")
    return path.as_uri()


def test_actions_reach_the_page_as_trusted_events(tmp_path: Path) -> None:
    driver = _driver_or_skip()
    url = _document(tmp_path, INTERACTIVE_PAGE)

    async def scenario() -> dict[str, Any]:
        context = await driver.launch(profile_dir=tmp_path / "profile", headless=True)
        try:
            page = await context.new_page()
            await page.goto(url)
            await page.click("#like")
            await page.type_text("#editor", "합성 댓글입니다.")
            await page.select_option("#group", "1")
            await page.scroll_by(600)
            await page.wait(0.05)
            return await page.evaluate(
                "() => {"
                " const like = document.getElementById('like');"
                " const editor = document.getElementById('editor');"
                " return {"
                "  likeTrusted: like.dataset.trusted,"
                "  likeClicks: Number(like.dataset.clicks),"
                "  inputTrusted: editor.dataset.inputTrusted,"
                "  inputEvents: Number(editor.dataset.inputEvents),"
                "  pressed: like.getAttribute('aria-pressed'),"
                "  value: editor.value,"
                "  group: document.getElementById('group').value,"
                "  scrolled: window.scrollY > 0"
                " };"
                "}"
            )
        finally:
            await context.close()

    observed = _run(scenario)

    assert observed["likeTrusted"] == "true"
    assert observed["likeClicks"] == 1
    assert observed["inputTrusted"] == "true"
    assert observed["inputEvents"] > 0
    assert observed["pressed"] == "true"
    assert observed["value"] == "합성 댓글입니다."
    assert observed["group"] == "1"
    assert observed["scrolled"] is True


def test_typing_replaces_an_occupied_field_without_appending(tmp_path: Path) -> None:
    driver = _driver_or_skip()
    url = _document(tmp_path, INTERACTIVE_PAGE)

    async def scenario() -> str:
        context = await driver.launch(profile_dir=tmp_path / "profile", headless=True)
        try:
            page = await context.new_page()
            await page.goto(url)
            await page.evaluate("() => { document.getElementById('editor').value = '이전 값'; }")
            await page.type_text("#editor", "새 댓글")
            return await page.evaluate("() => document.getElementById('editor').value")
        finally:
            await context.close()

    assert _run(scenario) == "새 댓글"


def test_append_and_enter_keep_trusted_input_at_the_existing_caret(tmp_path: Path) -> None:
    driver = _driver_or_skip()
    url = _document(tmp_path, INTERACTIVE_PAGE)

    async def scenario() -> dict[str, Any]:
        context = await driver.launch(profile_dir=tmp_path / "profile", headless=True)
        try:
            page = await context.new_page()
            await page.goto(url)
            await page.type_text("#editor", "첫 줄")
            await page.append_text("#editor", " 다음")
            await page.press_key("#editor", "Enter")
            await page.append_text("#editor", "둘째 줄")
            return await page.evaluate(
                "() => {"
                " const editor = document.getElementById('editor');"
                " return { trusted: editor.dataset.inputTrusted, value: editor.value };"
                "}"
            )
        finally:
            await context.close()

    observed = _run(scenario)

    assert observed["trusted"] == "true"
    assert observed["value"] == "첫 줄 다음\n둘째 줄"


def test_a_missing_target_fails_closed_instead_of_guessing(tmp_path: Path) -> None:
    driver = _driver_or_skip()
    url = _document(tmp_path, INTERACTIVE_PAGE)

    async def scenario() -> None:
        context = await driver.launch(profile_dir=tmp_path / "profile", headless=True)
        try:
            page = await context.new_page()
            await page.goto(url)
            await page.click("#missing", timeout_seconds=1)
        finally:
            await context.close()

    with pytest.raises(BrowserOperationError, match="trusted click failed"):
        _run(scenario)
