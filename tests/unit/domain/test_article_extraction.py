"""Validation rules for one bounded article capture."""

from __future__ import annotations

import pytest

from naver_blog_assistant.domain import (
    ARTICLE_PREVIEW_CODE_POINTS,
    MAX_ARTICLE_BODY_CODE_POINTS,
    MAX_ARTICLE_TITLE_CODE_POINTS,
    MIN_ARTICLE_BODY_CODE_POINTS,
    ArticleExtraction,
    DomainValidationError,
)

URL = "https://blog.naver.com/example/223456789012"
BODY = "가" * MIN_ARTICLE_BODY_CODE_POINTS


def build(
    *,
    source_url: str = URL,
    title: str = "합성 제목",
    body: str = BODY,
    original_length: int | None = None,
    truncated: bool = False,
    selector_kind: str = "modern",
) -> ArticleExtraction:
    return ArticleExtraction(
        source_url=source_url,
        title=title,
        body=body,
        original_length=len(body) if original_length is None else original_length,
        truncated=truncated,
        selector_kind=selector_kind,
    )


def test_a_minimal_capture_is_accepted() -> None:
    extraction = build()

    assert extraction.transmitted_length == MIN_ARTICLE_BODY_CODE_POINTS
    assert extraction.truncated is False
    assert extraction.preview == BODY


def test_the_body_is_excluded_from_the_repr() -> None:
    assert BODY not in repr(build())


@pytest.mark.parametrize("value", ["", "   "])
def test_a_blank_source_url_is_rejected(value: str) -> None:
    with pytest.raises(DomainValidationError, match="source URL"):
        build(source_url=value)


@pytest.mark.parametrize("value", ["", "   "])
def test_a_blank_title_is_rejected(value: str) -> None:
    with pytest.raises(DomainValidationError, match="title"):
        build(title=value)


def test_a_body_below_the_minimum_is_rejected() -> None:
    short = "가" * (MIN_ARTICLE_BODY_CODE_POINTS - 1)

    with pytest.raises(DomainValidationError, match="too short"):
        build(body=short, original_length=len(short))


def test_a_body_above_the_limit_is_rejected() -> None:
    long = "가" * (MAX_ARTICLE_BODY_CODE_POINTS + 1)

    with pytest.raises(DomainValidationError, match="request limit"):
        build(body=long, original_length=len(long))


def test_a_title_above_the_limit_is_rejected() -> None:
    with pytest.raises(DomainValidationError, match="title exceeds"):
        build(title="제" * (MAX_ARTICLE_TITLE_CODE_POINTS + 1))


def test_an_original_length_below_the_body_is_rejected() -> None:
    with pytest.raises(DomainValidationError, match="original length"):
        build(original_length=1)


def test_a_truncated_capture_must_report_a_larger_original_length() -> None:
    with pytest.raises(DomainValidationError, match="truncated capture"):
        build(truncated=True)


def test_the_preview_is_bounded() -> None:
    body = "가" * (ARTICLE_PREVIEW_CODE_POINTS + 100)

    extraction = build(body=body, original_length=len(body))

    assert len(extraction.preview) == ARTICLE_PREVIEW_CODE_POINTS
