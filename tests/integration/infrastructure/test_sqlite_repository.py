"""Integration tests for migrations and transactional SQLite persistence."""

from __future__ import annotations

import json
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
from sqlalchemy.exc import IntegrityError

from naver_blog_assistant.application import (
    GenerateRecommendation,
    GenerationIndeterminateError,
    GenerationInvalidError,
    ReplayedGenerationFailure,
)
from naver_blog_assistant.domain import (
    DEFAULT_GENERATION_PREFERENCES,
    CandidateTone,
    CapturedPost,
    CommentCandidate,
    CommentLength,
    GeneratedComment,
    GenerationOutput,
    GenerationPreferences,
    Recommendation,
    Relationship,
    ReviewPatch,
    ReviewStatus,
    SpeechStyle,
)
from naver_blog_assistant.infrastructure.database import (
    SqliteRepository,
    create_sqlite_engine,
)
from naver_blog_assistant.infrastructure.database.schema import idempotency_records
from naver_blog_assistant.infrastructure.database.serialization import serialize_snapshot
from naver_blog_assistant.ports import (
    GenerationFailureSnapshot,
    IdempotencyOutcome,
    RecommendationVersionConflictError,
)

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


class FailingFailureRepository(SqliteRepository):
    def _before_failure(self, connection: object) -> None:
        raise RuntimeError("synthetic failure transaction error")


class DoubleFailingRepository(FailingFailureRepository):
    def _before_complete(self, connection: object) -> None:
        raise RuntimeError("synthetic completion transaction error")


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


class ErrorGenerator:
    def __init__(self, error: Exception) -> None:
        self.error = error

    def generate(self, post: CapturedPost) -> GenerationOutput:
        raise self.error


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
        preferences=DEFAULT_GENERATION_PREFERENCES,
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


def test_populated_v1_to_v2_preserves_all_idempotency_states(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'populated-v1.db'}"
    config = alembic_config(database_url)
    command.upgrade(config, "20260716_0001")
    item = recommendation()
    completed_key = UUID(int=901)
    reserved_key = UUID(int=902)
    generating_key = UUID(int=903)
    engine = create_sqlite_engine(database_url)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "INSERT INTO recommendations "
            "(id, source_url, title, content_hash, excerpt, summary, topics_json, "
            "review_status, selected_candidate_id, edited_comment, created_at, "
            "updated_at, version) "
            "VALUES (:id, :source_url, :title, :content_hash, :excerpt, :summary, :topics_json, "
            "'drafted', NULL, NULL, :created_at, NULL, 0)",
            {
                "id": str(item.id),
                "source_url": item.source_url,
                "title": item.title,
                "content_hash": item.content_hash,
                "excerpt": item.excerpt,
                "summary": item.summary,
                "topics_json": '["전시","관람 동선"]',
                "created_at": item.created_at.isoformat().replace("+00:00", "Z"),
            },
        )
        for position, candidate in enumerate(item.candidates):
            connection.exec_driver_sql(
                "INSERT INTO comment_candidates "
                "(id, recommendation_id, position, tone, comment, referenced_detail) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    str(candidate.id),
                    str(item.id),
                    position,
                    candidate.tone.value,
                    candidate.comment,
                    candidate.referenced_detail,
                ),
            )
        base = {
            "request_hash": REQUEST_HASH,
            "started_at": NOW.isoformat().replace("+00:00", "Z"),
        }
        connection.exec_driver_sql(
            "INSERT INTO idempotency_records "
            "(key, request_hash, attempt_id, state, started_at) "
            "VALUES (:key, :request_hash, :attempt_id, 'reserved', :started_at)",
            {**base, "key": str(reserved_key), "attempt_id": str(UUID(int=912))},
        )
        connection.exec_driver_sql(
            "INSERT INTO idempotency_records "
            "(key, request_hash, attempt_id, state, started_at, generation_started_at) "
            "VALUES (:key, :request_hash, :attempt_id, 'generating', :started_at, :started_at)",
            {**base, "key": str(generating_key), "attempt_id": str(UUID(int=913))},
        )
        connection.exec_driver_sql(
            "INSERT INTO idempotency_records "
            "(key, request_hash, attempt_id, state, started_at, generation_started_at, "
            "completed_at, recommendation_id, response_snapshot) VALUES "
            "(:key, :request_hash, :attempt_id, 'completed', :started_at, :started_at, "
            ":started_at, :recommendation_id, :snapshot)",
            {
                **base,
                "key": str(completed_key),
                "attempt_id": str(UUID(int=911)),
                "recommendation_id": str(item.id),
                "snapshot": serialize_snapshot(item),
            },
        )
    engine.dispose()

    command.upgrade(config, "20260717_0002")
    engine = create_sqlite_engine(database_url)
    repository = SqliteRepository(engine, clock=lambda: NOW)
    assert repository.reserve(reserved_key, REQUEST_HASH).outcome is IdempotencyOutcome.IN_PROGRESS
    assert (
        repository.reserve(generating_key, REQUEST_HASH).outcome is IdempotencyOutcome.IN_PROGRESS
    )
    replay = repository.reserve(completed_key, REQUEST_HASH)
    assert replay.outcome is IdempotencyOutcome.REPLAY
    assert replay.response_snapshot == item
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.execute(
            idempotency_records.insert().values(
                key=str(UUID(int=904)),
                request_hash=REQUEST_HASH,
                attempt_id=str(UUID(int=914)),
                state="failed",
                started_at=NOW.isoformat().replace("+00:00", "Z"),
                generation_started_at=NOW.isoformat().replace("+00:00", "Z"),
                completed_at=NOW.isoformat().replace("+00:00", "Z"),
            )
        )
    engine.dispose()


def test_populated_v2_to_v3_backfills_preferences_and_replays_legacy_snapshot(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'populated-v2.db'}"
    config = alembic_config(database_url)
    command.upgrade(config, "20260717_0002")
    item = recommendation()
    legacy_snapshot = json.loads(serialize_snapshot(item))
    del legacy_snapshot["generation_preferences"]
    selected_id = item.candidates[1].id
    engine = create_sqlite_engine(database_url)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "INSERT INTO recommendations "
            "(id, source_url, title, content_hash, excerpt, summary, topics_json, "
            "review_status, selected_candidate_id, edited_comment, created_at, "
            "updated_at, version) VALUES "
            "(:id, :source_url, :title, :content_hash, :excerpt, :summary, :topics_json, "
            "'drafted', NULL, NULL, :created_at, NULL, 0)",
            {
                "id": str(item.id),
                "source_url": item.source_url,
                "title": item.title,
                "content_hash": item.content_hash,
                "excerpt": item.excerpt,
                "summary": item.summary,
                "topics_json": json.dumps(item.topics, ensure_ascii=False),
                "created_at": item.created_at.isoformat().replace("+00:00", "Z"),
            },
        )
        for position, candidate in enumerate(item.candidates):
            connection.exec_driver_sql(
                "INSERT INTO comment_candidates "
                "(id, recommendation_id, position, tone, comment, referenced_detail) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    str(candidate.id),
                    str(item.id),
                    position,
                    candidate.tone.value,
                    candidate.comment,
                    candidate.referenced_detail,
                ),
            )
        connection.exec_driver_sql(
            "UPDATE recommendations SET review_status = 'approved', "
            "selected_candidate_id = ?, updated_at = ?, version = 1 WHERE id = ?",
            (
                str(selected_id),
                NOW.isoformat().replace("+00:00", "Z"),
                str(item.id),
            ),
        )
        connection.exec_driver_sql(
            "INSERT INTO idempotency_records "
            "(key, request_hash, attempt_id, state, started_at, generation_started_at, "
            "completed_at, recommendation_id, response_snapshot, failure_snapshot) VALUES "
            "(:key, :request_hash, :attempt_id, 'completed', :at, :at, :at, "
            ":recommendation_id, :snapshot, NULL)",
            {
                "key": str(KEY),
                "request_hash": REQUEST_HASH,
                "attempt_id": str(UUID(int=991)),
                "at": NOW.isoformat().replace("+00:00", "Z"),
                "recommendation_id": str(item.id),
                "snapshot": json.dumps(legacy_snapshot, ensure_ascii=False),
            },
        )
    engine.dispose()

    command.upgrade(config, "head")

    engine = create_sqlite_engine(database_url)
    preference_column = next(
        column
        for column in inspect(engine).get_columns("recommendations")
        if column["name"] == "generation_preferences_json"
    )
    assert preference_column["nullable"] is False
    assert preference_column["default"] is not None
    repository = SqliteRepository(engine, clock=lambda: NOW)
    canonical = repository.get(item.id)
    assert canonical is not None
    assert canonical.preferences is DEFAULT_GENERATION_PREFERENCES
    assert canonical.review_status is ReviewStatus.APPROVED
    assert canonical.selected_candidate_id == selected_id
    assert canonical.version == 1
    replay = repository.reserve(KEY, REQUEST_HASH)
    assert replay.outcome is IdempotencyOutcome.REPLAY
    assert replay.response_snapshot is not None
    assert replay.response_snapshot.preferences is DEFAULT_GENERATION_PREFERENCES
    assert replay.response_snapshot.review_status is ReviewStatus.DRAFTED
    engine.dispose()


def test_default_preferences_survive_v3_downgrade_and_reupgrade(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'default-preferences-downgrade.db'}"
    config = alembic_config(database_url)
    command.upgrade(config, "head")
    engine = create_sqlite_engine(database_url)
    repository = SqliteRepository(engine, clock=lambda: NOW)
    item = complete_generation(repository)
    reviewed = repository.update(
        item.apply_review(
            ReviewPatch(selected_candidate_index=0, review_status=ReviewStatus.APPROVED),
            reviewed_at=NOW + timedelta(minutes=1),
        )
    )
    engine.dispose()

    command.downgrade(config, "-1")
    engine = create_sqlite_engine(database_url)
    assert "generation_preferences_json" not in {
        column["name"] for column in inspect(engine).get_columns("recommendations")
    }
    with engine.connect() as connection:
        row = (
            connection.exec_driver_sql(
                "SELECT review_status, selected_candidate_id, version FROM recommendations"
            )
            .mappings()
            .one()
        )
        assert (
            connection.exec_driver_sql("SELECT count(*) FROM comment_candidates").scalar_one() == 3
        )
    assert row == {
        "review_status": "approved",
        "selected_candidate_id": str(reviewed.selected_candidate_id),
        "version": 1,
    }
    engine.dispose()

    command.upgrade(config, "head")
    engine = create_sqlite_engine(database_url)
    restarted = SqliteRepository(engine, clock=lambda: NOW)
    restored = restarted.get(item.id)
    assert restored is not None
    assert restored.preferences is DEFAULT_GENERATION_PREFERENCES
    replay = restarted.reserve(KEY, REQUEST_HASH)
    assert replay.response_snapshot is not None
    assert replay.response_snapshot.preferences is DEFAULT_GENERATION_PREFERENCES
    engine.dispose()


def test_v3_downgrade_refuses_non_default_preference_provenance(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'non-default-preferences.db'}"
    config = alembic_config(database_url)
    command.upgrade(config, "head")
    engine = create_sqlite_engine(database_url)
    repository = SqliteRepository(engine, clock=lambda: NOW)
    preferences = GenerationPreferences(
        relationship=Relationship.CLOSE,
        speech=SpeechStyle.BANMAL,
        length=CommentLength.LONG,
    )
    item = replace(recommendation(), preferences=preferences)
    reservation = repository.reserve(KEY, REQUEST_HASH)
    assert reservation.attempt_id is not None
    repository.mark_generation_started(KEY, reservation.attempt_id)
    repository.commit_generation(KEY, reservation.attempt_id, recommendation=item)
    engine.dispose()

    with pytest.raises(RuntimeError, match="non-default generation preferences"):
        command.downgrade(config, "-1")

    engine = create_sqlite_engine(database_url)
    with engine.connect() as connection:
        assert (
            connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one()
            == "20260719_0003"
        )
    persisted = SqliteRepository(engine, clock=lambda: NOW).get(item.id)
    assert persisted is not None
    assert persisted.preferences == preferences
    engine.dispose()


def test_downgrade_refuses_to_delete_failure_fences(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'failure-fence.db'}"
    config = alembic_config(database_url)
    command.upgrade(config, "head")
    engine = create_sqlite_engine(database_url)
    repository = SqliteRepository(engine, clock=lambda: NOW)
    reservation = repository.reserve(KEY, REQUEST_HASH)
    assert reservation.attempt_id is not None
    repository.mark_generation_started(KEY, reservation.attempt_id)
    repository.commit_failure(
        KEY,
        reservation.attempt_id,
        failure=GenerationFailureSnapshot(409, "indeterminate", "Unknown", "Safe detail"),
        indeterminate=True,
    )
    engine.dispose()

    with pytest.raises(RuntimeError, match="cannot downgrade"):
        command.downgrade(config, "20260716_0001")

    engine = create_sqlite_engine(database_url)
    with engine.connect() as connection:
        assert connection.execute(select(idempotency_records.c.state)).scalar_one() == (
            "indeterminate"
        )
        assert connection.exec_driver_sql(
            "SELECT version_num FROM alembic_version"
        ).scalar_one() == ("20260717_0002")
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


def test_failure_snapshot_rollback_keeps_conservative_generating_fence(
    migrated_database: tuple[str, Engine],
) -> None:
    _, engine = migrated_database
    repository = FailingFailureRepository(engine, clock=lambda: NOW)
    use_case = GenerateRecommendation(
        generator=ErrorGenerator(GenerationInvalidError("private provider detail")),
        idempotency=repository,
        clock=lambda: NOW,
    )

    with pytest.raises(GenerationIndeterminateError, match="persisted safely"):
        use_case.execute(
            post=CapturedPost(
                source_url="https://blog.naver.com/example/failure",
                title="실패 저장 테스트",
                body="실패 snapshot rollback을 검증하는 충분히 긴 합성 본문입니다.",
            ),
            idempotency_key=KEY,
        )

    with engine.connect() as connection:
        row = connection.execute(select(idempotency_records)).mappings().one()
    assert row["state"] == "generating"
    assert row["failure_snapshot"] is None


def test_completion_and_failure_snapshot_double_rollback_keeps_generating_fence(
    migrated_database: tuple[str, Engine],
) -> None:
    _, engine = migrated_database
    repository = DoubleFailingRepository(engine, clock=lambda: NOW)
    use_case = GenerateRecommendation(
        generator=StaticGenerator(),
        idempotency=repository,
        clock=lambda: NOW,
    )

    with pytest.raises(GenerationIndeterminateError, match="persisted safely"):
        use_case.execute(
            post=CapturedPost(
                source_url="https://blog.naver.com/example/double-failure",
                title="이중 rollback 테스트",
                body="추천 결과와 실패 snapshot의 이중 rollback을 검증하는 합성 본문입니다.",
            ),
            idempotency_key=KEY,
        )

    with engine.connect() as connection:
        row = connection.execute(select(idempotency_records)).mappings().one()
    assert row["state"] == "generating"
    assert row["response_snapshot"] is None
    assert row["failure_snapshot"] is None
    assert repository.get(recommendation().id) is None


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


@pytest.mark.parametrize("indeterminate", [False, True])
def test_safe_failure_replays_after_restart_and_is_fenced(
    migrated_database: tuple[str, Engine], indeterminate: bool
) -> None:
    database_url, engine = migrated_database
    repository = SqliteRepository(engine, clock=lambda: NOW)
    reservation = repository.reserve(KEY, REQUEST_HASH)
    assert reservation.attempt_id is not None
    repository.mark_generation_started(KEY, reservation.attempt_id)
    failure = GenerationFailureSnapshot(
        status=409 if indeterminate else 502,
        code="generation_indeterminate" if indeterminate else "generation_invalid",
        title="Safe title",
        detail="Safe detail.",
    )
    repository.commit_failure(
        KEY,
        reservation.attempt_id,
        failure=failure,
        indeterminate=indeterminate,
    )
    repository.release(KEY, reservation.attempt_id)
    engine.dispose()

    restarted_engine = create_sqlite_engine(database_url)
    restarted = SqliteRepository(restarted_engine, clock=lambda: NOW)
    replay = restarted.reserve(KEY, REQUEST_HASH)
    assert replay.outcome is IdempotencyOutcome.FAILURE_REPLAY
    assert replay.failure_snapshot == failure
    with pytest.raises(RuntimeError, match="not generating"):
        restarted.commit_generation(KEY, reservation.attempt_id, recommendation=recommendation())
    restarted_engine.dispose()


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

    with pytest.raises(GenerationIndeterminateError):
        use_case.execute(post=post, idempotency_key=KEY)

    with engine.connect() as connection:
        row = connection.execute(select(idempotency_records)).mappings().one()
    assert row["state"] == "indeterminate"
    assert row["generation_started_at"] is not None

    with pytest.raises(ReplayedGenerationFailure) as replayed:
        use_case.execute(post=post, idempotency_key=KEY)

    assert replayed.value.failure.code == "generation_indeterminate"

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

    changed_preferences = GenerationPreferences(
        relationship=Relationship.NEW,
        speech=SpeechStyle.HONORIFIC,
        length=CommentLength.SHORT,
    )
    with pytest.raises(ValueError, match="immutable"):
        repository.update(replace(item, preferences=changed_preferences))
    assert repository.get(item.id) == item


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
