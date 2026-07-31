"""SQLite persistence for the author's own blog catalog.

A sync replaces the whole snapshot it observed. Categories that disappeared are removed so a stale
category cannot be offered, and post metadata is upserted per URL.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime

from sqlalchemy import delete, select
from sqlalchemy.engine import Engine

from naver_blog_assistant.domain.blog import BlogCategory, ReferencePost
from naver_blog_assistant.infrastructure.database.schema import (
    blog_categories,
    blog_reference_posts,
)


class SqliteBlogCatalogRepository:
    """Store and read the cached category tree and post metadata."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def replace_categories(self, categories: Sequence[BlogCategory]) -> tuple[BlogCategory, ...]:
        """Replace the whole category snapshot in one transaction."""
        synced_at = datetime.now(UTC)
        with self._engine.begin() as connection:
            connection.execute(delete(blog_categories))
            for category in categories:
                connection.execute(
                    blog_categories.insert().values(
                        category_no=category.category_no,
                        name=category.name,
                        post_count=category.post_count,
                        synced_at=synced_at.isoformat(),
                    )
                )
        return tuple(
            BlogCategory(
                category_no=category.category_no,
                name=category.name,
                post_count=category.post_count,
                synced_at=synced_at,
            )
            for category in categories
        )

    def categories(self) -> tuple[BlogCategory, ...]:
        """Return every cached category ordered by number."""
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(blog_categories).order_by(blog_categories.c.category_no)
            ).all()
        return tuple(
            BlogCategory(
                category_no=int(row.category_no),
                name=row.name,
                post_count=None if row.post_count is None else int(row.post_count),
                synced_at=datetime.fromisoformat(row.synced_at),
            )
            for row in rows
        )

    def upsert_posts(self, posts: Sequence[ReferencePost]) -> tuple[ReferencePost, ...]:
        """Replace the metadata of each observed post without touching the others."""
        synced_at = datetime.now(UTC)
        with self._engine.begin() as connection:
            for post in posts:
                connection.execute(
                    delete(blog_reference_posts).where(
                        blog_reference_posts.c.source_url == post.source_url
                    )
                )
                connection.execute(
                    blog_reference_posts.insert().values(
                        source_url=post.source_url,
                        category_no=post.category_no,
                        title=post.title,
                        published_at=None
                        if post.published_at is None
                        else post.published_at.isoformat(),
                        synced_at=synced_at.isoformat(),
                    )
                )
        return tuple(
            ReferencePost(
                category_no=post.category_no,
                source_url=post.source_url,
                title=post.title,
                published_at=post.published_at,
                synced_at=synced_at,
            )
            for post in posts
        )

    def posts_for(
        self, category_numbers: Sequence[int], *, limit: int
    ) -> tuple[ReferencePost, ...]:
        """Return the newest cached posts for the given categories, newest first."""
        if limit < 1 or not category_numbers:
            return ()
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(blog_reference_posts)
                .where(blog_reference_posts.c.category_no.in_(list(category_numbers)))
                .order_by(
                    blog_reference_posts.c.published_at.desc().nulls_last(),
                    blog_reference_posts.c.source_url,
                )
                .limit(limit)
            ).all()
        return tuple(
            ReferencePost(
                category_no=int(row.category_no),
                source_url=row.source_url,
                title=row.title,
                published_at=None
                if row.published_at is None
                else date.fromisoformat(row.published_at),
                synced_at=datetime.fromisoformat(row.synced_at),
            )
            for row in rows
        )

    def clear(self) -> None:
        """Remove the whole cached catalog."""
        with self._engine.begin() as connection:
            connection.execute(delete(blog_reference_posts))
            connection.execute(delete(blog_categories))
