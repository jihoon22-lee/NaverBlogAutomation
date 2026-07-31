"""SQLite persistence for the daily activity ledger.

One row per (date, action) keeps the daily cap cheap to check and makes the count survive a restart.
Counting is idempotent per call: the caller records what actually happened, once.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select, update
from sqlalchemy.engine import Engine

from naver_blog_assistant.domain.engagement import EngagementStepName
from naver_blog_assistant.infrastructure.database.schema import automation_activity_ledger


class SqliteActivityLedger:
    """Count external actions per day."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def record(self, day: date, action: EngagementStepName, *, amount: int = 1) -> int:
        """Add ``amount`` to one action's count for ``day`` and return the new count."""
        if amount < 1:
            raise ValueError("amount must be positive")
        key = day.isoformat()
        with self._engine.begin() as connection:
            current = connection.execute(
                select(automation_activity_ledger.c.count).where(
                    automation_activity_ledger.c.date == key,
                    automation_activity_ledger.c.action == action.value,
                )
            ).scalar_one_or_none()
            if current is None:
                connection.execute(
                    automation_activity_ledger.insert().values(
                        date=key, action=action.value, count=amount
                    )
                )
                return amount
            total = int(current) + amount
            connection.execute(
                update(automation_activity_ledger)
                .where(
                    automation_activity_ledger.c.date == key,
                    automation_activity_ledger.c.action == action.value,
                )
                .values(count=total)
            )
        return total

    def count(self, day: date, action: EngagementStepName) -> int:
        """Return how many times one action ran on ``day``."""
        with self._engine.connect() as connection:
            value = connection.execute(
                select(automation_activity_ledger.c.count).where(
                    automation_activity_ledger.c.date == day.isoformat(),
                    automation_activity_ledger.c.action == action.value,
                )
            ).scalar_one_or_none()
        return 0 if value is None else int(value)

    def counts(self, day: date) -> dict[EngagementStepName, int]:
        """Return every recorded count for ``day``."""
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(
                    automation_activity_ledger.c.action, automation_activity_ledger.c.count
                ).where(automation_activity_ledger.c.date == day.isoformat())
            ).all()
        return {EngagementStepName(str(row.action)): int(str(row.count)) for row in rows}
