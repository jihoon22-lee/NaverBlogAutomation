"""Transactional SQLite state for approved browser engagement runs."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Engine, insert, select, update

from naver_blog_assistant.domain import (
    DiscoverySource,
    DiscoveryState,
    EngagementRun,
    EngagementRunState,
    EngagementStep,
    EngagementStepName,
    EngagementStepState,
    ReviewStatus,
    required_engagement_steps,
    same_naver_post_url,
)
from naver_blog_assistant.infrastructure.database.schema import (
    discovered_posts,
    engagement_runs,
    engagement_steps,
    recommendations,
)
from naver_blog_assistant.infrastructure.database.serialization import (
    format_timestamp,
    parse_timestamp,
)


@dataclass(frozen=True, slots=True)
class EngagementRunStart:
    """A newly created run or the existing run for the same discovery post."""

    created: bool
    run: EngagementRun


class SqliteEngagementRepository:
    """Persist step results without receiving final comments or request messages."""

    def __init__(self, engine: Engine, *, clock: Callable[[], datetime] | None = None) -> None:
        self._engine = engine
        self._clock = clock or (lambda: datetime.now(UTC))

    def start(
        self,
        *,
        approval_id: UUID,
        discovery_post_id: UUID,
        recommendation_id: UUID,
    ) -> EngagementRunStart:
        now = self._now()
        with self._immediate_transaction() as connection:
            by_approval = (
                connection.execute(
                    select(engagement_runs).where(engagement_runs.c.approval_id == str(approval_id))
                )
                .mappings()
                .one_or_none()
            )
            if by_approval is not None:
                existing = self._get_with_connection(connection, UUID(by_approval["id"]))
                if (
                    existing is None
                    or existing.discovery_post_id != discovery_post_id
                    or existing.recommendation_id != recommendation_id
                ):
                    raise ValueError("engagement approval is already bound to another run")
                return EngagementRunStart(created=False, run=existing)

            by_post = (
                connection.execute(
                    select(engagement_runs).where(
                        engagement_runs.c.discovery_post_id == str(discovery_post_id)
                    )
                )
                .mappings()
                .one_or_none()
            )
            if by_post is not None:
                existing = self._get_with_connection(connection, UUID(by_post["id"]))
                if existing is None or existing.recommendation_id != recommendation_id:
                    raise ValueError("discovery post is already bound to another recommendation")
                return EngagementRunStart(created=False, run=existing)

            post = (
                connection.execute(
                    select(discovered_posts).where(discovered_posts.c.id == str(discovery_post_id))
                )
                .mappings()
                .one_or_none()
            )
            recommendation = (
                connection.execute(
                    select(recommendations).where(recommendations.c.id == str(recommendation_id))
                )
                .mappings()
                .one_or_none()
            )
            if post is None or recommendation is None:
                raise LookupError("engagement source was not found")
            if not same_naver_post_url(post["source_url"], recommendation["source_url"]):
                raise ValueError("recommendation does not belong to the discovery post")
            if recommendation["review_status"] != ReviewStatus.APPROVED.value:
                raise ValueError("recommendation must be approved before engagement")
            source = DiscoverySource(post["source"])
            if source is DiscoverySource.SEARCH and not post["publisher_blog_id"]:
                raise ValueError("search engagement requires a publisher blog id")

            run_id = uuid4()
            timestamp = format_timestamp(now)
            connection.execute(
                insert(engagement_runs).values(
                    id=str(run_id),
                    approval_id=str(approval_id),
                    discovery_post_id=str(discovery_post_id),
                    recommendation_id=str(recommendation_id),
                    source=source.value,
                    state=EngagementRunState.RUNNING.value,
                    created_at=timestamp,
                    updated_at=timestamp,
                )
            )
            connection.execute(
                insert(engagement_steps),
                [
                    {
                        "run_id": str(run_id),
                        "name": name.value,
                        "position": position,
                        "state": EngagementStepState.PENDING.value,
                        "result_code": None,
                        "updated_at": timestamp,
                    }
                    for position, name in enumerate(required_engagement_steps(source))
                ],
            )
            run = self._get_with_connection(connection, run_id)
            if run is None:
                raise RuntimeError("created engagement run could not be read")
            return EngagementRunStart(created=True, run=run)

    def get(self, run_id: UUID) -> EngagementRun | None:
        with self._engine.connect() as connection:
            return self._get_with_connection(connection, run_id)

    def get_for_post(self, post_id: UUID) -> EngagementRun | None:
        with self._engine.connect() as connection:
            run_id = connection.execute(
                select(engagement_runs.c.id).where(
                    engagement_runs.c.discovery_post_id == str(post_id)
                )
            ).scalar_one_or_none()
            return None if run_id is None else self._get_with_connection(connection, UUID(run_id))

    def list_recent(self, limit: int) -> tuple[EngagementRun, ...]:
        if not 1 <= limit <= 50:
            raise ValueError("engagement history limit must be between 1 and 50")
        with self._engine.connect() as connection:
            run_ids = connection.execute(
                select(engagement_runs.c.id)
                .order_by(engagement_runs.c.updated_at.desc(), engagement_runs.c.id.desc())
                .limit(limit)
            ).scalars()
            return tuple(
                run
                for run_id in run_ids
                if (run := self._get_with_connection(connection, UUID(run_id))) is not None
            )

    def transition_step(
        self,
        run_id: UUID,
        step_name: EngagementStepName,
        state: EngagementStepState,
        *,
        result_code: str | None = None,
    ) -> EngagementRun:
        now = self._now()
        with self._immediate_transaction() as connection:
            run = self._get_with_connection(connection, run_id)
            if run is None:
                raise LookupError("engagement run was not found")
            step = next((item for item in run.steps if item.name is step_name), None)
            if step is None:
                raise ValueError("engagement step does not belong to the run")
            if step.state is state and step.result_code == result_code:
                return run
            self._validate_transition(run, step, state, result_code)
            timestamp = format_timestamp(now)
            connection.execute(
                update(engagement_steps)
                .where(
                    engagement_steps.c.run_id == str(run_id),
                    engagement_steps.c.name == step_name.value,
                )
                .values(
                    state=state.value,
                    result_code=result_code,
                    updated_at=timestamp,
                )
            )
            if step_name is EngagementStepName.COMMENT and state is EngagementStepState.SUCCEEDED:
                self._complete_recommendation(
                    connection, run.recommendation_id, updated_at=timestamp
                )

            refreshed = self._get_with_connection(connection, run_id)
            if refreshed is None:
                raise RuntimeError("engagement run disappeared during transition")
            aggregate = _aggregate_state(refreshed.steps)
            connection.execute(
                update(engagement_runs)
                .where(engagement_runs.c.id == str(run_id))
                .values(state=aggregate.value, updated_at=timestamp)
            )
            if aggregate is EngagementRunState.SUCCEEDED:
                connection.execute(
                    update(discovered_posts)
                    .where(discovered_posts.c.id == str(run.discovery_post_id))
                    .values(state=DiscoveryState.COMPLETED.value, updated_at=timestamp)
                )
            completed = self._get_with_connection(connection, run_id)
            if completed is None:
                raise RuntimeError("updated engagement run could not be read")
            return completed

    def complete_manually(
        self,
        run_id: UUID,
        *,
        completed_steps: tuple[EngagementStepName, ...],
    ) -> EngagementRun:
        """Record only user-confirmed steps without re-running browser actions.

        Pending steps deliberately remain pending, so a user can complete a failed
        comment manually and later approve a remaining mutual-neighbor request.
        """
        if EngagementStepName.COMMENT not in completed_steps:
            raise ValueError("manual completion requires the comment step")
        if len(set(completed_steps)) != len(completed_steps):
            raise ValueError("manual completion contains duplicate steps")

        now = self._now()
        with self._immediate_transaction() as connection:
            run = self._get_with_connection(connection, run_id)
            if run is None:
                raise LookupError("engagement run was not found")
            expected = {step.name for step in run.steps}
            if not set(completed_steps).issubset(expected):
                raise ValueError("manual completion contains a step outside the run")
            if any(step.state is EngagementStepState.UNCONFIRMED for step in run.steps):
                raise ValueError("unconfirmed engagement results cannot be manually finalized")

            timestamp = format_timestamp(now)
            completed = set(completed_steps)
            for step in run.steps:
                if step.state in {EngagementStepState.SUCCEEDED, EngagementStepState.SKIPPED}:
                    continue
                if step.name not in completed:
                    continue
                connection.execute(
                    update(engagement_steps)
                    .where(
                        engagement_steps.c.run_id == str(run_id),
                        engagement_steps.c.name == step.name.value,
                    )
                    .values(
                        state=EngagementStepState.SUCCEEDED.value,
                        result_code="manual_confirmed",
                        updated_at=timestamp,
                    )
                )

            self._complete_recommendation(connection, run.recommendation_id, updated_at=timestamp)
            refreshed = self._get_with_connection(connection, run_id)
            if refreshed is None:
                raise RuntimeError("manually updated engagement run could not be read")
            aggregate = _aggregate_state(refreshed.steps)
            connection.execute(
                update(engagement_runs)
                .where(engagement_runs.c.id == str(run_id))
                .values(state=aggregate.value, updated_at=timestamp)
            )
            if aggregate is EngagementRunState.SUCCEEDED:
                connection.execute(
                    update(discovered_posts)
                    .where(discovered_posts.c.id == str(run.discovery_post_id))
                    .values(state=DiscoveryState.COMPLETED.value, updated_at=timestamp)
                )
            finalized = self._get_with_connection(connection, run_id)
            if finalized is None:
                raise RuntimeError("manually finalized engagement run could not be read")
            return finalized

    def _complete_recommendation(
        self, connection: Any, recommendation_id: UUID, *, updated_at: str
    ) -> None:
        status = connection.execute(
            select(recommendations.c.review_status).where(
                recommendations.c.id == str(recommendation_id)
            )
        ).scalar_one_or_none()
        if status not in {ReviewStatus.APPROVED.value, ReviewStatus.COMPLETED.value}:
            raise ValueError("only an approved recommendation can complete its comment step")
        if status == ReviewStatus.APPROVED.value:
            connection.execute(
                update(recommendations)
                .where(recommendations.c.id == str(recommendation_id))
                .values(
                    review_status=ReviewStatus.COMPLETED.value,
                    updated_at=updated_at,
                    version=recommendations.c.version + 1,
                )
            )

    def _validate_transition(
        self,
        run: EngagementRun,
        step: EngagementStep,
        state: EngagementStepState,
        result_code: str | None,
    ) -> None:
        if state is EngagementStepState.RUNNING:
            if result_code is not None or step.state not in {
                EngagementStepState.PENDING,
                EngagementStepState.FAILED,
            }:
                raise ValueError("only pending or failed engagement steps can start")
            previous = run.steps[: step.position]
            if any(
                item.state not in {EngagementStepState.SUCCEEDED, EngagementStepState.SKIPPED}
                for item in previous
            ):
                raise ValueError("engagement steps must start in order")
            return
        if (
            step.state is not EngagementStepState.RUNNING
            or state
            not in {
                EngagementStepState.SUCCEEDED,
                EngagementStepState.SKIPPED,
                EngagementStepState.FAILED,
                EngagementStepState.UNCONFIRMED,
            }
            or result_code is None
        ):
            raise ValueError("running engagement step requires one terminal result")
        EngagementStep(
            name=step.name,
            position=step.position,
            state=state,
            result_code=result_code,
            updated_at=self._now(),
        )

    def _get_with_connection(self, connection: Any, run_id: UUID) -> EngagementRun | None:
        row = (
            connection.execute(select(engagement_runs).where(engagement_runs.c.id == str(run_id)))
            .mappings()
            .one_or_none()
        )
        if row is None:
            return None
        step_rows = tuple(
            connection.execute(
                select(engagement_steps)
                .where(engagement_steps.c.run_id == str(run_id))
                .order_by(engagement_steps.c.position)
            ).mappings()
        )
        return _map_run(row, step_rows)

    def _now(self) -> datetime:
        now = self._clock()
        if now.tzinfo is None:
            raise ValueError("engagement database clock must return a timezone-aware timestamp")
        return now

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


def _aggregate_state(steps: tuple[EngagementStep, ...]) -> EngagementRunState:
    if any(step.state is EngagementStepState.UNCONFIRMED for step in steps):
        return EngagementRunState.UNCONFIRMED
    if any(step.state is EngagementStepState.FAILED for step in steps):
        return EngagementRunState.FAILED
    if all(
        step.state in {EngagementStepState.SUCCEEDED, EngagementStepState.SKIPPED} for step in steps
    ):
        return EngagementRunState.SUCCEEDED
    return EngagementRunState.RUNNING


def _map_run(row: Any, step_rows: tuple[Any, ...]) -> EngagementRun:
    return EngagementRun(
        id=UUID(row["id"]),
        approval_id=UUID(row["approval_id"]),
        discovery_post_id=UUID(row["discovery_post_id"]),
        recommendation_id=UUID(row["recommendation_id"]),
        source=DiscoverySource(row["source"]),
        state=EngagementRunState(row["state"]),
        steps=tuple(
            EngagementStep(
                name=EngagementStepName(step["name"]),
                position=step["position"],
                state=EngagementStepState(step["state"]),
                result_code=step["result_code"],
                updated_at=parse_timestamp(step["updated_at"]),
            )
            for step in step_rows
        ),
        created_at=parse_timestamp(row["created_at"]),
        updated_at=parse_timestamp(row["updated_at"]),
    )
