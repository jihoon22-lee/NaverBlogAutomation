"""Use cases for locally curated blog discovery."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from smtplib import SMTP, SMTP_SSL
from typing import Protocol
from urllib.request import Request, urlopen
from xml.etree import ElementTree

from naver_blog_assistant.domain.discovery import (
    DiscoverySource,
    ImportedDiscoveryPost,
    NeighborBlog,
    SavedSearch,
)


class DiscoveryStore(Protocol):
    def list_neighbors(self) -> tuple[NeighborBlog, ...]: ...
    def update_neighbor_feed_status(
        self, neighbor_id: object, *, status: str, checked_at: datetime
    ) -> None: ...
    def import_posts(
        self,
        *,
        source: DiscoverySource,
        neighbor_id: object | None,
        search_id: object | None,
        posts: tuple[ImportedPost, ...],
    ) -> int: ...
    def queued_neighbor_posts(self, *, since: datetime) -> tuple[object, ...]: ...


class DigestSender(Protocol):
    def send(self, *, subject: str, body: str) -> None: ...


class ImportedPost(Protocol):
    source_url: str
    title: str
    publisher_name: str | None
    published_at: datetime | None


def rss_url_for(blog_id: str) -> str:
    """Return Naver's current public RSS endpoint for one blog identifier."""
    return f"https://rss.blog.naver.com/{blog_id}.xml"


def fetch_rss_posts(
    url: str, *, timeout: float = 10.0
) -> tuple[tuple[str, str, datetime | None], ...]:
    """Read bounded RSS metadata without retaining article bodies."""
    request = Request(url, headers={"User-Agent": "NaverBlogAssistant/0.4"})
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed public RSS endpoint
        payload = response.read(1_000_000)
    root = ElementTree.fromstring(payload)
    results: list[tuple[str, str, datetime | None]] = []
    for item in root.findall("./channel/item")[:50]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if not title or not link:
            continue
        published_at = _parse_rss_date(item.findtext("pubDate"))
        results.append((link, title, published_at))
    return tuple(results)


def filter_saved_search_posts(
    search: SavedSearch,
    posts: tuple[ImportedDiscoveryPost, ...],
    *,
    now: datetime,
) -> tuple[ImportedDiscoveryPost, ...]:
    """Apply an opt-in saved search's exclusion and freshness rules to metadata."""
    cutoff = now.astimezone(UTC) - timedelta(days=search.freshness_days)
    allowed: list[ImportedDiscoveryPost] = []
    excluded_terms = tuple(term.casefold() for term in search.excluded_terms)
    for post in posts:
        searchable = " ".join((post.title, post.publisher_name or "")).casefold()
        if any(term in searchable for term in excluded_terms):
            continue
        if post.published_at is not None and post.published_at.astimezone(UTC) < cutoff:
            continue
        allowed.append(post)
    return tuple(allowed)


def _parse_rss_date(value: str | None) -> datetime | None:
    if not value:
        return None
    from email.utils import parsedate_to_datetime

    try:
        parsed = parsedate_to_datetime(value)
    except TypeError, ValueError, IndexError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


class SmtpDigestSender:
    """Opt-in generic SMTP delivery that never logs credentials or message bodies."""

    def __init__(
        self,
        *,
        host: str,
        port: int,
        username: str,
        password: str,
        sender: str,
        recipient: str,
        security: str = "starttls",
    ) -> None:
        if security not in {"starttls", "ssl"}:
            raise ValueError("SMTP security must be starttls or ssl")
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._sender = sender
        self._recipient = recipient
        self._security = security

    def send(self, *, subject: str, body: str) -> None:
        message = EmailMessage()
        message["From"] = self._sender
        message["To"] = self._recipient
        message["Subject"] = subject
        message.set_content(body)
        client_type = SMTP_SSL if self._security == "ssl" else SMTP
        with client_type(self._host, self._port, timeout=15) as client:
            if self._security == "starttls":
                client.starttls()
            if self._username:
                client.login(self._username, self._password)
            client.send_message(message)
