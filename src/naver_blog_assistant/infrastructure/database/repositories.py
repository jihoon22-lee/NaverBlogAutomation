"""Transactional SQLite implementations of the persistence ports."""

from __future__ import annotations

import json
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any, Final
from uuid import UUID, uuid4

from sqlalchemy import Connection, Engine, delete, func, insert, select, update

from naver_blog_assistant.domain import (
    CandidateTone,
    CommentCandidate,
    Recommendation,
    ReviewStatus,
)
from naver_blog_assistant.infrastructure.database.schema import (
    comment_candidates,
    idempotency_records,
    recommendations,
)
from naver_blog_assistant.infrastructure.database.serialization import (
    deserialize_generation_preferences,
    deserialize_snapshot,
    deserialize_topics,
    format_timestamp,
    parse_timestamp,
    serialize_generation_preferences,
    serialize_snapshot,
    serialize_topics,
)
from naver_blog_assistant.ports import (
    GenerationFailureSnapshot,
    IdempotencyOutcome,
    IdempotencyReservation,
    RecommendationVersionConflictError,
)

DEFAULT_RESERVATION_TIMEOUT: Final = timedelta(seconds=30)


class SqliteRepository:
    """Store recommendations and coordinate idempotency in one SQLite database.

    A reservation has a short, safely reclaimable ``reserved`` phase before the model call.
    ``mark_generation_started`` moves it to ``generating``. Even an old generating row is never
    reclaimed automatically because the remote provider may already have produced a billable
    result. This deliberately favors manual recovery over duplicate generation.
    """

    def __init__(
        self,
        engine: Engine,
        *,
        clock: Callable[[], datetime] | None = None,
        reservation_timeout: timedelta = DEFAULT_RESERVATION_TIMEOUT,
        attempt_factory: Callable[[], UUID] | None = None,
    ) -> None:
        if reservation_timeout <= timedelta(0):
            raise ValueError("reservation_timeout must be positive")
        self._engine = engine
        self._clock = clock or (lambda: datetime.now(UTC))
        self._reservation_timeout = reservation_timeout
        self._attempt_factory = attempt_factory or uuid4

    def get(self, recommendation_id: UUID) -> Recommendation | None:
        """Return canonical review state with candidates in response order."""
        with self._engine.connect() as connection:
            row = (
                connection.execute(
                    select(recommendations).where(recommendations.c.id == str(recommendation_id))
                )
                .mappings()
                .one_or_none()
            )
            if row is None:
                return None
            candidate_rows = connection.execute(
                select(comment_candidates)
                .where(comment_candidates.c.recommendation_id == str(recommendation_id))
                .order_by(comment_candidates.c.position)
            ).mappings()
            return _map_recommendation(row, tuple(candidate_rows))

    def update(self, recommendation: Recommendation) -> Recommendation:
        """Persist review-only fields while protecting generated content from replacement."""
        with self._immediate_connection() as connection:
            existing = self._get_with_connection(connection, recommendation.id)
            if existing is None:
                raise LookupError(f"recommendation {recommendation.id} does not exist")
            if _generated_fields(existing) != _generated_fields(recommendation):
                raise ValueError("generated recommendation fields are immutable")

            result = connection.execute(
                update(recommendations)
                .where(
                    recommendations.c.id == str(recommendation.id),
                    recommendations.c.version == recommendation.version,
                )
                .values(
                    selected_candidate_id=(
                        str(recommendation.selected_candidate_id)
                        if recommendation.selected_candidate_id is not None
                        else None
                    ),
                    edited_comment=recommendation.edited_comment,
                    review_status=recommendation.review_status.value,
                    updated_at=(
                        format_timestamp(recommendation.updated_at)
                        if recommendation.updated_at is not None
                        else None
                    ),
                    version=recommendation.version + 1,
                )
            )
            if result.rowcount != 1:
                raise RecommendationVersionConflictError(
                    f"recommendation {recommendation.id} has a newer version"
                )
            return replace(recommendation, version=recommendation.version + 1)

    def list_recent(self, limit: int) -> tuple[Recommendation, ...]:
        """Return recent canonical recommendations ordered by their latest activity."""
        if not 1 <= limit <= 50:
            raise ValueError("history limit must be between 1 and 50")
        with self._engine.connect() as connection:
            identifiers = connection.execute(
                select(recommendations.c.id)
                .order_by(
                    func.coalesce(
                        recommendations.c.updated_at, recommendations.c.created_at
                    ).desc(),
                    recommendations.c.id.desc(),
                )
                .limit(limit)
            ).scalars()
            return tuple(
                item
                for recommendation_id in identifiers
                if (item := self._get_with_connection(connection, UUID(recommendation_id)))
                is not None
            )

    def delete(self, recommendation_id: UUID) -> bool:
        """Delete recommendation, candidates, and the completed idempotency snapshot."""
        with self._immediate_connection() as connection:
            connection.execute(
                delete(idempotency_records).where(
                    idempotency_records.c.recommendation_id == str(recommendation_id)
                )
            )
            result = connection.execute(
                delete(recommendations).where(recommendations.c.id == str(recommendation_id))
            )
            return result.rowcount == 1

    def reserve(self, key: UUID, request_hash: str) -> IdempotencyReservation:
        """Reserve a key under a SQLite write lock or classify the existing record."""
        _validate_hash(request_hash)
        now = self._now()
        with self._immediate_connection() as connection:
            row = (
                connection.execute(
                    select(idempotency_records).where(idempotency_records.c.key == str(key))
                )
                .mappings()
                .one_or_none()
            )
            if row is None:
                attempt_id = self._attempt_factory()
                connection.execute(
                    insert(idempotency_records).values(
                        key=str(key),
                        request_hash=request_hash,
                        attempt_id=str(attempt_id),
                        state="reserved",
                        started_at=format_timestamp(now),
                    )
                )
                return IdempotencyReservation(
                    IdempotencyOutcome.STARTED,
                    attempt_id=attempt_id,
                )

            if row["request_hash"] != request_hash:
                return IdempotencyReservation(IdempotencyOutcome.CONFLICT)
            if row["state"] == "completed":
                snapshot = row["response_snapshot"]
                if not isinstance(snapshot, str):
                    raise RuntimeError("completed idempotency record has no snapshot")
                return IdempotencyReservation(
                    IdempotencyOutcome.REPLAY,
                    deserialize_snapshot(snapshot),
                )
            if row["state"] in {"failed", "indeterminate"}:
                snapshot = row["failure_snapshot"]
                if not isinstance(snapshot, str):
                    raise RuntimeError("failed idempotency record has no snapshot")
                return IdempotencyReservation(
                    IdempotencyOutcome.FAILURE_REPLAY,
                    failure_snapshot=_deserialize_failure(snapshot),
                )
            if row["state"] == "reserved" and parse_timestamp(row["started_at"]) <= (
                now - self._reservation_timeout
            ):
                attempt_id = self._attempt_factory()
                connection.execute(
                    update(idempotency_records)
                    .where(idempotency_records.c.key == str(key))
                    .values(
                        attempt_id=str(attempt_id),
                        started_at=format_timestamp(now),
                    )
                )
                return IdempotencyReservation(
                    IdempotencyOutcome.STARTED,
                    attempt_id=attempt_id,
                )
            return IdempotencyReservation(IdempotencyOutcome.IN_PROGRESS)

    def mark_generation_started(self, key: UUID, attempt_id: UUID) -> None:
        """Make a reservation non-reclaimable immediately before the provider call."""
        now = self._now()
        with self._immediate_connection() as connection:
            result = connection.execute(
                update(idempotency_records)
                .where(
                    idempotency_records.c.key == str(key),
                    idempotency_records.c.attempt_id == str(attempt_id),
                    idempotency_records.c.state == "reserved",
                )
                .values(
                    state="generating",
                    generation_started_at=format_timestamp(now),
                )
            )
            if result.rowcount != 1:
                raise RuntimeError("idempotency reservation is not ready for generation")

    def commit_generation(
        self,
        key: UUID,
        attempt_id: UUID,
        *,
        recommendation: Recommendation,
    ) -> None:
        """Commit canonical rows and the immutable response snapshot atomically."""
        now = self._now()
        snapshot_json = serialize_snapshot(recommendation)
        with self._immediate_connection() as connection:
            state = connection.execute(
                select(idempotency_records.c.state).where(
                    idempotency_records.c.key == str(key),
                    idempotency_records.c.attempt_id == str(attempt_id),
                )
            ).scalar_one_or_none()
            if state != "generating":
                raise RuntimeError("idempotency key is not generating")

            connection.execute(
                insert(recommendations).values(**_recommendation_values(recommendation))
            )
            connection.execute(
                insert(comment_candidates),
                [
                    {
                        "id": str(candidate.id),
                        "recommendation_id": str(recommendation.id),
                        "position": position,
                        "tone": candidate.tone.value,
                        "comment": candidate.comment,
                        "referenced_detail": candidate.referenced_detail,
                    }
                    for position, candidate in enumerate(recommendation.candidates)
                ],
            )
            self._before_complete(connection)
            result = connection.execute(
                update(idempotency_records)
                .where(
                    idempotency_records.c.key == str(key),
                    idempotency_records.c.attempt_id == str(attempt_id),
                    idempotency_records.c.state == "generating",
                )
                .values(
                    state="completed",
                    completed_at=format_timestamp(now),
                    recommendation_id=str(recommendation.id),
                    response_snapshot=snapshot_json,
                )
            )
            if result.rowcount != 1:
                raise RuntimeError("idempotency completion was not applied")

    def release(self, key: UUID, attempt_id: UUID) -> None:
        """Delete an explicitly failed, incomplete reservation."""
        with self._immediate_connection() as connection:
            connection.execute(
                delete(idempotency_records).where(
                    idempotency_records.c.key == str(key),
                    idempotency_records.c.attempt_id == str(attempt_id),
                    idempotency_records.c.state.in_(("reserved", "generating")),
                )
            )

    def commit_failure(
        self,
        key: UUID,
        attempt_id: UUID,
        *,
        failure: GenerationFailureSnapshot,
        indeterminate: bool = False,
    ) -> None:
        """Persist a fenced safe failure without retaining provider payloads."""
        now = self._now()
        state = "indeterminate" if indeterminate else "failed"
        with self._immediate_connection() as connection:
            result = connection.execute(
                update(idempotency_records)
                .where(
                    idempotency_records.c.key == str(key),
                    idempotency_records.c.attempt_id == str(attempt_id),
                    idempotency_records.c.state == "generating",
                )
                .values(
                    state=state,
                    completed_at=format_timestamp(now),
                    failure_snapshot=_serialize_failure(failure),
                )
            )
            self._before_failure(connection)
            if result.rowcount != 1:
                raise RuntimeError("idempotency failure was not applied")

    def _before_complete(self, connection: Connection) -> None:
        """Provide a transaction-failure test seam without changing production behavior."""

    def _before_failure(self, connection: Connection) -> None:
        """Provide a safe-failure rollback test seam without changing production behavior."""

    def _get_with_connection(
        self, connection: Connection, recommendation_id: UUID
    ) -> Recommendation | None:
        row = (
            connection.execute(
                select(recommendations).where(recommendations.c.id == str(recommendation_id))
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            return None
        candidate_rows = connection.execute(
            select(comment_candidates)
            .where(comment_candidates.c.recommendation_id == str(recommendation_id))
            .order_by(comment_candidates.c.position)
        ).mappings()
        return _map_recommendation(row, tuple(candidate_rows))

    def _now(self) -> datetime:
        now = self._clock()
        if now.tzinfo is None:
            raise ValueError("database clock must return a timezone-aware timestamp")
        return now

    @contextmanager
    def _immediate_connection(self):
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


def _validate_hash(value: str) -> None:
    if len(value) != 64:
        raise ValueError("request_hash must be a SHA-256 hex digest")
    try:
        int(value, 16)
    except ValueError as error:
        raise ValueError("request_hash must be a SHA-256 hex digest") from error


def _serialize_failure(failure: GenerationFailureSnapshot) -> str:
    return json.dumps(
        {
            "status": failure.status,
            "code": failure.code,
            "title": failure.title,
            "detail": failure.detail,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _deserialize_failure(value: str) -> GenerationFailureSnapshot:
    loaded = json.loads(value)
    if not isinstance(loaded, dict):
        raise RuntimeError("failure snapshot must be an object")
    try:
        return GenerationFailureSnapshot(
            status=int(loaded["status"]),
            code=str(loaded["code"]),
            title=str(loaded["title"]),
            detail=str(loaded["detail"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError("failure snapshot is invalid") from error


def _recommendation_values(recommendation: Recommendation) -> dict[str, Any]:
    return {
        "id": str(recommendation.id),
        "source_url": recommendation.source_url,
        "title": recommendation.title,
        "content_hash": recommendation.content_hash,
        "excerpt": recommendation.excerpt,
        "summary": recommendation.summary,
        "topics_json": serialize_topics(recommendation.topics),
        "review_status": recommendation.review_status.value,
        "selected_candidate_id": (
            str(recommendation.selected_candidate_id)
            if recommendation.selected_candidate_id is not None
            else None
        ),
        "edited_comment": recommendation.edited_comment,
        "created_at": format_timestamp(recommendation.created_at),
        "updated_at": (
            format_timestamp(recommendation.updated_at)
            if recommendation.updated_at is not None
            else None
        ),
        "version": recommendation.version,
        "generation_preferences_json": serialize_generation_preferences(recommendation.preferences),
    }


def _map_recommendation(
    row: Any,
    candidate_rows: tuple[Any, ...],
) -> Recommendation:
    return Recommendation(
        id=UUID(row["id"]),
        source_url=row["source_url"],
        title=row["title"],
        content_hash=row["content_hash"],
        excerpt=row["excerpt"],
        summary=row["summary"],
        topics=deserialize_topics(row["topics_json"]),
        candidates=tuple(
            CommentCandidate(
                id=UUID(candidate["id"]),
                tone=CandidateTone(candidate["tone"]),
                comment=candidate["comment"],
                referenced_detail=candidate["referenced_detail"],
            )
            for candidate in candidate_rows
        ),
        review_status=ReviewStatus(row["review_status"]),
        created_at=parse_timestamp(row["created_at"]),
        preferences=deserialize_generation_preferences(row["generation_preferences_json"]),
        selected_candidate_id=(
            UUID(row["selected_candidate_id"]) if row["selected_candidate_id"] is not None else None
        ),
        edited_comment=row["edited_comment"],
        updated_at=parse_timestamp(row["updated_at"]) if row["updated_at"] else None,
        version=row["version"],
    )


def _generated_fields(recommendation: Recommendation) -> tuple[Any, ...]:
    return (
        recommendation.id,
        recommendation.source_url,
        recommendation.title,
        recommendation.content_hash,
        recommendation.excerpt,
        recommendation.summary,
        recommendation.topics,
        recommendation.candidates,
        recommendation.created_at,
        recommendation.preferences,
    )
