"""SQLite persistence for approved session batches.

Only one session may be active at a time: starting a second one while another is pending or running
is refused so two batches cannot drive the same browser.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select, update
from sqlalchemy.engine import Engine

from naver_blog_assistant.domain.discovery import DiscoverySource
from naver_blog_assistant.domain.engagement import EngagementStepName
from naver_blog_assistant.domain.sessions import (
    AutomationSession,
    SessionState,
    SessionTrigger,
    assert_batch_transition,
)
from naver_blog_assistant.infrastructure.database.schema import (
    automation_session_posts,
    automation_sessions,
)


class SessionNotFoundError(LookupError):
    """Raised when a session id does not exist."""

    def __init__(self, session_id: UUID) -> None:
        super().__init__(f"session {session_id} was not found")
        self.session_id = session_id


class SessionAlreadyRunningError(RuntimeError):
    """Raised when another session is still pending or running."""

    def __init__(self, session_id: UUID) -> None:
        super().__init__(f"session {session_id} is still active")
        self.session_id = session_id


class SqliteSessionRepository:
    """Create one active session at a time and record its progress."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def create(
        self,
        *,
        trigger: SessionTrigger,
        approved_steps: Sequence[EngagementStepName],
        max_posts: int,
        sources: Sequence[DiscoverySource],
        post_ids: Sequence[UUID] = (),
    ) -> AutomationSession:
        """Insert one pending session, refusing a second active one."""
        active = self.active()
        if active is not None:
            raise SessionAlreadyRunningError(active.id)
        session = AutomationSession(
            id=uuid4(),
            trigger=trigger,
            state=SessionState.PENDING,
            approved_steps=tuple(approved_steps),
            max_posts=max_posts,
            sources=tuple(sources),
            post_ids=tuple(post_ids),
        )
        now = datetime.now(UTC)
        with self._engine.begin() as connection:
            connection.execute(
                automation_sessions.insert().values(
                    id=str(session.id),
                    trigger=session.trigger.value,
                    state=session.state.value,
                    approved_steps_json=json.dumps(
                        [step.value for step in session.approved_steps], sort_keys=True
                    ),
                    max_posts=session.max_posts,
                    source_filter_json=json.dumps(
                        [source.value for source in session.sources], sort_keys=True
                    ),
                    processed_count=0,
                    created_at=now.isoformat(),
                    started_at=None,
                    finished_at=None,
                    abort_reason=None,
                )
            )
            if session.post_ids:
                connection.execute(
                    automation_session_posts.insert(),
                    [
                        {
                            "session_id": str(session.id),
                            "post_id": str(post_id),
                            "position": position,
                            "created_at": now.isoformat(),
                        }
                        for position, post_id in enumerate(session.post_ids)
                    ],
                )
        return self.get(session.id)

    def get(self, session_id: UUID) -> AutomationSession:
        """Return one session."""
        with self._engine.connect() as connection:
            row = connection.execute(
                select(automation_sessions).where(automation_sessions.c.id == str(session_id))
            ).one_or_none()
        if row is None:
            raise SessionNotFoundError(session_id)
        return _session(row, post_ids=self.post_ids(session_id))

    def post_ids(self, session_id: UUID) -> tuple[UUID, ...]:
        """Return the approval-time post snapshot in its immutable execution order."""
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(automation_session_posts.c.post_id)
                .where(automation_session_posts.c.session_id == str(session_id))
                .order_by(automation_session_posts.c.position)
            ).scalars()
            return tuple(UUID(value) for value in rows)

    def active(self) -> AutomationSession | None:
        """Return the session that is still pending or running, if any."""
        with self._engine.connect() as connection:
            row = connection.execute(
                select(automation_sessions)
                .where(
                    automation_sessions.c.state.in_(
                        [SessionState.PENDING.value, SessionState.RUNNING.value]
                    )
                )
                .order_by(automation_sessions.c.created_at)
            ).first()
        return None if row is None else _session(row, post_ids=self.post_ids(UUID(row.id)))

    def recent(self, *, limit: int = 20) -> tuple[AutomationSession, ...]:
        """Return the newest sessions, newest first."""
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(automation_sessions)
                .order_by(automation_sessions.c.created_at.desc())
                .limit(max(1, limit))
            ).all()
        return tuple(_session(row, post_ids=self.post_ids(UUID(row.id))) for row in rows)

    def abort_active_for_restart(self) -> AutomationSession | None:
        """Fail closed when a prior process stopped before a batch reached a terminal state."""
        active = self.active()
        if active is None:
            return None
        return self.transition(
            active.id,
            SessionState.ABORTED,
            abort_reason="process_restarted",
        )

    def created_on(self, day: date, trigger: SessionTrigger) -> bool:
        """Report whether a session with this trigger was already created on ``day``."""
        prefix = f"{day.isoformat()}%"
        with self._engine.connect() as connection:
            row = connection.execute(
                select(automation_sessions.c.id).where(
                    automation_sessions.c.trigger == trigger.value,
                    automation_sessions.c.created_at.like(prefix),
                )
            ).first()
        return row is not None

    def transition(
        self,
        session_id: UUID,
        state: SessionState,
        *,
        abort_reason: str | None = None,
    ) -> AutomationSession:
        """Move one session forward, refusing a backward or repeated transition."""
        session = self.get(session_id)
        assert_batch_transition(session.state, state)
        now = datetime.now(UTC)
        values: dict[str, object] = {"state": state.value}
        if state is SessionState.RUNNING:
            values["started_at"] = now.isoformat()
        if state in {SessionState.COMPLETED, SessionState.ABORTED, SessionState.CANCELLED}:
            values["finished_at"] = now.isoformat()
        if abort_reason is not None:
            values["abort_reason"] = abort_reason
        with self._engine.begin() as connection:
            connection.execute(
                update(automation_sessions)
                .where(automation_sessions.c.id == str(session_id))
                .values(**values)
            )
        return self.get(session_id)

    def record_processed(self, session_id: UUID) -> AutomationSession:
        """Count one processed post for the session."""
        session = self.get(session_id)
        with self._engine.begin() as connection:
            connection.execute(
                update(automation_sessions)
                .where(automation_sessions.c.id == str(session_id))
                .values(processed_count=session.processed_count + 1)
            )
        return self.get(session_id)


def _session(row: Any, *, post_ids: tuple[UUID, ...]) -> AutomationSession:
    steps = json.loads(row.approved_steps_json)
    sources = json.loads(row.source_filter_json)
    return AutomationSession(
        id=UUID(row.id),
        trigger=SessionTrigger(row.trigger),
        state=SessionState(row.state),
        approved_steps=tuple(EngagementStepName(step) for step in steps),
        max_posts=int(row.max_posts),
        sources=tuple(DiscoverySource(source) for source in sources),
        post_ids=post_ids,
        processed_count=int(row.processed_count),
        created_at=_moment(row.created_at),
        started_at=_moment(row.started_at),
        finished_at=_moment(row.finished_at),
        abort_reason=row.abort_reason,
    )


def _moment(value: str | None) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value)
