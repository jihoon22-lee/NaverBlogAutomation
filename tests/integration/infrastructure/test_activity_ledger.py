"""SQLite behavior for the daily activity ledger."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy.engine import Engine

from naver_blog_assistant.domain.engagement import EngagementStepName
from naver_blog_assistant.infrastructure.database.activity_ledger import SqliteActivityLedger
from naver_blog_assistant.infrastructure.database.engine import create_sqlite_engine
from naver_blog_assistant.infrastructure.database.schema import metadata

TODAY = date(2026, 8, 1)
TOMORROW = date(2026, 8, 2)


@pytest.fixture
def ledger(tmp_path: Path) -> Iterator[SqliteActivityLedger]:
    engine: Engine = create_sqlite_engine(f"sqlite:///{tmp_path / 'ledger.db'}")
    metadata.create_all(engine)
    yield SqliteActivityLedger(engine)
    engine.dispose()


def test_an_unrecorded_action_counts_zero(ledger: SqliteActivityLedger) -> None:
    assert ledger.count(TODAY, EngagementStepName.LIKE) == 0
    assert ledger.counts(TODAY) == {}


def test_recording_accumulates_per_action(ledger: SqliteActivityLedger) -> None:
    assert ledger.record(TODAY, EngagementStepName.LIKE) == 1
    assert ledger.record(TODAY, EngagementStepName.LIKE) == 2
    assert ledger.record(TODAY, EngagementStepName.COMMENT) == 1

    assert ledger.counts(TODAY) == {
        EngagementStepName.LIKE: 2,
        EngagementStepName.COMMENT: 1,
    }


def test_each_day_counts_separately(ledger: SqliteActivityLedger) -> None:
    ledger.record(TODAY, EngagementStepName.LIKE, amount=3)

    assert ledger.count(TOMORROW, EngagementStepName.LIKE) == 0
    assert ledger.count(TODAY, EngagementStepName.LIKE) == 3


def test_an_amount_greater_than_one_is_added_at_once(ledger: SqliteActivityLedger) -> None:
    assert ledger.record(TODAY, EngagementStepName.MUTUAL_NEIGHBOR, amount=4) == 4


def test_a_non_positive_amount_is_rejected(ledger: SqliteActivityLedger) -> None:
    with pytest.raises(ValueError, match="positive"):
        ledger.record(TODAY, EngagementStepName.LIKE, amount=0)


def test_counts_survive_a_new_repository_instance(
    ledger: SqliteActivityLedger, tmp_path: Path
) -> None:
    ledger.record(TODAY, EngagementStepName.COMMENT, amount=2)
    engine = create_sqlite_engine(f"sqlite:///{tmp_path / 'ledger.db'}")

    try:
        assert SqliteActivityLedger(engine).count(TODAY, EngagementStepName.COMMENT) == 2
    finally:
        engine.dispose()
