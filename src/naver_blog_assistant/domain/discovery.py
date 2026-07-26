"""Local-only blog discovery queue models."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from urllib.parse import urlsplit
from uuid import UUID

from naver_blog_assistant.domain.models import DomainValidationError


class DiscoverySource(StrEnum):
    """Where a queued post was found."""

    NEIGHBOR = "neighbor"
    SEARCH = "search"


class DiscoveryState(StrEnum):
    """Human-controlled lifecycle for a discovered post."""

    QUEUED = "queued"
    OPENED = "opened"
    COMPLETED = "completed"
    SKIPPED = "skipped"
    UNAVAILABLE = "unavailable"


def normalize_discovery_url(value: str) -> str:
    """Return a safe canonical public Naver Blog post URL."""
    candidate = value.strip()
    parsed = urlsplit(candidate)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in {"blog.naver.com", "m.blog.naver.com"}
        or not parsed.path.startswith("/")
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise DomainValidationError("discovery URL must be a public Naver Blog HTTPS URL")
    return parsed._replace(fragment="").geturl()


@dataclass(frozen=True, slots=True)
class NeighborBlog:
    id: UUID
    name: str
    blog_url: str
    blog_id: str
    enabled: bool
    feed_status: str
    last_checked_at: datetime | None
    created_at: datetime

    def __post_init__(self) -> None:
        if not self.name.strip() or len(self.name) > 120:
            raise DomainValidationError("neighbor name must be between 1 and 120 characters")
        if not self.blog_id.strip() or len(self.blog_id) > 100:
            raise DomainValidationError("neighbor blog id must be between 1 and 100 characters")
        normalize_discovery_url(self.blog_url)
        if self.feed_status not in {"ready", "unavailable", "unknown"}:
            raise DomainValidationError("neighbor feed status is invalid")


@dataclass(frozen=True, slots=True)
class SavedSearch:
    id: UUID
    query: str
    excluded_terms: tuple[str, ...]
    freshness_days: int
    enabled: bool
    created_at: datetime

    def __post_init__(self) -> None:
        if not self.query.strip() or len(self.query) > 120:
            raise DomainValidationError("search query must be between 1 and 120 characters")
        if not 1 <= self.freshness_days <= 90:
            raise DomainValidationError("search freshness must be between 1 and 90 days")
        if len(self.excluded_terms) > 20 or any(
            not term.strip() or len(term) > 60 for term in self.excluded_terms
        ):
            raise DomainValidationError("excluded search terms are invalid")


@dataclass(frozen=True, slots=True)
class DiscoveredPost:
    id: UUID
    source: DiscoverySource
    state: DiscoveryState
    source_url: str
    title: str
    publisher_name: str | None
    published_at: datetime | None
    neighbor_id: UUID | None
    search_id: UUID | None
    created_at: datetime
    updated_at: datetime

    def __post_init__(self) -> None:
        normalize_discovery_url(self.source_url)
        if not self.title.strip() or len(self.title) > 300:
            raise DomainValidationError(
                "discovered post title must be between 1 and 300 characters"
            )
        if self.source is DiscoverySource.NEIGHBOR and self.neighbor_id is None:
            raise DomainValidationError("neighbor posts require a neighbor id")
        if self.source is DiscoverySource.SEARCH and self.search_id is None:
            raise DomainValidationError("search posts require a saved search id")


@dataclass(frozen=True, slots=True)
class ImportedDiscoveryPost:
    """Metadata extracted from a user-opened list page or a public RSS feed."""

    source_url: str
    title: str
    publisher_name: str | None = None
    published_at: datetime | None = None

    def __post_init__(self) -> None:
        normalize_discovery_url(self.source_url)
        if not self.title.strip() or len(self.title) > 300:
            raise DomainValidationError("imported post title must be between 1 and 300 characters")
        if self.publisher_name is not None and len(self.publisher_name.strip()) > 120:
            raise DomainValidationError("publisher name must not exceed 120 characters")


@dataclass(frozen=True, slots=True)
class DigestSettings:
    timezone: str = "Asia/Seoul"
    hour: int = 9
    minute: int = 0
    email_enabled: bool = False

    def __post_init__(self) -> None:
        if not self.timezone.strip() or len(self.timezone) > 64:
            raise DomainValidationError("digest timezone is invalid")
        if not 0 <= self.hour <= 23 or not 0 <= self.minute <= 59:
            raise DomainValidationError("digest time is invalid")
