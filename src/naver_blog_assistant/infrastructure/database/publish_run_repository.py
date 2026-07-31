"""SQLite persistence for staging runs.

The step machine is forward-only: a recorded result cannot be overwritten, so a repeated run skips
what already succeeded instead of doing it twice.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import select, update
from sqlalchemy.engine import Engine

from naver_blog_assistant.domain.publishing import (
    PUBLISH_STEP_ORDER,
    PublishRun,
    PublishRunState,
    PublishStep,
    PublishStepName,
    PublishStepState,
    aggregate_state,
    assert_step_transition,
)
from naver_blog_assistant.infrastructure.database.schema import publish_run_steps, publish_runs


class PublishRunNotFoundError(LookupError):
    """Raised when a staging run does not exist."""

    def __init__(self, run_id: UUID) -> None:
        super().__init__(f"publish run {run_id} was not found")
        self.run_id = run_id


class SqlitePublishRunRepository:
    """Start one run per draft revision and record each step result once."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def start(self, *, draft_id: UUID, revision_id: UUID) -> PublishRun:
        """Return the existing run for this revision, or create it."""
        existing = self.for_revision(draft_id, revision_id)
        if existing is not None:
            return existing
        now = datetime.now(UTC)
        run_id = uuid4()
        with self._engine.begin() as connection:
            connection.execute(
                publish_runs.insert().values(
                    id=str(run_id),
                    draft_id=str(draft_id),
                    revision_id=str(revision_id),
                    state=PublishRunState.RUNNING.value,
                    result_code=None,
                    created_at=now.isoformat(),
                    updated_at=now.isoformat(),
                )
            )
            for position, name in enumerate(PUBLISH_STEP_ORDER):
                connection.execute(
                    publish_run_steps.insert().values(
                        run_id=str(run_id),
                        name=name.value,
                        position=position,
                        state=PublishStepState.PENDING.value,
                        result_code=None,
                        updated_at=now.isoformat(),
                    )
                )
        return self.get(run_id)

    def get(self, run_id: UUID) -> PublishRun:
        """Return one run with its steps."""
        with self._engine.connect() as connection:
            row = connection.execute(
                select(publish_runs).where(publish_runs.c.id == str(run_id))
            ).one_or_none()
            if row is None:
                raise PublishRunNotFoundError(run_id)
            steps = connection.execute(
                select(publish_run_steps)
                .where(publish_run_steps.c.run_id == str(run_id))
                .order_by(publish_run_steps.c.position)
            ).all()
        return PublishRun(
            id=run_id,
            draft_id=UUID(row.draft_id),
            revision_id=UUID(row.revision_id),
            state=PublishRunState(row.state),
            steps=tuple(
                PublishStep(
                    name=PublishStepName(step.name),
                    position=int(step.position),
                    state=PublishStepState(step.state),
                    result_code=step.result_code,
                    updated_at=datetime.fromisoformat(step.updated_at),
                )
                for step in steps
            ),
            result_code=row.result_code,
            created_at=datetime.fromisoformat(row.created_at),
            updated_at=datetime.fromisoformat(row.updated_at),
        )

    def for_revision(self, draft_id: UUID, revision_id: UUID) -> PublishRun | None:
        """Return the run bound to one revision, or None."""
        with self._engine.connect() as connection:
            row = connection.execute(
                select(publish_runs.c.id).where(
                    publish_runs.c.draft_id == str(draft_id),
                    publish_runs.c.revision_id == str(revision_id),
                )
            ).one_or_none()
        return None if row is None else self.get(UUID(row.id))

    def transition_step(
        self,
        run_id: UUID,
        name: PublishStepName,
        state: PublishStepState,
        *,
        result_code: str | None = None,
    ) -> PublishRun:
        """Record one step result, refusing a backward or repeated transition."""
        run = self.get(run_id)
        assert_step_transition(run.step(name).state, state)
        now = datetime.now(UTC)
        with self._engine.begin() as connection:
            connection.execute(
                update(publish_run_steps)
                .where(
                    publish_run_steps.c.run_id == str(run_id),
                    publish_run_steps.c.name == name.value,
                )
                .values(state=state.value, result_code=result_code, updated_at=now.isoformat())
            )
        updated = self.get(run_id)
        aggregate = aggregate_state(updated.steps)
        with self._engine.begin() as connection:
            connection.execute(
                update(publish_runs)
                .where(publish_runs.c.id == str(run_id))
                .values(state=aggregate.value, updated_at=now.isoformat())
            )
        return self.get(run_id)

    def resolve_interrupted(self, run_id: UUID, *, result_code: str) -> PublishRun:
        """Turn a leftover running step into an unconfirmed one before any new action."""
        run = self.get(run_id)
        for step in run.steps:
            if step.state is PublishStepState.RUNNING:
                run = self.transition_step(
                    run_id, step.name, PublishStepState.UNCONFIRMED, result_code=result_code
                )
        return run
