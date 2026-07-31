"""SQLite persistence for provider attempts.

One row records one provider attempt for one request so a repeat can be replayed instead of paid for
again, and so the daily call budget can be measured without a second ledger.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.engine import Engine

from naver_blog_assistant.domain.llm import LlmCallStatus, ModelSelection
from naver_blog_assistant.infrastructure.database.schema import llm_generation_attempts


@dataclass(frozen=True, slots=True)
class RecordedAttempt:
    """One stored provider attempt."""

    id: UUID
    request_hash: str
    attempt: int
    selection: ModelSelection
    status: LlmCallStatus
    result_code: str | None
    recommendation_id: UUID | None
    retry_after: int | None
    created_at: datetime


class SqliteLlmAttemptRepository:
    """Append one row per provider attempt and answer replay and budget questions."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def record(
        self,
        *,
        request_hash: str,
        attempt: int,
        selection: ModelSelection,
        status: LlmCallStatus,
        result_code: str | None = None,
        recommendation_id: UUID | None = None,
        retry_after: int | None = None,
    ) -> RecordedAttempt:
        """Store one attempt, replacing any earlier row for the same selection."""
        created_at = datetime.now(UTC)
        row_id = uuid4()
        with self._engine.begin() as connection:
            connection.execute(
                llm_generation_attempts.delete().where(
                    llm_generation_attempts.c.request_hash == request_hash,
                    llm_generation_attempts.c.attempt == attempt,
                    llm_generation_attempts.c.provider == selection.provider.value,
                    llm_generation_attempts.c.model == selection.model,
                )
            )
            connection.execute(
                llm_generation_attempts.insert().values(
                    id=str(row_id),
                    request_hash=request_hash,
                    attempt=attempt,
                    provider=selection.provider.value,
                    model=selection.model,
                    status=status.value,
                    result_code=result_code,
                    recommendation_id=None if recommendation_id is None else str(recommendation_id),
                    retry_after=retry_after,
                    created_at=created_at.isoformat(),
                )
            )
        return RecordedAttempt(
            id=row_id,
            request_hash=request_hash,
            attempt=attempt,
            selection=selection,
            status=status,
            result_code=result_code,
            recommendation_id=recommendation_id,
            retry_after=retry_after,
            created_at=created_at,
        )

    def count_since(self, moment: datetime) -> int:
        """Return how many attempts were recorded at or after ``moment``."""
        with self._engine.connect() as connection:
            total = connection.execute(
                select(func.count())
                .select_from(llm_generation_attempts)
                .where(llm_generation_attempts.c.created_at >= moment.isoformat())
            ).scalar_one()
        return int(total)

    def for_request(self, request_hash: str, attempt: int) -> list[RecordedAttempt]:
        """Return every recorded attempt for one request, ordered by provider."""
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(llm_generation_attempts)
                .where(
                    llm_generation_attempts.c.request_hash == request_hash,
                    llm_generation_attempts.c.attempt == attempt,
                )
                .order_by(llm_generation_attempts.c.provider)
            ).all()
        return [
            RecordedAttempt(
                id=UUID(row.id),
                request_hash=row.request_hash,
                attempt=int(row.attempt),
                selection=ModelSelection(provider=row.provider, model=row.model),
                status=LlmCallStatus(row.status),
                result_code=row.result_code,
                recommendation_id=None
                if row.recommendation_id is None
                else UUID(row.recommendation_id),
                retry_after=None if row.retry_after is None else int(row.retry_after),
                created_at=datetime.fromisoformat(row.created_at),
            )
            for row in rows
        ]
