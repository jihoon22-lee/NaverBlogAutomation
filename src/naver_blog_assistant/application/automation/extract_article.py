"""Extract one Naver Blog article through the locally owned browser session.

The supported-host policy lives here rather than in the injected script, so the server alone decides
which URLs may be opened. Frame results are ranked, normalized, and bounded to the generation
request limits. Every unusable result fails closed with a stable code.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import urlsplit

from naver_blog_assistant.application.automation.errors import ArticleExtractionFailedError
from naver_blog_assistant.application.automation.session import BrowserSessionManager
from naver_blog_assistant.domain.automation import (
    MAX_ARTICLE_BODY_CODE_POINTS,
    MAX_ARTICLE_TITLE_CODE_POINTS,
    MIN_ARTICLE_BODY_CODE_POINTS,
    ArticleExtraction,
)
from naver_blog_assistant.infrastructure.browser.page_scripts import PageScriptRunner
from naver_blog_assistant.ports.browser import BrowserOperationError, EvaluationTarget

SUPPORTED_HOSTS: Final = frozenset({"blog.naver.com", "m.blog.naver.com"})
MAX_URL_LENGTH: Final = 2_048
EXTRACTION_TIMEOUT_SECONDS: Final = 20.0
_WHITESPACE: Final = re.compile(r"\s+")
_INVALID_PERCENT: Final = re.compile(r"%(?![0-9a-fA-F]{2})")
_ENCODED_CONTROL: Final = re.compile(r"%(?:0[0-9a-fA-F]|1[0-9a-fA-F]|20|7[fF])")


def parse_supported_article_url(value: str) -> str | None:
    """Return the canonical form of a supported HTTPS Naver Blog URL, or None."""
    candidate = value.strip()
    if (
        not candidate
        or len(candidate) > MAX_URL_LENGTH
        or any(character.isspace() or ord(character) < 0x20 for character in candidate)
        or "\u007f" in candidate
        or _INVALID_PERCENT.search(candidate) is not None
        or _ENCODED_CONTROL.search(candidate) is not None
    ):
        return None
    parsed = urlsplit(candidate)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in SUPPORTED_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or not parsed.path.startswith("/")
    ):
        return None
    if parsed.port is not None and parsed.port != 443:
        return None
    return parsed._replace(fragment="").geturl()


def normalize_request_text(value: str) -> str:
    """Collapse every whitespace run into one space, matching the generation contract."""
    return _WHITESPACE.sub(" ", value).strip()


class ExtractArticle:
    """Open one supported post in the automation session and return a bounded capture."""

    def __init__(
        self,
        sessions: BrowserSessionManager,
        *,
        scripts: PageScriptRunner | None = None,
    ) -> None:
        self._sessions = sessions
        self._scripts = scripts if scripts is not None else PageScriptRunner()

    async def execute(self, url: str) -> ArticleExtraction:
        """Navigate to ``url`` and return the strongest capture across eligible frames."""
        requested = parse_supported_article_url(url)
        if requested is None:
            raise ArticleExtractionFailedError("unsupported_url")
        page = await self._sessions.primary_page()
        try:
            await page.goto(requested, timeout_seconds=EXTRACTION_TIMEOUT_SECONDS)
            captures = [
                await self._capture(frame, index) for index, frame in enumerate(page.frames)
            ]
        except BrowserOperationError as error:
            raise ArticleExtractionFailedError("extraction_failed") from error
        return self._select(requested, captures)

    async def _capture(self, frame: EvaluationTarget, index: int) -> dict[str, Any] | None:
        try:
            captured = await self._scripts.call(frame, "captureArticle")
        except BrowserOperationError:
            return None
        if not isinstance(captured, dict):
            return None
        return {**captured, "frame_index": index}

    def _select(self, requested: str, captures: list[dict[str, Any] | None]) -> ArticleExtraction:
        candidates: list[_Candidate] = []
        for capture in captures:
            if capture is None:
                continue
            document_url = capture.get("documentUrl")
            if not isinstance(document_url, str):
                continue
            if parse_supported_article_url(document_url) is None:
                continue
            body = normalize_request_text(str(capture.get("body") or ""))
            if not body:
                continue
            candidates.append(
                _Candidate(
                    body=body,
                    capture=capture,
                    confidence=_as_int(capture.get("selectorConfidence")),
                    frame_index=_as_int(capture.get("frame_index")),
                )
            )
        if not candidates:
            raise ArticleExtractionFailedError("empty_article")
        candidates.sort(key=lambda item: (-item.confidence, -item.body_length, item.frame_index))
        selected = candidates[0]
        if selected.body_length < MIN_ARTICLE_BODY_CODE_POINTS:
            raise ArticleExtractionFailedError("short_article")

        capture = selected.capture
        normalized_length = selected.body_length
        body = selected.body[:MAX_ARTICLE_BODY_CODE_POINTS]
        title = normalize_request_text(str(capture.get("title") or ""))[
            :MAX_ARTICLE_TITLE_CODE_POINTS
        ]
        if not title:
            raise ArticleExtractionFailedError("extraction_failed")
        canonical = capture.get("canonicalUrl")
        source_url = (
            parse_supported_article_url(canonical) if isinstance(canonical, str) else None
        ) or requested
        # The page bounds its own retained text, so a page-level cut and a server-level cut are both
        # possible. Normalization alone must not be reported as truncation.
        page_original = _as_int(capture.get("originalLength"))
        page_truncated = page_original > len(str(capture.get("body") or ""))
        server_truncated = normalized_length > MAX_ARTICLE_BODY_CODE_POINTS
        return ArticleExtraction(
            source_url=source_url,
            title=title,
            body=body,
            original_length=max(page_original, normalized_length),
            truncated=page_truncated or server_truncated,
            selector_kind=str(capture.get("selectorKind") or "modern"),
        )


def _as_int(value: object) -> int:
    """Return a non-negative integer for an untrusted page value."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return max(value, 0)
    if isinstance(value, float):
        return max(int(value), 0)
    return 0


@dataclass(frozen=True, slots=True)
class _Candidate:
    """One ranked frame capture."""

    body: str
    capture: dict[str, Any]
    confidence: int
    frame_index: int

    @property
    def body_length(self) -> int:
        return len(self.body)
