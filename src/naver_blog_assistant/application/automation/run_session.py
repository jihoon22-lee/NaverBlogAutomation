"""Process a queue of approved posts one at a time.

One approval covers several posts. The batch stops the moment the user cancels or a blocking
condition appears and never touches a post beyond the approved count. Nothing resumes on its own:
a cancelled or aborted session needs a new approval.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from naver_blog_assistant.application.automation.governor import (
    GovernorRefusedError,
    SafetyGovernor,
)
from naver_blog_assistant.application.automation.run_engagement import RunChannel, RunEvent
from naver_blog_assistant.domain.discovery import DiscoveredPost, DiscoverySource
from naver_blog_assistant.domain.engagement import EngagementRunState
from naver_blog_assistant.domain.sessions import (
    AutomationSession,
    SessionState,
    SessionTrigger,
)

logger = logging.getLogger("naver_blog_assistant.api")
KEEPALIVE_SECONDS = 15.0
STREAM_DEADLINE_SECONDS = 3_600.0
RETAINED_CHANNELS = 4
BLOCKING_RESULT_CODES = frozenset({"captcha_required", "login_required"})


class SessionStore(Protocol):
    """The subset of the session repository this orchestrator needs."""

    def create(
        self,
        *,
        trigger: SessionTrigger,
        approved_steps: Sequence[Any],
        max_posts: int,
        sources: Sequence[DiscoverySource],
    ) -> AutomationSession: ...

    def get(self, session_id: UUID) -> AutomationSession: ...

    def transition(
        self, session_id: UUID, state: SessionState, *, abort_reason: str | None = None
    ) -> AutomationSession: ...

    def record_processed(self, session_id: UUID) -> AutomationSession: ...


class QueueReader(Protocol):
    """Read the queued posts one session may process."""

    def list_queue(self, source: DiscoverySource) -> list[DiscoveredPost]: ...


class PostRunner(Protocol):
    """Run one approved post and report its terminal state."""

    async def run_one(self, post: DiscoveredPost) -> tuple[EngagementRunState, tuple[str, ...]]: ...


@dataclass(frozen=True, slots=True)
class SessionOutcome:
    """What one session did."""

    session: AutomationSession
    processed: int
    aborted_reason: str | None


class RunSession:
    """Approve once, then process the queue in order until something stops it."""

    def __init__(
        self,
        *,
        sessions: SessionStore,
        queue: QueueReader,
        runner: PostRunner,
        governor: SafetyGovernor | None = None,
        pause: Callable[[float], Any] | None = None,
        keepalive_seconds: float = KEEPALIVE_SECONDS,
        stream_deadline_seconds: float = STREAM_DEADLINE_SECONDS,
        retained_channels: int = RETAINED_CHANNELS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if keepalive_seconds <= 0 or stream_deadline_seconds <= 0 or retained_channels < 1:
            raise ValueError("stream timing and retention settings must be positive")
        self._sessions = sessions
        self._queue = queue
        self._runner = runner
        self._governor = governor
        self._pause = pause
        self._keepalive_seconds = keepalive_seconds
        self._stream_deadline_seconds = stream_deadline_seconds
        self._retained_channels = retained_channels
        self._monotonic = monotonic
        self._channels: dict[UUID, RunChannel] = {}
        self._retired: list[UUID] = []
        self._cancelled: set[UUID] = set()
        self._tasks: set[asyncio.Task[None]] = set()

    def approve(
        self,
        *,
        trigger: SessionTrigger,
        approved_steps: Sequence[Any],
        max_posts: int,
        sources: Sequence[DiscoverySource],
    ) -> AutomationSession:
        """Persist one pending session for this approval."""
        return self._sessions.create(
            trigger=trigger,
            approved_steps=approved_steps,
            max_posts=max_posts,
            sources=sources,
        )

    def cancel(self, session_id: UUID) -> AutomationSession:
        """Ask a running session to stop before the next post."""
        session = self._sessions.get(session_id)
        if session.finished:
            return session
        self._cancelled.add(session_id)
        if session.state is SessionState.PENDING:
            return self._sessions.transition(session_id, SessionState.CANCELLED)
        return session

    def open_channel(self, session_id: UUID) -> RunChannel:
        """Return a live channel for one session, replacing a finished one."""
        channel = self._channels.get(session_id)
        if channel is not None and not channel.finished:
            return channel
        if channel is not None:
            self._forget(session_id)
        fresh = RunChannel()
        self._channels[session_id] = fresh
        return fresh

    def live_channel(self, session_id: UUID) -> RunChannel | None:
        """Return the retained channel for one session without creating it."""
        return self._channels.get(session_id)

    async def events(self, session_id: UUID) -> AsyncGenerator[RunEvent]:
        """Yield events for one session, always terminating."""
        try:
            session = self._sessions.get(session_id)
        except LookupError:
            return
        channel = self._channels.get(session_id)
        if channel is None:
            yield RunEvent("session_snapshot", session_snapshot(session))
            return
        queue = channel.subscribe()
        deadline = self._monotonic() + self._stream_deadline_seconds
        try:
            while True:
                if self._monotonic() >= deadline:
                    yield RunEvent("stream_deadline", {"session_id": str(session_id)})
                    return
                try:
                    async with asyncio.timeout(self._keepalive_seconds):
                        event = await queue.get()
                except TimeoutError:
                    yield RunEvent("keepalive", {"session_id": str(session_id)})
                    continue
                if event is None:
                    return
                yield event
        finally:
            channel.unsubscribe(queue)

    async def run(self, session_id: UUID) -> SessionOutcome:
        """Process the queue for one session until it finishes or stops."""
        channel = self.open_channel(session_id)
        session = self._sessions.get(session_id)
        abort_reason: str | None = None
        try:
            if session.finished:
                channel.publish(RunEvent("session_cancelled", session_snapshot(session)))
                return SessionOutcome(
                    session=session, processed=session.processed_count, aborted_reason=None
                )
            if session_id in self._cancelled:
                session = self._sessions.transition(session_id, SessionState.CANCELLED)
                channel.publish(RunEvent("session_cancelled", session_snapshot(session)))
                return SessionOutcome(session=session, processed=0, aborted_reason=None)
            session = self._sessions.transition(session_id, SessionState.RUNNING)
            channel.publish(RunEvent("session_started", session_snapshot(session)))
            if self._governor is not None:
                self._governor.reset_failures()
            first = True
            for post in self._posts(session):
                if session_id in self._cancelled:
                    session = self._sessions.transition(session_id, SessionState.CANCELLED)
                    channel.publish(RunEvent("session_cancelled", session_snapshot(session)))
                    return SessionOutcome(
                        session=session,
                        processed=session.processed_count,
                        aborted_reason=None,
                    )
                try:
                    policy = (
                        None
                        if self._governor is None
                        else self._governor.check(session.approved_steps)
                    )
                except GovernorRefusedError as refusal:
                    abort_reason = refusal.reason
                    break
                if not first and policy is not None and self._governor is not None:
                    await self._sleep(self._governor.next_interval_seconds(policy))
                first = False
                state, codes = await self._runner.run_one(post)
                if self._governor is not None:
                    self._governor.record_actions(session.approved_steps)
                    self._governor.record_result(succeeded=state is EngagementRunState.SUCCEEDED)
                session = self._sessions.record_processed(session_id)
                channel.publish(
                    RunEvent(
                        "post_completed",
                        {
                            "session_id": str(session_id),
                            "post_id": str(post.id),
                            "state": state.value,
                            "result_codes": list(codes),
                        },
                    )
                )
                blocking = next((code for code in codes if code in BLOCKING_RESULT_CODES), None)
                if blocking is not None:
                    abort_reason = blocking
                    break
            if abort_reason is not None:
                session = self._sessions.transition(
                    session_id, SessionState.ABORTED, abort_reason=abort_reason
                )
                channel.publish(RunEvent("session_aborted", session_snapshot(session)))
            else:
                session = self._sessions.transition(session_id, SessionState.COMPLETED)
                channel.publish(RunEvent("session_completed", session_snapshot(session)))
            return SessionOutcome(
                session=session,
                processed=session.processed_count,
                aborted_reason=abort_reason,
            )
        except Exception:  # noqa: BLE001 - the stream must always close
            logger.exception("session_run_failed")
            session = self._sessions.transition(
                session_id, SessionState.ABORTED, abort_reason="internal_error"
            )
            channel.publish(RunEvent("session_aborted", session_snapshot(session)))
            return SessionOutcome(
                session=session, processed=session.processed_count, aborted_reason="internal_error"
            )
        finally:
            self._cancelled.discard(session_id)
            channel.close()
            self._retire(session_id)

    def start_background(self, session_id: UUID) -> None:
        """Run one session without blocking the request that approved it."""
        self.open_channel(session_id)
        task = asyncio.create_task(self._background(session_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _background(self, session_id: UUID) -> None:
        await self.run(session_id)

    async def _sleep(self, seconds: float) -> None:
        """Pause between posts, using the injected sleeper in tests."""
        if seconds <= 0:
            return
        if self._pause is not None:
            await self._pause(seconds)
            return
        await asyncio.sleep(seconds)

    def _posts(self, session: AutomationSession) -> list[DiscoveredPost]:
        collected: list[DiscoveredPost] = []
        for source in session.sources:
            collected.extend(self._queue.list_queue(source))
        return collected[: session.remaining]

    def _retire(self, session_id: UUID) -> None:
        if session_id in self._retired:
            self._retired.remove(session_id)
        self._retired.append(session_id)
        while len(self._retired) > self._retained_channels:
            self._forget(self._retired[0])

    def _forget(self, session_id: UUID) -> None:
        self._channels.pop(session_id, None)
        if session_id in self._retired:
            self._retired.remove(session_id)

    async def shutdown(self) -> None:
        """Wait for in-flight sessions and release every open stream."""
        if self._tasks:
            await asyncio.gather(*tuple(self._tasks), return_exceptions=True)
        for channel in tuple(self._channels.values()):
            channel.close()


def session_snapshot(session: AutomationSession) -> dict[str, Any]:
    """Return one session as a streamable payload."""
    return {
        "session_id": str(session.id),
        "state": session.state.value,
        "trigger": session.trigger.value,
        "processed_count": session.processed_count,
        "max_posts": session.max_posts,
        "abort_reason": session.abort_reason,
    }
