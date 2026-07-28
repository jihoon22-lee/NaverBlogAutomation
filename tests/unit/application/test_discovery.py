"""Tests for public RSS metadata parsing and opt-in SMTP delivery."""

from __future__ import annotations

from datetime import UTC, datetime
from email.message import EmailMessage
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from naver_blog_assistant.application.discovery import (
    SmtpDigestSender,
    buddy_list_url,
    fetch_naver_blog_search,
    fetch_public_html,
    fetch_rss_posts,
    filter_saved_search_posts,
    parse_buddy_list,
    rss_url_for,
    saved_search_title_matches,
)
from naver_blog_assistant.domain import ImportedDiscoveryPost, SavedSearch


class FakeResponse:
    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self, _: int) -> bytes:
        return """<?xml version='1.0'?><rss><channel>
          <item><title>  새 글 </title><link>https://blog.naver.com/friend/123</link>
          <pubDate>Sat, 26 Jul 2026 09:00:00 +0000</pubDate></item>
          <item><title></title><link>https://blog.naver.com/friend/456</link></item>
        </channel></rss>""".encode()


class JsonResponse:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.read_limit: int | None = None

    def __enter__(self) -> JsonResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self, limit: int) -> bytes:
        self.read_limit = limit
        return self.body


def test_rss_fetch_reads_only_bounded_post_metadata() -> None:
    with patch(
        "naver_blog_assistant.application.discovery.urlopen", return_value=FakeResponse()
    ) as opened:
        posts = fetch_rss_posts(rss_url_for("friend"))

    assert opened.called
    assert posts == (
        ("https://blog.naver.com/friend/123", "새 글", datetime(2026, 7, 26, 9, tzinfo=UTC)),
    )


def test_saved_search_filters_excluded_and_stale_dated_metadata() -> None:
    search = SavedSearch(
        id=uuid4(),
        query="전시",
        excluded_terms=("광고",),
        freshness_days=7,
        enabled=True,
        created_at=datetime(2026, 7, 26, tzinfo=UTC),
    )
    posts = (
        ImportedDiscoveryPost(
            source_url="https://blog.naver.com/friend/1",
            title="전시 후기",
            published_at=datetime(2026, 7, 25, tzinfo=UTC),
        ),
        ImportedDiscoveryPost(
            source_url="https://blog.naver.com/friend/2",
            title="광고가 포함된 전시",
            published_at=datetime(2026, 7, 25, tzinfo=UTC),
        ),
        ImportedDiscoveryPost(
            source_url="https://blog.naver.com/friend/3",
            title="오래된 전시",
            published_at=datetime(2026, 7, 1, tzinfo=UTC),
        ),
        ImportedDiscoveryPost(
            source_url="https://blog.naver.com/otherfriend/4",
            title="게시일을 제공하지 않는 전시",
        ),
    )

    assert filter_saved_search_posts(search, posts, now=datetime(2026, 7, 26, tzinfo=UTC)) == (
        posts[0],
        posts[3],
    )


def test_saved_search_requires_every_query_term_in_the_displayed_title() -> None:
    search = SavedSearch(
        id=uuid4(),
        query="코스트코 고기",
        excluded_terms=(),
        freshness_days=7,
        enabled=True,
        created_at=datetime(2026, 7, 26, tzinfo=UTC),
    )

    assert saved_search_title_matches(search, "코스트코 고기 할인 후기")
    assert saved_search_title_matches(search, "코스트코고기 보관법")
    assert not saved_search_title_matches(search, "코스트코 장보기 후기")
    assert not saved_search_title_matches(search, "고기 요리 모음")


def test_public_list_parsers_keep_only_direct_bounded_naver_metadata() -> None:
    buddy_html = """
      <a href="https://m.blog.naver.com/PostList.naver?blogId=friend">친한 이웃</a>
      <a href="https://example.test/friend">외부</a>
    """
    assert buddy_list_url("mine").endswith("blogId=mine")
    assert parse_buddy_list(buddy_html) == (
        ("친한 이웃", "friend", "https://blog.naver.com/friend"),
    )


def test_public_html_rejects_non_allowlisted_urls() -> None:
    with pytest.raises(ValueError, match="allowed"):
        fetch_public_html("https://example.test/")


def test_public_html_rejects_search_results_html() -> None:
    with pytest.raises(ValueError, match="allowed"):
        fetch_public_html("https://search.naver.com/search.naver?where=blog&query=test")


def test_naver_blog_search_uses_documented_headers_and_normalizes_metadata() -> None:
    response = JsonResponse(
        b'{"items":[{"title":"<b>\xec\xa0\x84\xec\x8b\x9c</b> \xed\x9b\x84\xea\xb8\xb0",'
        b'"link":"https://blog.naver.com/friend/123","bloggername":"<b>\xec\xb9\x9c\xea\xb5\xac</b>",'
        b'"bloggerlink":"https://blog.naver.com/friend","postdate":"20260726"}]}'
    )
    with patch(
        "naver_blog_assistant.application.discovery.urlopen", return_value=response
    ) as opened:
        posts = fetch_naver_blog_search("전시", client_id="id", client_secret="secret")

    request = opened.call_args.args[0]
    assert request.get_header("X-naver-client-id") == "id"
    assert request.get_header("X-naver-client-secret") == "secret"
    assert response.read_limit == 1_000_000
    assert posts == (
        ImportedDiscoveryPost(
            source_url="https://blog.naver.com/friend/123",
            title="\uc804\uc2dc \ud6c4\uae30",
            publisher_name="\uce5c\uad6c",
            publisher_blog_id="friend",
            published_at=datetime(2026, 7, 26, tzinfo=UTC),
        ),
    )


@pytest.mark.parametrize("security", ["starttls", "ssl"])
def test_smtp_sender_uses_opt_in_authenticated_transport(security: str) -> None:
    client = MagicMock()
    client.__enter__.return_value = client
    with (
        patch("naver_blog_assistant.application.discovery.SMTP", return_value=client),
        patch("naver_blog_assistant.application.discovery.SMTP_SSL", return_value=client),
    ):
        SmtpDigestSender(
            host="smtp.example.test",
            port=587,
            username="user",
            password="secret",
            sender="from@example.test",
            recipient="to@example.test",
            security=security,
        ).send(subject="요약", body="제목과 링크만 포함")

    if security == "starttls":
        client.starttls.assert_called_once()
    else:
        client.starttls.assert_not_called()
    client.login.assert_called_once_with("user", "secret")
    message = client.send_message.call_args.args[0]
    assert isinstance(message, EmailMessage)
    assert message["To"] == "to@example.test"


def test_smtp_sender_rejects_unknown_security() -> None:
    with pytest.raises(ValueError, match="security"):
        SmtpDigestSender(
            host="host",
            port=1,
            username="",
            password="",
            sender="a",
            recipient="b",
            security="none",
        )
