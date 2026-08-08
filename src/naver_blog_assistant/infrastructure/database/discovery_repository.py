"""SQLite persistence for local blog discovery metadata."""

from __future__ import annotations

import json
from collections.abc import Callable
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Engine, delete, insert, select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from naver_blog_assistant.domain import (
    AutoDiscoverySettings,
    DigestSettings,
    DiscoveredPost,
    DiscoverySource,
    DiscoveryState,
    ImportedDiscoveryPost,
    NeighborBlog,
    SavedSearch,
)
from naver_blog_assistant.infrastructure.database.schema import (
    automatic_discovery_runs,
    automatic_discovery_settings,
    digest_runs,
    digest_settings,
    discovered_posts,
    neighbor_blogs,
    saved_searches,
)
from naver_blog_assistant.infrastructure.database.serialization import (
    format_timestamp,
    parse_timestamp,
)


class SqliteDiscoveryRepository:
    """Persist only discovery metadata; article bodies never enter these tables."""

    def __init__(self, engine: Engine, *, clock: Callable[[], datetime] | None = None) -> None:
        self._engine = engine
        self._clock = clock or (lambda: datetime.now(UTC))

    @contextmanager
    def _immediate_transaction(self):
        connection = self._engine.connect()
        try:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def list_neighbors(self) -> tuple[NeighborBlog, ...]:
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(neighbor_blogs).order_by(neighbor_blogs.c.name)
            ).mappings()
            return tuple(_neighbor(row) for row in rows)

    def save_neighbor(
        self, *, name: str, blog_url: str, blog_id: str, enabled: bool = True
    ) -> NeighborBlog:
        now = self._clock()
        with self._immediate_transaction() as connection:
            existing = (
                connection.execute(
                    select(neighbor_blogs).where(neighbor_blogs.c.blog_url == blog_url)
                )
                .mappings()
                .one_or_none()
            )
            if existing is None:
                identifier = uuid4()
                connection.execute(
                    insert(neighbor_blogs).values(
                        id=str(identifier),
                        name=name,
                        blog_url=blog_url,
                        blog_id=blog_id,
                        enabled=enabled,
                        feed_status="unknown",
                        last_checked_at=None,
                        created_at=format_timestamp(now),
                    )
                )
                row = (
                    connection.execute(
                        select(neighbor_blogs).where(neighbor_blogs.c.id == str(identifier))
                    )
                    .mappings()
                    .one()
                )
            else:
                connection.execute(
                    update(neighbor_blogs)
                    .where(neighbor_blogs.c.id == existing["id"])
                    .values(name=name, blog_id=blog_id, enabled=enabled)
                )
                row = (
                    connection.execute(
                        select(neighbor_blogs).where(neighbor_blogs.c.id == existing["id"])
                    )
                    .mappings()
                    .one()
                )
        return _neighbor(row)

    def delete_neighbor(self, neighbor_id: UUID) -> bool:
        with self._immediate_transaction() as connection:
            return (
                connection.execute(
                    delete(neighbor_blogs).where(neighbor_blogs.c.id == str(neighbor_id))
                ).rowcount
                == 1
            )

    def list_searches(self) -> tuple[SavedSearch, ...]:
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(saved_searches).order_by(saved_searches.c.query)
            ).mappings()
            return tuple(_search(row) for row in rows)

    def save_search(
        self,
        *,
        query: str,
        excluded_terms: tuple[str, ...],
        freshness_days: int,
        enabled: bool = True,
    ) -> SavedSearch:
        now = self._clock()
        encoded_terms = json.dumps(excluded_terms, ensure_ascii=False, separators=(",", ":"))
        with self._immediate_transaction() as connection:
            existing = (
                connection.execute(select(saved_searches).where(saved_searches.c.query == query))
                .mappings()
                .one_or_none()
            )
            if existing is None:
                identifier = uuid4()
                connection.execute(
                    insert(saved_searches).values(
                        id=str(identifier),
                        query=query,
                        excluded_terms_json=encoded_terms,
                        freshness_days=freshness_days,
                        enabled=enabled,
                        created_at=format_timestamp(now),
                    )
                )
                row = (
                    connection.execute(
                        select(saved_searches).where(saved_searches.c.id == str(identifier))
                    )
                    .mappings()
                    .one()
                )
            else:
                connection.execute(
                    update(saved_searches)
                    .where(saved_searches.c.id == existing["id"])
                    .values(
                        excluded_terms_json=encoded_terms,
                        freshness_days=freshness_days,
                        enabled=enabled,
                    )
                )
                row = (
                    connection.execute(
                        select(saved_searches).where(saved_searches.c.id == existing["id"])
                    )
                    .mappings()
                    .one()
                )
        return _search(row)

    def delete_search(self, search_id: UUID) -> bool:
        with self._immediate_transaction() as connection:
            return (
                connection.execute(
                    delete(saved_searches).where(saved_searches.c.id == str(search_id))
                ).rowcount
                == 1
            )

    def import_posts(
        self,
        *,
        source: DiscoverySource,
        posts: tuple[ImportedDiscoveryPost, ...],
        neighbor_id: UUID | None = None,
        search_id: UUID | None = None,
    ) -> int:
        if source is DiscoverySource.NEIGHBOR and neighbor_id is None:
            raise ValueError("neighbor imports require neighbor_id")
        if source is DiscoverySource.SEARCH and search_id is None:
            raise ValueError("search imports require search_id")
        now = self._clock()
        imported = 0
        with self._immediate_transaction() as connection:
            for post in posts[:50]:
                statement = (
                    sqlite_insert(discovered_posts)
                    .values(
                        id=str(uuid4()),
                        source=source.value,
                        state=DiscoveryState.QUEUED.value,
                        source_url=post.source_url,
                        title=post.title,
                        publisher_name=post.publisher_name,
                        publisher_blog_id=post.publisher_blog_id,
                        published_at=format_timestamp(post.published_at)
                        if post.published_at
                        else None,
                        neighbor_id=str(neighbor_id) if neighbor_id else None,
                        search_id=str(search_id) if search_id else None,
                        created_at=format_timestamp(now),
                        updated_at=format_timestamp(now),
                    )
                    .on_conflict_do_nothing(index_elements=["source_url"])
                )
                result = connection.execute(statement)
                imported += int(result.rowcount == 1)
        return imported

    def list_posts(
        self,
        source: DiscoverySource,
        *,
        limit: int = 100,
        include_states: tuple[DiscoveryState, ...] | None = None,
    ) -> tuple[DiscoveredPost, ...]:
        """List one source, optionally including recovered/skipped items for the web workbench."""
        states = include_states or (DiscoveryState.QUEUED, DiscoveryState.OPENED)
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(discovered_posts)
                .where(discovered_posts.c.source == source.value)
                .where(discovered_posts.c.state.in_([state.value for state in states]))
                .order_by(
                    discovered_posts.c.published_at.desc(), discovered_posts.c.created_at.desc()
                )
                .limit(limit)
            ).mappings()
            return tuple(_post(row) for row in rows)

    def get_post(self, post_id: UUID) -> DiscoveredPost | None:
        """Return one queued post by id, or None when it was removed."""
        with self._engine.connect() as connection:
            row = (
                connection.execute(
                    select(discovered_posts).where(discovered_posts.c.id == str(post_id))
                )
                .mappings()
                .one_or_none()
            )
        return None if row is None else _post(row)

    def update_post_state(self, post_id: UUID, state: DiscoveryState) -> DiscoveredPost | None:
        now = self._clock()
        with self._immediate_transaction() as connection:
            result = connection.execute(
                update(discovered_posts)
                .where(discovered_posts.c.id == str(post_id))
                .values(state=state.value, updated_at=format_timestamp(now))
            )
            if result.rowcount != 1:
                return None
            row = (
                connection.execute(
                    select(discovered_posts).where(discovered_posts.c.id == str(post_id))
                )
                .mappings()
                .one()
            )
        return _post(row)

    def excluded_search_blog_ids(self, *, own_blog_id: str, cooldown_days: int = 30) -> set[str]:
        """Return blogs that should not receive another new-neighbor candidate."""
        cutoff = self._clock() - timedelta(days=cooldown_days)
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(discovered_posts.c.publisher_blog_id)
                .where(discovered_posts.c.source == DiscoverySource.SEARCH.value)
                .where(discovered_posts.c.publisher_blog_id.is_not(None))
                .where(
                    discovered_posts.c.state.in_(
                        [DiscoveryState.QUEUED.value, DiscoveryState.OPENED.value]
                    )
                    | (
                        (discovered_posts.c.state == DiscoveryState.COMPLETED.value)
                        & (discovered_posts.c.updated_at >= format_timestamp(cutoff))
                    )
                )
            ).scalars()
        excluded = {value.casefold() for value in rows if isinstance(value, str) and value}
        excluded.update(item.blog_id.casefold() for item in self.list_neighbors())
        if own_blog_id.strip():
            excluded.add(own_blog_id.strip().casefold())
        return excluded

    def update_neighbor_feed_status(
        self, neighbor_id: UUID, *, status: str, checked_at: datetime
    ) -> None:
        with self._immediate_transaction() as connection:
            connection.execute(
                update(neighbor_blogs)
                .where(neighbor_blogs.c.id == str(neighbor_id))
                .values(feed_status=status, last_checked_at=format_timestamp(checked_at))
            )

    def get_digest_settings(self) -> DigestSettings:
        with self._engine.connect() as connection:
            row = (
                connection.execute(select(digest_settings).where(digest_settings.c.id == 1))
                .mappings()
                .one_or_none()
            )
        if row is None:
            return DigestSettings()
        return DigestSettings(
            timezone=row["timezone"],
            hour=row["hour"],
            minute=row["minute"],
            email_enabled=bool(row["email_enabled"]),
        )

    def save_digest_settings(self, settings: DigestSettings) -> DigestSettings:
        with self._immediate_transaction() as connection:
            connection.execute(
                sqlite_insert(digest_settings)
                .values(
                    id=1,
                    timezone=settings.timezone,
                    hour=settings.hour,
                    minute=settings.minute,
                    email_enabled=settings.email_enabled,
                )
                .on_conflict_do_update(
                    index_elements=["id"],
                    set_={
                        "timezone": settings.timezone,
                        "hour": settings.hour,
                        "minute": settings.minute,
                        "email_enabled": settings.email_enabled,
                    },
                )
            )
        return settings

    def claim_digest_run(self, local_date: str, *, neighbor_post_count: int) -> bool:
        with self._immediate_transaction() as connection:
            result = connection.execute(
                sqlite_insert(digest_runs)
                .values(
                    local_date=local_date,
                    created_at=format_timestamp(self._clock()),
                    neighbor_post_count=neighbor_post_count,
                    email_sent=False,
                )
                .on_conflict_do_nothing(index_elements=["local_date"])
            )
            return result.rowcount == 1

    def mark_digest_email_sent(self, local_date: str) -> None:
        with self._immediate_transaction() as connection:
            connection.execute(
                update(digest_runs)
                .where(digest_runs.c.local_date == local_date)
                .values(email_sent=True)
            )

    def get_automatic_settings(self) -> AutoDiscoverySettings:
        with self._engine.connect() as connection:
            row = (
                connection.execute(
                    select(automatic_discovery_settings).where(
                        automatic_discovery_settings.c.id == 1
                    )
                )
                .mappings()
                .one_or_none()
            )
        if row is None:
            return AutoDiscoverySettings()
        return _automatic_settings(row)

    def save_automatic_settings(self, settings: AutoDiscoverySettings) -> AutoDiscoverySettings:
        with self._immediate_transaction() as connection:
            connection.execute(
                sqlite_insert(automatic_discovery_settings)
                .values(
                    id=1,
                    own_blog_id=settings.own_blog_id.strip(),
                    enabled=settings.enabled,
                    timezone=settings.timezone,
                    hour=settings.hour,
                    minute=settings.minute,
                    last_synced_at=format_timestamp(settings.last_synced_at)
                    if settings.last_synced_at
                    else None,
                    last_status=settings.last_status,
                    last_detail=settings.last_detail,
                )
                .on_conflict_do_update(
                    index_elements=["id"],
                    set_={
                        "own_blog_id": settings.own_blog_id.strip(),
                        "enabled": settings.enabled,
                        "timezone": settings.timezone,
                        "hour": settings.hour,
                        "minute": settings.minute,
                    },
                )
            )
        return self.get_automatic_settings()

    def record_automatic_sync(self, *, status: str, detail: str) -> AutoDiscoverySettings:
        now = self._clock()
        with self._immediate_transaction() as connection:
            connection.execute(
                sqlite_insert(automatic_discovery_settings)
                .values(
                    id=1,
                    own_blog_id="",
                    enabled=False,
                    timezone="Asia/Seoul",
                    hour=9,
                    minute=0,
                    last_synced_at=format_timestamp(now),
                    last_status=status,
                    last_detail=detail[:300],
                )
                .on_conflict_do_update(
                    index_elements=["id"],
                    set_={
                        "last_synced_at": format_timestamp(now),
                        "last_status": status,
                        "last_detail": detail[:300],
                    },
                )
            )
        return self.get_automatic_settings()

    def claim_automatic_sync_run(self, local_date: str) -> bool:
        with self._immediate_transaction() as connection:
            result = connection.execute(
                sqlite_insert(automatic_discovery_runs)
                .values(local_date=local_date, created_at=format_timestamp(self._clock()))
                .on_conflict_do_nothing(index_elements=["local_date"])
            )
            return result.rowcount == 1

    def cleanup_old_posts(self, *, days: int = 30) -> int:
        cutoff = self._clock() - timedelta(days=days)
        with self._immediate_transaction() as connection:
            result = connection.execute(
                delete(discovered_posts).where(
                    discovered_posts.c.created_at < format_timestamp(cutoff)
                )
            )
            return result.rowcount


def _neighbor(row: Any) -> NeighborBlog:
    data = row
    return NeighborBlog(
        id=UUID(data["id"]),
        name=data["name"],
        blog_url=data["blog_url"],
        blog_id=data["blog_id"],
        enabled=bool(data["enabled"]),
        feed_status=data["feed_status"],
        last_checked_at=parse_timestamp(data["last_checked_at"])
        if data["last_checked_at"]
        else None,
        created_at=parse_timestamp(data["created_at"]),
    )


def _search(row: Any) -> SavedSearch:
    data = row
    terms = json.loads(data["excluded_terms_json"])
    return SavedSearch(
        id=UUID(data["id"]),
        query=data["query"],
        excluded_terms=tuple(terms),
        freshness_days=data["freshness_days"],
        enabled=bool(data["enabled"]),
        created_at=parse_timestamp(data["created_at"]),
    )


def _post(row: Any) -> DiscoveredPost:
    data = row
    return DiscoveredPost(
        id=UUID(data["id"]),
        source=DiscoverySource(data["source"]),
        state=DiscoveryState(data["state"]),
        source_url=data["source_url"],
        title=data["title"],
        publisher_name=data["publisher_name"],
        publisher_blog_id=data["publisher_blog_id"],
        published_at=parse_timestamp(data["published_at"]) if data["published_at"] else None,
        neighbor_id=UUID(data["neighbor_id"]) if data["neighbor_id"] else None,
        search_id=UUID(data["search_id"]) if data["search_id"] else None,
        created_at=parse_timestamp(data["created_at"]),
        updated_at=parse_timestamp(data["updated_at"]),
    )


def _automatic_settings(row: Any) -> AutoDiscoverySettings:
    data = row
    return AutoDiscoverySettings(
        own_blog_id=data["own_blog_id"],
        enabled=bool(data["enabled"]),
        timezone=data["timezone"],
        hour=data["hour"],
        minute=data["minute"],
        last_synced_at=parse_timestamp(data["last_synced_at"]) if data["last_synced_at"] else None,
        last_status=data["last_status"],
        last_detail=data["last_detail"],
    )
