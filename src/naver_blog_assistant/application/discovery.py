"""Use cases for locally curated blog discovery."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from html import unescape
from html.parser import HTMLParser
from smtplib import SMTP, SMTP_SSL
from typing import Protocol
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit
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


def buddy_list_url(blog_id: str) -> str:
    """Return the public mobile BuddyList endpoint for one saved blog id."""
    return f"https://m.blog.naver.com/BuddyList.naver?{urlencode({'blogId': blog_id})}"


def search_url(query: str) -> str:
    """Return Naver's public blog-search URL for an explicitly saved query."""
    return f"https://search.naver.com/search.naver?{urlencode({'where': 'blog', 'query': query})}"


def fetch_public_html(url: str, *, timeout: float = 10.0) -> str:
    """Read a bounded public HTML document without cookies or credentials."""
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in {
        "m.blog.naver.com",
        "search.naver.com",
    }:
        raise ValueError("public discovery URL is not allowed")
    request = Request(url, headers={"User-Agent": "NaverBlogAssistant/0.5"})
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed allowlisted public host
        return response.read(1_000_000).decode("utf-8", errors="replace")


def parse_buddy_list(html: str, *, limit: int = 50) -> tuple[tuple[str, str, str], ...]:
    """Extract public BuddyList profile links as bounded metadata only."""
    parser = _AnchorParser()
    parser.feed(html)
    profiles: dict[str, tuple[str, str, str]] = {}
    for href, text in parser.anchors:
        url = _supported_naver_url(href, "https://m.blog.naver.com/")
        if url is None:
            continue
        blog_id = parse_qs(url.query).get("blogId", [""])[0] or _path_blog_id(url)
        if not blog_id or blog_id in profiles:
            continue
        if "PostList.naver" not in url.path and len(url.path.strip("/").split("/")) != 1:
            continue
        profiles[blog_id] = (text[:120] or blog_id, blog_id, f"https://blog.naver.com/{blog_id}")
        if len(profiles) >= limit:
            break
    return tuple(profiles.values())


def parse_search_posts(html: str, *, limit: int = 50) -> tuple[ImportedDiscoveryPost, ...]:
    """Extract direct public Naver post links from a saved-search result document."""
    parser = _AnchorParser()
    parser.feed(html)
    posts: dict[str, ImportedDiscoveryPost] = {}
    for href, text in parser.anchors:
        url = _supported_naver_url(href, "https://search.naver.com/")
        if url is None or not _is_post_url(url) or not text or url.geturl() in posts:
            continue
        try:
            posts[url.geturl()] = ImportedDiscoveryPost(source_url=url.geturl(), title=text[:300])
        except Exception:
            continue
        if len(posts) >= limit:
            break
    return tuple(posts.values())


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


class _AnchorParser(HTMLParser):
    """Small dependency-free anchor collector for fixed public list pages."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.anchors: list[tuple[str, str]] = []
        self._href: str | None = None
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a" or self._href is not None:
            return
        href = dict(attrs).get("href")
        if href:
            self._href = href
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag != "a" or self._href is None:
            return
        text = " ".join("".join(self._parts).split())
        self.anchors.append((unescape(self._href), text))
        self._href = None
        self._parts = []


def _supported_naver_url(value: str, base: str):
    url = urlsplit(urljoin(base, value))
    if url.scheme != "https" or url.hostname not in {"blog.naver.com", "m.blog.naver.com"}:
        return None
    return url._replace(fragment="")


def _path_blog_id(url) -> str:
    parts = [part for part in url.path.split("/") if part]
    return parts[0] if parts else ""


def _is_post_url(url) -> bool:
    parts = [part for part in url.path.split("/") if part]
    return "PostView" in url.path or "logNo" in parse_qs(url.query) or len(parts) >= 2


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
