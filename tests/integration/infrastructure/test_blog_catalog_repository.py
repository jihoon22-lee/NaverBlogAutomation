"""SQLite behavior for the own-blog catalog cache."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy.engine import Engine

from naver_blog_assistant.domain.blog import BlogCategory, ReferencePost
from naver_blog_assistant.infrastructure.database.blog_catalog_repository import (
    SqliteBlogCatalogRepository,
)
from naver_blog_assistant.infrastructure.database.engine import create_sqlite_engine
from naver_blog_assistant.infrastructure.database.schema import metadata


@pytest.fixture
def repository(tmp_path: Path) -> Iterator[SqliteBlogCatalogRepository]:
    engine: Engine = create_sqlite_engine(f"sqlite:///{tmp_path / 'catalog.db'}")
    metadata.create_all(engine)
    yield SqliteBlogCatalogRepository(engine)
    engine.dispose()


def post(url: str, *, category_no: int = 7, published: str | None = "2026-07-20") -> ReferencePost:
    return ReferencePost(
        category_no=category_no,
        source_url=url,
        title=f"글 {url[-1]}",
        published_at=None if published is None else date.fromisoformat(published),
    )


def test_a_sync_replaces_the_whole_category_snapshot(
    repository: SqliteBlogCatalogRepository,
) -> None:
    repository.replace_categories(
        [BlogCategory(category_no=7, name="전시"), BlogCategory(category_no=8, name="요리")]
    )

    repository.replace_categories([BlogCategory(category_no=7, name="전시 후기")])

    cached = repository.categories()
    assert [category.category_no for category in cached] == [7]
    assert cached[0].name == "전시 후기"
    assert cached[0].synced_at is not None


def test_posts_are_upserted_per_url(repository: SqliteBlogCatalogRepository) -> None:
    repository.upsert_posts([post("https://blog.naver.com/example/1")])

    repository.upsert_posts(
        [
            ReferencePost(
                category_no=8,
                source_url="https://blog.naver.com/example/1",
                title="옮겨진 글",
                published_at=date(2026, 7, 21),
            )
        ]
    )

    stored = repository.posts_for([7, 8], limit=5)
    assert len(stored) == 1
    assert stored[0].category_no == 8
    assert stored[0].title == "옮겨진 글"


def test_posts_are_returned_newest_first_with_undated_last(
    repository: SqliteBlogCatalogRepository,
) -> None:
    repository.upsert_posts(
        [
            post("https://blog.naver.com/example/1", published="2026-05-01"),
            post("https://blog.naver.com/example/2", published="2026-07-01"),
            post("https://blog.naver.com/example/3", published=None),
        ]
    )

    stored = repository.posts_for([7], limit=5)

    assert [entry.source_url[-1] for entry in stored] == ["2", "1", "3"]


def test_the_limit_bounds_the_result(repository: SqliteBlogCatalogRepository) -> None:
    repository.upsert_posts(
        [post(f"https://blog.naver.com/example/{index}") for index in range(1, 5)]
    )

    assert len(repository.posts_for([7], limit=2)) == 2


def test_an_empty_request_returns_nothing(repository: SqliteBlogCatalogRepository) -> None:
    repository.upsert_posts([post("https://blog.naver.com/example/1")])

    assert repository.posts_for([], limit=5) == ()
    assert repository.posts_for([7], limit=0) == ()


def test_clearing_removes_both_tables(repository: SqliteBlogCatalogRepository) -> None:
    repository.replace_categories([BlogCategory(category_no=7, name="전시")])
    repository.upsert_posts([post("https://blog.naver.com/example/1")])

    repository.clear()

    assert repository.categories() == ()
    assert repository.posts_for([7], limit=5) == ()
