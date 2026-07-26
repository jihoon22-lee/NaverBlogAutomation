"""Integration coverage for local-only discovery persistence."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from alembic import command
from alembic.config import Config

from naver_blog_assistant.domain import (
    AutoDiscoverySettings,
    DiscoverySource,
    DiscoveryState,
    ImportedDiscoveryPost,
)
from naver_blog_assistant.infrastructure.database import (
    SqliteDiscoveryRepository,
    create_sqlite_engine,
)

ROOT = Path(__file__).parents[3]
NOW = datetime(2026, 7, 26, 9, 0, tzinfo=UTC)


def test_discovery_repository_deduplicates_metadata_and_preserves_queue_state(
    tmp_path: Path,
) -> None:
    url = f"sqlite:///{tmp_path / 'discovery.db'}"
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "head")
    engine = create_sqlite_engine(url)
    try:
        clock_value = [NOW]
        repository = SqliteDiscoveryRepository(engine, clock=lambda: clock_value[0])
        neighbor = repository.save_neighbor(
            name="이웃", blog_url="https://blog.naver.com/friend", blog_id="friend"
        )
        assert (
            repository.save_neighbor(
                name="바뀐 이웃", blog_url="https://blog.naver.com/friend", blog_id="friend"
            ).id
            == neighbor.id
        )
        search = repository.save_search(query="전시", excluded_terms=("광고",), freshness_days=7)
        assert repository.list_searches() == (search,)

        post = ImportedDiscoveryPost(
            source_url="https://blog.naver.com/friend/123", title="새 글", publisher_name="이웃"
        )
        assert (
            repository.import_posts(
                source=DiscoverySource.NEIGHBOR, neighbor_id=neighbor.id, posts=(post,)
            )
            == 1
        )
        assert (
            repository.import_posts(
                source=DiscoverySource.NEIGHBOR, neighbor_id=neighbor.id, posts=(post,)
            )
            == 0
        )
        queued = repository.list_posts(DiscoverySource.NEIGHBOR)
        assert queued[0].state is DiscoveryState.QUEUED
        opened = repository.update_post_state(queued[0].id, DiscoveryState.OPENED)
        assert opened is not None
        assert opened.state is DiscoveryState.OPENED
        repository.update_neighbor_feed_status(neighbor.id, status="ready", checked_at=NOW)
        assert repository.list_neighbors()[0].feed_status == "ready"

        assert repository.get_digest_settings().hour == 9
        settings = repository.get_digest_settings().__class__(hour=8, minute=30, email_enabled=True)
        assert repository.save_digest_settings(settings) == settings
        assert repository.claim_digest_run("2026-07-26", neighbor_post_count=1)
        assert not repository.claim_digest_run("2026-07-26", neighbor_post_count=1)
        repository.mark_digest_email_sent("2026-07-26")
        automation = AutoDiscoverySettings(own_blog_id="mine", enabled=True, hour=8, minute=30)
        assert repository.save_automatic_settings(automation).own_blog_id == "mine"
        assert repository.claim_automatic_sync_run("2026-07-26")
        assert not repository.claim_automatic_sync_run("2026-07-26")
        assert (
            repository.record_automatic_sync(status="success", detail="동기화 완료").last_detail
            == "동기화 완료"
        )
        clock_value[0] = NOW + timedelta(days=31)
        assert repository.cleanup_old_posts() == 1
        assert repository.delete_search(search.id)
        assert repository.delete_neighbor(neighbor.id)
    finally:
        engine.dispose()


def test_search_candidate_exclusions_cover_own_neighbor_queued_and_recently_completed_blogs(
    tmp_path: Path,
) -> None:
    url = f"sqlite:///{tmp_path / 'discovery-exclusions.db'}"
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "head")
    engine = create_sqlite_engine(url)
    try:
        clock_value = [NOW]
        repository = SqliteDiscoveryRepository(engine, clock=lambda: clock_value[0])
        repository.save_neighbor(
            name="저장 이웃", blog_url="https://blog.naver.com/neighbor", blog_id="neighbor"
        )
        search = repository.save_search(query="전시", excluded_terms=(), freshness_days=14)
        queued = ImportedDiscoveryPost(
            source_url="https://blog.naver.com/queued/1", title="대기 중 후보"
        )
        completed = ImportedDiscoveryPost(
            source_url="https://blog.naver.com/completed/1", title="완료한 후보"
        )
        assert (
            repository.import_posts(
                source=DiscoverySource.SEARCH,
                search_id=search.id,
                posts=(queued, completed),
            )
            == 2
        )
        completed_id = next(
            item.id
            for item in repository.list_posts(DiscoverySource.SEARCH)
            if item.publisher_blog_id == "completed"
        )
        assert repository.update_post_state(completed_id, DiscoveryState.COMPLETED) is not None

        assert repository.excluded_search_blog_ids(own_blog_id="MINE") == {
            "mine",
            "neighbor",
            "queued",
            "completed",
        }

        clock_value[0] = NOW + timedelta(days=31)
        assert repository.excluded_search_blog_ids(own_blog_id="MINE") == {
            "mine",
            "neighbor",
            "queued",
        }
    finally:
        engine.dispose()
