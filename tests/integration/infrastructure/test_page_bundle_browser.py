"""Evaluate the built page bundle in a real browser against synthetic fixtures.

These checks prove the TypeScript probes and the Python runner agree: the bundle installs in the
isolated context, reports the same codes the Vitest suite asserts, and returns selectors that
resolve in the live document. Skipped when no browser binary is installed.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from importlib import import_module
from pathlib import Path
from typing import Any

import pytest

from naver_blog_assistant.infrastructure.browser import (
    PageScriptRunner,
    bundle_path,
    create_browser_driver,
)
from naver_blog_assistant.infrastructure.browser.playwright_driver import PlaywrightBrowserDriver

MODERN_POST = """
<html><head><title>합성 문서</title>
<link rel="canonical" href="https://blog.naver.com/example/223456789012" /></head>
<body>
  <div class="se-title-text"><span>합성 전시 후기</span></div>
  <div class="se-main-container"><p>합성 본문 문단입니다.</p><p>두 번째 문단입니다.</p></div>
  <div class="comment_area"><p>제외되어야 하는 댓글</p></div>
  <div class="area_sympathy" id="area_sympathy123">
    <div class="u_likeit_list_module _reactionModule_BLOG">
      <div class="my_reaction">
        <a class="u_likeit_button _face" role="button" href="#" aria-pressed="false">공감</a>
      </div>
    </div>
  </div>
  <div class="u_cbox_write_wrap">
    <div class="u_cbox_write_area"><textarea class="u_cbox_text"></textarea></div>
    <div class="u_cbox_upload"><button class="u_cbox_btn_upload">등록</button></div>
  </div>
  <a href="https://blog.naver.com/BuddyAddForm.naver?blogId=example">서로이웃추가</a>
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
    if not bundle_path().exists():
        pytest.skip("run `npm --prefix client run build:page` to build the page bundle")
    driver = create_browser_driver("patchright")
    assert isinstance(driver, PlaywrightBrowserDriver)
    if not _browser_available(driver.module_name):
        pytest.skip("the automation browser binary is not installed")
    return driver


def _run(scenario: Callable[[], Any]) -> Any:
    return asyncio.run(scenario())


def _document(tmp_path: Path, html: str, name: str = "post.html") -> str:
    path = tmp_path / name
    path.write_text(html, encoding="utf-8")
    return path.as_uri()


def test_bundle_probes_report_synthetic_page_state(tmp_path: Path) -> None:
    driver = _driver_or_skip()
    runner = PageScriptRunner()
    url = _document(tmp_path, MODERN_POST)

    async def scenario() -> dict[str, Any]:
        context = await driver.launch(profile_dir=tmp_path / "profile", headless=True)
        try:
            page = await context.new_page()
            await page.goto(url)
            return {
                "article": await runner.call(page, "captureArticle"),
                "like": await runner.call(page, "probeLike"),
                "comment": await runner.call(page, "probeComment", "합성 댓글"),
                "neighbor": await runner.call(page, "probeNeighborRelationship"),
                "captcha": await runner.call(page, "captchaVisible"),
                "diagnosis": await runner.call(page, "diagnoseCommentPage"),
            }
        finally:
            await context.close()

    observed = _run(scenario)

    assert observed["article"]["selectorKind"] == "modern"
    assert observed["article"]["title"] == "합성 전시 후기"
    assert "합성 본문 문단입니다." in observed["article"]["body"]
    assert "제외되어야 하는 댓글" not in observed["article"]["body"]
    assert observed["article"]["canonicalUrl"] == "https://blog.naver.com/example/223456789012"
    assert observed["like"]["code"] == "ready"
    assert observed["comment"]["code"] == "ready"
    assert observed["neighbor"]["state"] == "can_request"
    assert observed["captcha"] is False
    assert observed["diagnosis"] == {"blocked": False, "captcha": False, "loginRequired": False}


def test_reported_selectors_resolve_to_exactly_one_live_element(tmp_path: Path) -> None:
    driver = _driver_or_skip()
    runner = PageScriptRunner()
    url = _document(tmp_path, MODERN_POST)

    async def scenario() -> list[int]:
        context = await driver.launch(profile_dir=tmp_path / "profile", headless=True)
        try:
            page = await context.new_page()
            await page.goto(url)
            like = await runner.call(page, "probeLike")
            comment = await runner.call(page, "probeComment", "합성 댓글")
            neighbor = await runner.call(page, "probeNeighborRelationship")
            selectors = [
                like["selector"],
                comment["editorSelector"],
                comment["submitSelector"],
                neighbor["entrySelector"],
            ]
            return [
                await page.evaluate(
                    "(selector) => document.querySelectorAll(selector).length", selector
                )
                for selector in selectors
            ]
        finally:
            await context.close()

    counts = _run(scenario)

    assert counts == [1, 1, 1, 1]


def test_bundle_reinstalls_itself_after_navigation(tmp_path: Path) -> None:
    driver = _driver_or_skip()
    runner = PageScriptRunner()
    first = _document(tmp_path, MODERN_POST, "first.html")
    second = _document(tmp_path, MODERN_POST, "second.html")

    async def scenario() -> list[str]:
        context = await driver.launch(profile_dir=tmp_path / "profile", headless=True)
        try:
            page = await context.new_page()
            await page.goto(first)
            before = await runner.call(page, "probeLike")
            await page.goto(second)
            after = await runner.call(page, "probeLike")
            return [before["code"], after["code"]]
        finally:
            await context.close()

    codes = _run(scenario)

    assert codes == ["ready", "ready"]


def test_probes_fail_closed_on_an_unrelated_document(tmp_path: Path) -> None:
    driver = _driver_or_skip()
    runner = PageScriptRunner()
    url = _document(tmp_path, "<html><body><p>본문 없음</p></body></html>", "plain.html")

    async def scenario() -> dict[str, Any]:
        context = await driver.launch(profile_dir=tmp_path / "profile", headless=True)
        try:
            page = await context.new_page()
            await page.goto(url)
            return {
                "article": await runner.call(page, "captureArticle"),
                "like": await runner.call(page, "probeLike"),
                "comment": await runner.call(page, "probeComment", "합성 댓글"),
                "neighbor": await runner.call(page, "probeNeighborRelationship"),
            }
        finally:
            await context.close()

    observed = _run(scenario)

    assert observed["article"] is None
    assert observed["like"]["code"] == "not_found"
    assert observed["comment"]["code"] == "not_found"
    assert observed["neighbor"]["state"] == "state_unknown"


def test_child_frames_are_probed_independently(tmp_path: Path) -> None:
    driver = _driver_or_skip()
    runner = PageScriptRunner()
    child = tmp_path / "child.html"
    child.write_text(MODERN_POST, encoding="utf-8")
    parent = tmp_path / "parent.html"
    parent.write_text(
        f"<html><body><iframe src='{child.name}'></iframe></body></html>", encoding="utf-8"
    )

    async def scenario() -> list[Any]:
        context = await driver.launch(profile_dir=tmp_path / "profile", headless=True)
        try:
            page = await context.new_page()
            await page.goto(parent.as_uri())
            await asyncio.sleep(0.5)
            captures = []
            for frame in page.frames:
                captures.append(await runner.call(frame, "captureArticle"))
            return captures
        finally:
            await context.close()

    captures = _run(scenario)

    assert any(capture is not None and capture["selectorKind"] == "modern" for capture in captures)
