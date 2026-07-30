"""Tests for installing and calling the injected page bundle."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from naver_blog_assistant.infrastructure.browser import (
    BUNDLE_VERSION,
    PAGE_PROBES,
    PageBundleMissingError,
    PageScriptRunner,
    bundle_path,
    load_page_bundle,
)
from naver_blog_assistant.infrastructure.browser.fake import FakePage
from naver_blog_assistant.infrastructure.browser.page_scripts import _CALL_EXPRESSION
from naver_blog_assistant.ports.browser import BrowserOperationError

BUNDLE = "globalThis.__nbaPage = { version: 1 };"


class _ScriptedTarget:
    """Target that answers the call expression with a scripted sequence."""

    def __init__(self, responses: list[Any]) -> None:
        self._responses = responses
        self.evaluations: list[tuple[str, Any]] = []

    async def evaluate(self, expression: str, argument: Any = None) -> Any:
        self.evaluations.append((expression, argument))
        if expression != _CALL_EXPRESSION:
            return None
        return self._responses.pop(0)


def test_the_built_bundle_is_available_and_exposes_every_probe() -> None:
    source = load_page_bundle()

    assert bundle_path().exists()
    assert "__nbaPage" in source
    for probe in PAGE_PROBES:
        assert probe in source


def test_a_missing_bundle_reports_the_build_command(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Missing:
        def read_text(self, encoding: str) -> str:
            raise FileNotFoundError(encoding)

    monkeypatch.setattr(
        "naver_blog_assistant.infrastructure.browser.page_scripts.files",
        lambda _: type("_Resource", (), {"joinpath": lambda self, name: _Missing()})(),
    )

    with pytest.raises(PageBundleMissingError, match="npm --prefix client run build:page"):
        load_page_bundle()


def test_an_empty_bundle_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Empty:
        def read_text(self, encoding: str) -> str:
            del encoding
            return "   \n"

    monkeypatch.setattr(
        "naver_blog_assistant.infrastructure.browser.page_scripts.files",
        lambda _: type("_Resource", (), {"joinpath": lambda self, name: _Empty()})(),
    )

    with pytest.raises(PageBundleMissingError, match="empty"):
        load_page_bundle()


def test_unknown_probe_names_are_rejected_before_evaluation() -> None:
    runner = PageScriptRunner(BUNDLE)
    page = FakePage()

    with pytest.raises(ValueError, match="not an exposed page probe"):
        asyncio.run(runner.call(page, "eval"))
    assert page.evaluations == []


def test_call_returns_the_probe_value_when_the_bundle_is_installed() -> None:
    runner = PageScriptRunner(BUNDLE)
    target = _ScriptedTarget([{"installed": True, "value": {"code": "ready"}}])

    result = asyncio.run(runner.call(target, "probeLike"))

    assert result == {"code": "ready"}
    assert target.evaluations[0][1] == {"args": [], "name": "probeLike"}


def test_call_installs_the_bundle_and_retries_once() -> None:
    runner = PageScriptRunner(BUNDLE)
    target = _ScriptedTarget([{"installed": False, "value": None}, {"installed": True, "value": 3}])

    result = asyncio.run(runner.call(target, "countMatchingComments", "댓글"))

    assert result == 3
    installs = [expression for expression, _ in target.evaluations if expression == BUNDLE]
    assert len(installs) == 1


def test_call_fails_when_the_bundle_cannot_be_installed() -> None:
    runner = PageScriptRunner(BUNDLE)
    target = _ScriptedTarget(
        [{"installed": False, "value": None}, {"installed": False, "value": None}]
    )

    with pytest.raises(BrowserOperationError, match="could not be installed"):
        asyncio.run(runner.call(target, "probeLike"))


def test_call_rejects_a_non_object_result() -> None:
    runner = PageScriptRunner(BUNDLE)
    target = _ScriptedTarget(["unexpected"])

    with pytest.raises(BrowserOperationError, match="unexpected result"):
        asyncio.run(runner.call(target, "probeLike"))


def test_call_passes_multiple_arguments_in_order() -> None:
    runner = PageScriptRunner(BUNDLE)
    target = _ScriptedTarget([{"installed": True, "value": True}])

    asyncio.run(runner.call(target, "commentStillPending", "textarea", "댓글"))

    assert target.evaluations[0][1] == {
        "args": ["textarea", "댓글"],
        "name": "commentStillPending",
    }


def test_install_evaluates_the_bundle_source() -> None:
    runner = PageScriptRunner(BUNDLE)
    page = FakePage()

    asyncio.run(runner.install(page))

    assert page.evaluations == [(BUNDLE, None)]


def test_the_call_expression_pins_the_bundle_version() -> None:
    assert f"!== {BUNDLE_VERSION}" in _CALL_EXPRESSION
    assert PageScriptRunner(BUNDLE).bundle == BUNDLE
