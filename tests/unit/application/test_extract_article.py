"""Ranking, normalization, and fail-closed behavior for article extraction."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from naver_blog_assistant.application.automation import (
    ArticleExtractionFailedError,
    BrowserSessionManager,
    BrowserSessionNotRunningError,
    ExtractArticle,
    normalize_request_text,
    parse_supported_article_url,
)
from naver_blog_assistant.domain import MAX_ARTICLE_BODY_CODE_POINTS, ArticleExtraction
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver, PageScriptRunner
from naver_blog_assistant.infrastructure.browser.fake import FakeFrame, FakePage
from naver_blog_assistant.infrastructure.browser.page_scripts import _CALL_EXPRESSION

POST_URL = "https://blog.naver.com/example/223456789012"
BUNDLE = "globalThis.__nbaPage = { version: 1 };"


def capture(
    *,
    body: str = "합성 본문입니다. 충분히 긴 문장을 포함합니다.",
    title: str = "합성 제목",
    confidence: int = 500,
    kind: str = "modern",
    url: str = POST_URL,
    canonical: str | None = None,
    original: int | None = None,
) -> dict[str, Any]:
    return {
        "body": body,
        "canonicalUrl": canonical,
        "documentUrl": url,
        "originalLength": original if original is not None else len(body),
        "selectorConfidence": confidence,
        "selectorKind": kind,
        "title": title,
    }


def extractor(frames: list[Any]) -> tuple[ExtractArticle, BrowserSessionManager]:
    """Build an extractor whose frames answer the bundle call with scripted captures."""
    responses = [{"installed": True, "value": frame} for frame in frames]
    page = FakePage(results={_CALL_EXPRESSION: None})
    page.child_frames.extend(
        FakeFrame(url=POST_URL, results={_CALL_EXPRESSION: response}) for response in responses[1:]
    )
    page.results[_CALL_EXPRESSION] = responses[0] if responses else None
    driver = FakeBrowserDriver()
    sessions = BrowserSessionManager(driver, profile_dir=Path("/profiles"), headless=True)

    async def prepared() -> ExtractArticle:
        await sessions.launch()
        context = driver.contexts[0]
        context.open_tabs.clear()
        context.open_tabs.append(page)
        return ExtractArticle(sessions, scripts=PageScriptRunner(BUNDLE))

    return asyncio.run(prepared()), sessions


def run_extract(frames: list[Any], url: str = POST_URL) -> ArticleExtraction:
    extract, _ = extractor(frames)
    return asyncio.run(extract.execute(url))


@pytest.mark.parametrize(
    "url",
    [
        "https://blog.naver.com/example/1",
        "https://m.blog.naver.com/example/1",
        "https://blog.naver.com/PostView.naver?blogId=example&logNo=1",
        "https://blog.naver.com:443/example/1",
    ],
)
def test_supported_urls_are_accepted(url: str) -> None:
    assert parse_supported_article_url(url) is not None


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "http://blog.naver.com/example/1",
        "https://blog.naver.com.evil.test/example/1",
        "https://cafe.naver.com/example/1",
        "https://user:pass@blog.naver.com/example/1",
        "https://blog.naver.com:8443/example/1",
        "https://blog.naver.com/example/1 with space",
        "https://blog.naver.com/example/%zz",
        "https://blog.naver.com/example/%00",
        "https://blog.naver.com/example/%20",
        "javascript:alert(1)",
        "file:///etc/passwd",
    ],
)
def test_unsupported_urls_are_rejected(url: str) -> None:
    assert parse_supported_article_url(url) is None


def test_overlong_urls_are_rejected() -> None:
    assert parse_supported_article_url(f"https://blog.naver.com/{'a' * 2100}") is None


def test_fragments_are_dropped_from_the_canonical_form() -> None:
    assert parse_supported_article_url(f"{POST_URL}#comment") == POST_URL


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  a   b  ", "a b"),
        ("a\nb", "a b"),
        ("a\t\tb", "a b"),
        ("a\u00a0b", "a b"),
        ("", ""),
    ],
)
def test_request_text_collapses_whitespace(raw: str, expected: str) -> None:
    assert normalize_request_text(raw) == expected


def test_unsupported_request_url_fails_before_navigation() -> None:
    extract, _ = extractor([capture()])

    with pytest.raises(ArticleExtractionFailedError) as error:
        asyncio.run(extract.execute("https://cafe.naver.com/example/1"))
    assert error.value.code == "unsupported_url"


def test_extraction_requires_a_live_session() -> None:
    sessions = BrowserSessionManager(
        FakeBrowserDriver(), profile_dir=Path("/profiles"), headless=True
    )
    extract = ExtractArticle(sessions, scripts=PageScriptRunner(BUNDLE))

    with pytest.raises(BrowserSessionNotRunningError):
        asyncio.run(extract.execute(POST_URL))


def test_single_frame_capture_is_normalized_and_bounded() -> None:
    extraction = run_extract([capture(body="첫 문단\n\n둘째   문단입니다. 충분히 깁니다.")])

    assert extraction.body == "첫 문단 둘째 문단입니다. 충분히 깁니다."
    assert extraction.title == "합성 제목"
    assert extraction.source_url == POST_URL
    assert extraction.truncated is False


def test_the_highest_confidence_frame_wins() -> None:
    extraction = run_extract(
        [
            capture(
                body="세만틱 본문입니다. 충분히 긴 문장입니다.", confidence=220, kind="semantic"
            ),
            capture(body="모던 본문입니다. 충분히 긴 문장입니다.", confidence=500),
        ]
    )

    assert extraction.selector_kind == "modern"
    assert "모던" in extraction.body


def test_the_longer_body_wins_when_confidence_ties() -> None:
    extraction = run_extract(
        [
            capture(body="짧은 본문이지만 최소 길이는 넘깁니다."),
            capture(body="훨씬 더 긴 본문으로 같은 confidence에서 선택되어야 합니다."),
        ]
    )

    assert "훨씬 더 긴" in extraction.body


def test_frames_on_unsupported_hosts_are_ignored() -> None:
    extraction = run_extract(
        [
            capture(body="광고 프레임 본문입니다. 충분히 깁니다.", url="https://ads.example.com/x"),
            capture(body="본문 프레임입니다. 충분히 긴 문장입니다."),
        ]
    )

    assert "본문 프레임" in extraction.body


def test_no_capture_reports_an_empty_article() -> None:
    with pytest.raises(ArticleExtractionFailedError) as error:
        run_extract([None, None])
    assert error.value.code == "empty_article"


def test_blank_bodies_report_an_empty_article() -> None:
    with pytest.raises(ArticleExtractionFailedError) as error:
        run_extract([capture(body="   \n  ")])
    assert error.value.code == "empty_article"


def test_a_short_body_is_rejected() -> None:
    with pytest.raises(ArticleExtractionFailedError) as error:
        run_extract([capture(body="너무 짧음")])
    assert error.value.code == "short_article"


def test_a_body_at_the_minimum_length_is_accepted() -> None:
    extraction = run_extract([capture(body="가" * 20)])

    assert extraction.transmitted_length == 20


def test_a_missing_title_reports_extraction_failed() -> None:
    with pytest.raises(ArticleExtractionFailedError) as error:
        run_extract([capture(title="   ")])
    assert error.value.code == "extraction_failed"


def test_an_overlong_body_is_truncated_and_flagged() -> None:
    body = "가" * (MAX_ARTICLE_BODY_CODE_POINTS + 40)

    extraction = run_extract([capture(body=body)])

    assert extraction.transmitted_length == MAX_ARTICLE_BODY_CODE_POINTS
    assert extraction.original_length == MAX_ARTICLE_BODY_CODE_POINTS + 40
    assert extraction.truncated is True


def test_a_body_exactly_at_the_limit_is_not_flagged() -> None:
    extraction = run_extract([capture(body="가" * MAX_ARTICLE_BODY_CODE_POINTS)])

    assert extraction.truncated is False


def test_an_overlong_title_is_bounded() -> None:
    extraction = run_extract([capture(title="제" * 400)])

    assert len(extraction.title) == 300


def test_a_supported_canonical_url_replaces_the_requested_url() -> None:
    extraction = run_extract(
        [capture(canonical="https://blog.naver.com/example/999999999999")],
        url="https://m.blog.naver.com/example/223456789012",
    )

    assert extraction.source_url == "https://blog.naver.com/example/999999999999"


def test_an_unsupported_canonical_url_is_ignored() -> None:
    extraction = run_extract([capture(canonical="https://evil.example.com/post")])

    assert extraction.source_url == POST_URL


def test_emoji_and_surrogate_pairs_survive_normalization() -> None:
    extraction = run_extract([capture(body="이모지 👨‍👩‍👧‍👦 를 포함한 충분히 긴 본문입니다.")])

    assert "👨‍👩‍👧‍👦" in extraction.body


def test_navigation_failure_reports_extraction_failed() -> None:
    driver = FakeBrowserDriver(page_navigation_failure="net::ERR_ABORTED")
    sessions = BrowserSessionManager(driver, profile_dir=Path("/profiles"), headless=True)

    async def scenario() -> None:
        await sessions.launch()
        extract = ExtractArticle(sessions, scripts=PageScriptRunner(BUNDLE))
        await extract.execute(POST_URL)

    with pytest.raises(ArticleExtractionFailedError) as error:
        asyncio.run(scenario())
    assert error.value.code == "extraction_failed"


def test_a_non_object_capture_is_ignored() -> None:
    with pytest.raises(ArticleExtractionFailedError) as error:
        run_extract(["unexpected"])
    assert error.value.code == "empty_article"


def test_the_preview_is_bounded_without_truncating_the_body() -> None:
    extraction = run_extract([capture(body="가" * 3_000)])

    assert len(extraction.preview) == 1_200
    assert extraction.transmitted_length == 3_000


def test_page_level_truncation_is_reported(tmp_path: Path) -> None:
    del tmp_path
    body = "가" * 500

    extraction = run_extract([capture(body=body, original=900)])

    assert extraction.truncated is True
    assert extraction.original_length == 900
    assert extraction.transmitted_length == 500


def test_normalization_alone_is_not_reported_as_truncation() -> None:
    extraction = run_extract([capture(body="첫 문단\n\n둘째   문단입니다. 충분히 깁니다.")])

    assert extraction.truncated is False


def test_a_frame_whose_probe_fails_is_ignored() -> None:
    driver = FakeBrowserDriver()
    sessions = BrowserSessionManager(driver, profile_dir=Path("/profiles"), headless=True)

    async def scenario() -> ArticleExtraction:
        await sessions.launch()
        context = driver.contexts[0]
        context.open_tabs.clear()
        failing = FakeFrame(url=POST_URL, failure="execution context destroyed")
        page = FakePage(results={_CALL_EXPRESSION: {"installed": True, "value": capture()}})
        page.child_frames.append(failing)
        context.open_tabs.append(page)
        extract = ExtractArticle(sessions, scripts=PageScriptRunner(BUNDLE))
        return await extract.execute(POST_URL)

    extraction = asyncio.run(scenario())

    assert extraction.selector_kind == "modern"


def test_a_capture_without_a_document_url_is_ignored() -> None:
    with pytest.raises(ArticleExtractionFailedError) as error:
        run_extract([{**capture(), "documentUrl": None}])
    assert error.value.code == "empty_article"


def test_untrusted_numeric_fields_fall_back_to_zero() -> None:
    extraction = run_extract(
        [
            {
                **capture(),
                "originalLength": "many",
                "selectorConfidence": True,
                "selectorKind": None,
            }
        ]
    )

    assert extraction.selector_kind == "modern"
    assert extraction.original_length == extraction.transmitted_length


def test_a_float_original_length_is_coerced() -> None:
    body = "가" * 300

    extraction = run_extract([{**capture(body=body), "originalLength": 640.7}])

    assert extraction.original_length == 640
    assert extraction.truncated is True


def test_unknown_failure_codes_are_rejected() -> None:
    with pytest.raises(ValueError, match="not a known extraction failure code"):
        ArticleExtractionFailedError("nope")
