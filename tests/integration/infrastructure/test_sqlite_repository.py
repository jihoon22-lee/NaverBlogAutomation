"""Integration tests for migrations and transactional SQLite persistence."""

from __future__ import annotations

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Barrier
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, inspect, select

from naver_blog_assistant.application import GenerateRecommendation, GenerationInProgressError
from naver_blog_assistant.domain import (
    CandidateTone,
    CapturedPost,
    CommentCandidate,
    GeneratedComment,
    GenerationOutput,
    Recommendation,
    ReviewPatch,
    ReviewStatus,
)
from naver_blog_assistant.infrastructure.database import (
    SqliteRepository,
    create_sqlite_engine,
)
from naver_blog_assistant.infrastructure.database.schema import idempotency_records
from naver_blog_assistant.ports import IdempotencyOutcome, RecommendationVersionConflictError

ROOT = Path(__file__).parents[3]
KEY = UUID("00000000-0000-0000-0000-000000000001")
REQUEST_HASH = "a" * 64
NOW = datetime(2026, 7, 16, 12, 30, 45, 123456, tzinfo=UTC)


class MutableClock:
    def __init__(self, value: datetime) -> None:
        self.value = value

    def __call__(self) -> datetime:
        return self.value


class FailingRepository(SqliteRepository):
    def _before_complete(self, connection: object) -> None:
        raise RuntimeError("synthetic transaction failure")


class StaticGenerator:
    def generate(self, post: CapturedPost) -> GenerationOutput:
        return GenerationOutput(
            summary=f"{post.title} 요약",
            topics=("전시",),
            candidates=tuple(
                GeneratedComment(
                    tone=tone,
                    comment=f"{tone.value} 댓글",
                    referenced_detail="본문의 전시 동선",
                )
                for tone in CandidateTone
            ),
        )


class TimeoutGenerator:
    def __init__(self) -> None:
        self.calls = 0

    def generate(self, post: CapturedPost) -> GenerationOutput:
        self.calls += 1
        raise TimeoutError("synthetic provider timeout")


def alembic_config(database_url: str) -> Config:
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


@pytest.fixture
def migrated_database(tmp_path: Path) -> Iterator[tuple[str, Engine]]:
    database_url = f"sqlite:///{tmp_path / 'assistant.db'}"
    command.upgrade(alembic_config(database_url), "head")
    engine = create_sqlite_engine(database_url)
    yield database_url, engine
    engine.dispose()


def recommendation() -> Recommendation:
    return Recommendation(
        id=UUID("00000000-0000-0000-0000-000000000010"),
        source_url="https://blog.naver.com/example/123",
        title="주말 전시 후기",
        content_hash="b" * 64,
        excerpt="인상 깊었던 전시 작품 일부",
        summary="전시 작품과 관람 동선을 소개한 후기",
        topics=("전시", "관람 동선"),
        candidates=tuple(
            CommentCandidate(
                id=UUID(f"00000000-0000-0000-0000-{index:012d}"),
                tone=tone,
                comment=f"{tone.value} 댓글",
                referenced_detail=f"{tone.value} 근거",
            )
            for index, tone in enumerate(CandidateTone, start=20)
        ),
        review_status=ReviewStatus.DRAFTED,
        created_at=NOW,
    )


def complete_generation(repository: SqliteRepository) -> Recommendation:
    item = recommendation()
    reservation = repository.reserve(KEY, REQUEST_HASH)
    assert reservation.outcome is IdempotencyOutcome.STARTED
    assert reservation.attempt_id is not None
    repository.mark_generation_started(KEY, reservation.attempt_id)
    repository.commit_generation(KEY, reservation.attempt_id, recommendation=item)
    return item


def test_migration_upgrade_and_downgrade(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'migration.db'}"
    config = alembic_config(database_url)

    command.upgrade(config, "head")
    engine = create_sqlite_engine(database_url)
    assert set(inspect(engine).get_table_names()) >= {
        "alembic_version",
        "comment_candidates",
        "idempotency_records",
        "recommendations",
    }

    command.downgrade(config, "base")
    assert inspect(engine).get_table_names() == ["alembic_version"]
    engine.dispose()


def test_migration_downgrade_handles_reviewed_rows(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'populated-migration.db'}"
    config = alembic_config(database_url)
    command.upgrade(config, "head")
    engine = create_sqlite_engine(database_url)
    repository = SqliteRepository(engine, clock=lambda: NOW)
    item = complete_generation(repository)
    repository.update(
        item.apply_review(
            ReviewPatch(selected_candidate_index=0, review_status=ReviewStatus.APPROVED),
            reviewed_at=NOW + timedelta(minutes=1),
        )
    )
    engine.dispose()

    command.downgrade(config, "base")

    engine = create_sqlite_engine(database_url)
    assert inspect(engine).get_table_names() == ["alembic_version"]
    engine.dispose()


def test_crud_round_trip_preserves_uuid_enum_topics_and_timestamps(
    migrated_database: tuple[str, Engine],
) -> None:
    _, engine = migrated_database
    repository = SqliteRepository(engine, clock=lambda: NOW)
    item = complete_generation(repository)

    loaded = repository.get(item.id)

    assert loaded == item
    assert loaded is not None
    assert loaded.created_at == NOW
    assert tuple(candidate.tone for candidate in loaded.candidates) == tuple(CandidateTone)
    assert repository.get(UUID(int=404)) is None


def test_review_updates_canonical_but_replay_keeps_exact_first_snapshot(
    migrated_database: tuple[str, Engine],
) -> None:
    database_url, engine = migrated_database
    repository = SqliteRepository(engine, clock=lambda: NOW)
    initial = complete_generation(repository)
    reviewed_at = NOW + timedelta(minutes=5)
    reviewed = initial.apply_review(
        ReviewPatch(
            selected_candidate_index=1,
            edited_comment="사용자가 다듬은 댓글",
            review_status=ReviewStatus.APPROVED,
        ),
        reviewed_at=reviewed_at,
    )
    persisted = repository.update(reviewed)
    engine.dispose()

    restarted_engine = create_sqlite_engine(database_url)
    restarted = SqliteRepository(restarted_engine, clock=lambda: reviewed_at)
    assert restarted.get(initial.id) == persisted
    replay = restarted.reserve(KEY, REQUEST_HASH)
    assert replay.outcome is IdempotencyOutcome.REPLAY
    assert replay.response_snapshot == initial
    assert replay.response_snapshot != persisted
    restarted_engine.dispose()


def test_commit_failure_rolls_back_canonical_and_snapshot(
    migrated_database: tuple[str, Engine],
) -> None:
    _, engine = migrated_database
    repository = FailingRepository(engine, clock=lambda: NOW)
    item = recommendation()
    reservation = repository.reserve(KEY, REQUEST_HASH)
    assert reservation.attempt_id is not None
    repository.mark_generation_started(KEY, reservation.attempt_id)

    with pytest.raises(RuntimeError, match="synthetic transaction"):
        repository.commit_generation(KEY, reservation.attempt_id, recommendation=item)

    assert repository.get(item.id) is None
    assert repository.reserve(KEY, REQUEST_HASH).outcome is IdempotencyOutcome.IN_PROGRESS
    with engine.connect() as connection:
        row = connection.execute(select(idempotency_records)).mappings().one()
    assert row["state"] == "generating"
    assert row["response_snapshot"] is None
    assert row["recommendation_id"] is None


def test_same_key_with_different_hash_conflicts(
    migrated_database: tuple[str, Engine],
) -> None:
    _, engine = migrated_database
    repository = SqliteRepository(engine, clock=lambda: NOW)
    repository.reserve(KEY, REQUEST_HASH)

    assert repository.reserve(KEY, "c" * 64).outcome is IdempotencyOutcome.CONFLICT


def test_concurrent_reservation_has_exactly_one_winner(
    migrated_database: tuple[str, Engine],
) -> None:
    database_url, _ = migrated_database
    barrier = Barrier(2)

    def reserve() -> IdempotencyOutcome:
        engine = create_sqlite_engine(database_url)
        repository = SqliteRepository(engine, clock=lambda: NOW)
        barrier.wait()
        try:
            return repository.reserve(KEY, REQUEST_HASH).outcome
        finally:
            engine.dispose()

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(lambda _: reserve(), range(2)))

    assert sorted(outcomes) == sorted([IdempotencyOutcome.STARTED, IdempotencyOutcome.IN_PROGRESS])


def test_only_stale_pre_generation_reservation_is_recovered(
    migrated_database: tuple[str, Engine],
) -> None:
    _, engine = migrated_database
    clock = MutableClock(NOW)
    repository = SqliteRepository(
        engine,
        clock=clock,
        reservation_timeout=timedelta(seconds=10),
    )
    first = repository.reserve(KEY, REQUEST_HASH)
    assert first.outcome is IdempotencyOutcome.STARTED
    assert first.attempt_id is not None
    assert repository.reserve(KEY, REQUEST_HASH).outcome is IdempotencyOutcome.IN_PROGRESS

    clock.value += timedelta(seconds=11)
    second = repository.reserve(KEY, REQUEST_HASH)
    assert second.outcome is IdempotencyOutcome.STARTED
    assert second.attempt_id is not None
    assert second.attempt_id != first.attempt_id
    repository.mark_generation_started(KEY, second.attempt_id)

    clock.value += timedelta(days=7)
    assert repository.reserve(KEY, REQUEST_HASH).outcome is IdempotencyOutcome.IN_PROGRESS


def test_fencing_prevents_old_attempt_from_mutating_reclaimed_reservation(
    migrated_database: tuple[str, Engine],
) -> None:
    _, engine = migrated_database
    clock = MutableClock(NOW)
    old_token = UUID(int=801)
    new_token = UUID(int=802)
    old = SqliteRepository(
        engine,
        clock=clock,
        reservation_timeout=timedelta(seconds=10),
        attempt_factory=lambda: old_token,
    )
    first = old.reserve(KEY, REQUEST_HASH)
    assert first.attempt_id == old_token

    clock.value += timedelta(seconds=11)
    new = SqliteRepository(
        engine,
        clock=clock,
        reservation_timeout=timedelta(seconds=10),
        attempt_factory=lambda: new_token,
    )
    second = new.reserve(KEY, REQUEST_HASH)
    assert second.attempt_id == new_token

    with pytest.raises(RuntimeError, match="not ready"):
        old.mark_generation_started(KEY, old_token)
    old.release(KEY, old_token)
    new.mark_generation_started(KEY, new_token)
    with pytest.raises(RuntimeError, match="not generating"):
        old.commit_generation(KEY, old_token, recommendation=recommendation())

    third = SqliteRepository(engine, clock=clock)
    assert third.reserve(KEY, REQUEST_HASH).outcome is IdempotencyOutcome.IN_PROGRESS
    new.commit_generation(KEY, new_token, recommendation=recommendation())
    replay = third.reserve(KEY, REQUEST_HASH)
    assert replay.outcome is IdempotencyOutcome.REPLAY
    assert replay.response_snapshot == recommendation()


def test_release_allows_known_failed_generation_to_retry(
    migrated_database: tuple[str, Engine],
) -> None:
    _, engine = migrated_database
    repository = SqliteRepository(engine, clock=lambda: NOW)
    reservation = repository.reserve(KEY, REQUEST_HASH)
    assert reservation.attempt_id is not None
    repository.mark_generation_started(KEY, reservation.attempt_id)

    repository.release(KEY, reservation.attempt_id)

    assert repository.reserve(KEY, REQUEST_HASH).outcome is IdempotencyOutcome.STARTED


def test_production_path_timeout_preserves_generating_row_and_blocks_retry(
    migrated_database: tuple[str, Engine],
) -> None:
    _, engine = migrated_database
    repository = SqliteRepository(engine, clock=lambda: NOW)
    generator = TimeoutGenerator()
    use_case = GenerateRecommendation(
        generator=generator,
        idempotency=repository,
        clock=lambda: NOW,
    )
    post = CapturedPost(
        source_url="https://blog.naver.com/example/timeout",
        title="타임아웃 재현 글",
        body="제공자 응답을 기다리는 동안 타임아웃이 발생한 본문입니다.",
    )

    with pytest.raises(TimeoutError, match="provider timeout"):
        use_case.execute(post=post, idempotency_key=KEY)

    with engine.connect() as connection:
        row = connection.execute(select(idempotency_records)).mappings().one()
    assert row["state"] == "generating"
    assert row["generation_started_at"] is not None

    with pytest.raises(GenerationInProgressError):
        use_case.execute(post=post, idempotency_key=KEY)

    assert generator.calls == 1


def test_database_never_contains_complete_body_or_credentials(
    migrated_database: tuple[str, Engine], tmp_path: Path
) -> None:
    _, engine = migrated_database
    repository = SqliteRepository(engine, clock=lambda: NOW)
    unpublished_body = "인상 깊었던 전시 작품 일부" + " 절대 저장하면 안 되는 본문" * 100
    GenerateRecommendation(
        generator=StaticGenerator(),
        idempotency=repository,
        clock=lambda: NOW,
    ).execute(
        post=CapturedPost(
            source_url="https://blog.naver.com/example/private",
            title="비공개 전시 기록",
            body=unpublished_body,
        ),
        idempotency_key=KEY,
    )
    columns = {
        column["name"]
        for table in ("recommendations", "comment_candidates", "idempotency_records")
        for column in inspect(engine).get_columns(table)
    }
    engine.dispose()

    assert "body" not in columns
    database_bytes = (tmp_path / "assistant.db").read_bytes()
    assert unpublished_body.encode() not in database_bytes
    assert b"sk-proj-" not in database_bytes


def test_engine_enables_foreign_keys_and_wal(migrated_database: tuple[str, Engine]) -> None:
    _, engine = migrated_database
    assert engine.hide_parameters
    with engine.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1
        assert connection.exec_driver_sql("PRAGMA journal_mode").scalar_one() == "wal"


def test_invalid_operations_are_rejected(migrated_database: tuple[str, Engine]) -> None:
    _, engine = migrated_database
    repository = SqliteRepository(engine, clock=lambda: NOW)
    item = recommendation()

    with pytest.raises(ValueError, match="SHA-256"):
        repository.reserve(KEY, "invalid")
    with pytest.raises(RuntimeError, match="not ready"):
        repository.mark_generation_started(KEY, UUID(int=700))
    with pytest.raises(RuntimeError, match="not generating"):
        repository.commit_generation(KEY, UUID(int=700), recommendation=item)
    with pytest.raises(LookupError, match="does not exist"):
        repository.update(item)


def test_update_rejects_generated_content_replacement(
    migrated_database: tuple[str, Engine],
) -> None:
    _, engine = migrated_database
    repository = SqliteRepository(engine, clock=lambda: NOW)
    item = complete_generation(repository)

    with pytest.raises(ValueError, match="immutable"):
        repository.update(replace(item, summary="바뀐 생성 요약"))


def test_stale_review_cannot_overwrite_or_regress_newer_state(
    migrated_database: tuple[str, Engine],
) -> None:
    _, engine = migrated_database
    first_adapter = SqliteRepository(engine, clock=lambda: NOW)
    second_adapter = SqliteRepository(engine, clock=lambda: NOW + timedelta(minutes=1))
    item = complete_generation(first_adapter)
    first_read = first_adapter.get(item.id)
    second_read = second_adapter.get(item.id)
    assert first_read is not None and second_read is not None

    approved = first_adapter.update(
        first_read.apply_review(
            ReviewPatch(review_status=ReviewStatus.APPROVED),
            reviewed_at=NOW,
        )
    )
    with pytest.raises(RecommendationVersionConflictError):
        second_adapter.update(
            second_read.apply_review(
                ReviewPatch(edited_comment="stale draft edit"),
                reviewed_at=NOW + timedelta(minutes=1),
            )
        )

    assert first_adapter.get(item.id) == approved
    assert approved.version == 1


def test_constructor_and_clock_validation(migrated_database: tuple[str, Engine]) -> None:
    _, engine = migrated_database
    with pytest.raises(ValueError, match="positive"):
        SqliteRepository(engine, reservation_timeout=timedelta(0))
    repository = SqliteRepository(engine, clock=lambda: datetime(2026, 7, 16))
    with pytest.raises(ValueError, match="timezone-aware"):
        repository.reserve(KEY, REQUEST_HASH)


def test_engine_rejects_non_sqlite_url() -> None:
    with pytest.raises(ValueError, match="sqlite"):
        create_sqlite_engine("postgresql://localhost/example")


def test_engine_creates_database_parent_directory(tmp_path: Path) -> None:
    database_path = tmp_path / "nested" / "assistant.db"
    engine = create_sqlite_engine(f"sqlite:///{database_path}")
    with engine.connect() as connection:
        connection.exec_driver_sql("SELECT 1")
    engine.dispose()

    assert database_path.exists()
