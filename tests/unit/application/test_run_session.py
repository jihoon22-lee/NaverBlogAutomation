"""Session batches: sequential processing, cancellation, and abort conditions."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest

from naver_blog_assistant.application.automation.run_session import RunSession, session_snapshot
from naver_blog_assistant.domain import (
    DiscoveredPost,
    DiscoverySource,
    DiscoveryState,
    DomainValidationError,
    EngagementRunState,
    EngagementStepName,
    SessionState,
    SessionTrigger,
)
from naver_blog_assistant.domain.sessions import (
    MAX_SESSION_POSTS,
    AutomationSession,
    approved_steps_for,
    assert_batch_transition,
)

NOW = datetime(2026, 7, 31, 12, 0, tzinfo=UTC)


def post(index: int) -> DiscoveredPost:
    return DiscoveredPost(
        id=UUID(f"00000000-0000-4000-8000-{index:012d}"),
        source=DiscoverySource.NEIGHBOR,
        state=DiscoveryState.QUEUED,
        source_url=f"https://blog.naver.com/example/22345678901{index}",
        title=f"합성 글 {index}",
        publisher_name="합성 이웃",
        publisher_blog_id="example",
        published_at=NOW,
        neighbor_id=uuid4(),
        search_id=None,
        created_at=NOW,
        updated_at=NOW,
    )


class _Sessions:
    """In-memory session store with the same transition rules."""

    def __init__(self) -> None:
        self.sessions: dict[UUID, AutomationSession] = {}

    def create(self, **kwargs: Any) -> AutomationSession:
        session = AutomationSession(
            id=uuid4(),
            trigger=kwargs["trigger"],
            state=SessionState.PENDING,
            approved_steps=tuple(kwargs["approved_steps"]),
            max_posts=kwargs["max_posts"],
            sources=tuple(kwargs["sources"]),
            created_at=NOW,
        )
        self.sessions[session.id] = session
        return session

    def get(self, session_id: UUID) -> AutomationSession:
        if session_id not in self.sessions:
            raise LookupError(session_id)
        return self.sessions[session_id]

    def transition(
        self, session_id: UUID, state: SessionState, *, abort_reason: str | None = None
    ) -> AutomationSession:
        current = self.get(session_id)
        assert_batch_transition(current.state, state)
        updated = AutomationSession(
            id=current.id,
            trigger=current.trigger,
            state=state,
            approved_steps=current.approved_steps,
            max_posts=current.max_posts,
            sources=current.sources,
            processed_count=current.processed_count,
            created_at=current.created_at,
            abort_reason=abort_reason,
        )
        self.sessions[session_id] = updated
        return updated

    def record_processed(self, session_id: UUID) -> AutomationSession:
        current = self.get(session_id)
        updated = AutomationSession(
            id=current.id,
            trigger=current.trigger,
            state=current.state,
            approved_steps=current.approved_steps,
            max_posts=current.max_posts,
            sources=current.sources,
            processed_count=current.processed_count + 1,
            created_at=current.created_at,
            abort_reason=current.abort_reason,
        )
        self.sessions[session_id] = updated
        return updated


class _Queue:
    def __init__(self, posts: list[DiscoveredPost]) -> None:
        self.posts = posts

    def list_queue(self, source: DiscoverySource) -> list[DiscoveredPost]:
        return [entry for entry in self.posts if entry.source is source]


class _Runner:
    def __init__(self, outcomes: list[tuple[EngagementRunState, tuple[str, ...]]]) -> None:
        self.outcomes = outcomes
        self.seen: list[UUID] = []
        self.on_run: Any = None

    async def run_one(self, post: DiscoveredPost) -> tuple[EngagementRunState, tuple[str, ...]]:
        self.seen.append(post.id)
        if self.on_run is not None:
            self.on_run(post)
        if not self.outcomes:
            return EngagementRunState.SUCCEEDED, ("liked", "comment_published")
        return self.outcomes.pop(0)


def batch(
    posts: list[DiscoveredPost],
    outcomes: list[tuple[EngagementRunState, tuple[str, ...]]] | None = None,
) -> tuple[RunSession, _Sessions, _Runner]:
    store = _Sessions()
    runner = _Runner(outcomes or [])
    return (
        RunSession(sessions=store, queue=_Queue(posts), runner=runner, keepalive_seconds=0.01),
        store,
        runner,
    )


def approve(sessions: RunSession, *, max_posts: int = 5) -> AutomationSession:
    return sessions.approve(
        trigger=SessionTrigger.SESSION,
        approved_steps=[EngagementStepName.LIKE, EngagementStepName.COMMENT],
        max_posts=max_posts,
        sources=[DiscoverySource.NEIGHBOR],
    )


def run(sessions: RunSession, session_id: UUID) -> Any:
    async def scenario() -> Any:
        async with asyncio.timeout(10):
            return await sessions.run(session_id)

    return asyncio.run(scenario())


class TestDomain:
    def test_approved_steps_depend_on_the_source(self) -> None:
        assert approved_steps_for(DiscoverySource.NEIGHBOR) == (
            EngagementStepName.LIKE,
            EngagementStepName.COMMENT,
        )
        assert approved_steps_for(DiscoverySource.SEARCH)[-1] is EngagementStepName.MUTUAL_NEIGHBOR

    @pytest.mark.parametrize(
        ("current", "following"),
        [
            (SessionState.COMPLETED, SessionState.RUNNING),
            (SessionState.CANCELLED, SessionState.RUNNING),
            (SessionState.ABORTED, SessionState.COMPLETED),
            (SessionState.PENDING, SessionState.COMPLETED),
            (SessionState.RUNNING, SessionState.PENDING),
        ],
    )
    def test_a_forbidden_transition_is_rejected(
        self, current: SessionState, following: SessionState
    ) -> None:
        with pytest.raises(DomainValidationError):
            assert_batch_transition(current, following)

    def test_an_allowed_transition_is_accepted(self) -> None:
        assert_batch_transition(SessionState.PENDING, SessionState.RUNNING)
        assert_batch_transition(SessionState.RUNNING, SessionState.COMPLETED)
        assert_batch_transition(SessionState.RUNNING, SessionState.CANCELLED)

    @pytest.mark.parametrize(
        "overrides",
        [
            {"approved_steps": ()},
            {"approved_steps": (EngagementStepName.LIKE, EngagementStepName.LIKE)},
            {"max_posts": 0},
            {"max_posts": MAX_SESSION_POSTS + 1},
            {"sources": ()},
            {"sources": (DiscoverySource.NEIGHBOR, DiscoverySource.NEIGHBOR)},
            {"processed_count": -1},
            {"abort_reason": "unknown_reason"},
        ],
    )
    def test_an_unusable_session_is_rejected(self, overrides: dict[str, Any]) -> None:
        payload: dict[str, Any] = {
            "id": uuid4(),
            "trigger": SessionTrigger.SESSION,
            "state": SessionState.ABORTED,
            "approved_steps": (EngagementStepName.LIKE,),
            "max_posts": 5,
            "sources": (DiscoverySource.NEIGHBOR,),
        }
        payload.update(overrides)

        with pytest.raises(DomainValidationError):
            AutomationSession(**payload)

    def test_an_abort_reason_requires_the_aborted_state(self) -> None:
        with pytest.raises(DomainValidationError, match="abort reason"):
            AutomationSession(
                id=uuid4(),
                trigger=SessionTrigger.SESSION,
                state=SessionState.RUNNING,
                approved_steps=(EngagementStepName.LIKE,),
                max_posts=5,
                sources=(DiscoverySource.NEIGHBOR,),
                abort_reason="captcha_required",
            )

    def test_remaining_never_goes_negative(self) -> None:
        session = AutomationSession(
            id=uuid4(),
            trigger=SessionTrigger.SESSION,
            state=SessionState.RUNNING,
            approved_steps=(EngagementStepName.LIKE,),
            max_posts=2,
            sources=(DiscoverySource.NEIGHBOR,),
            processed_count=5,
        )

        assert session.remaining == 0


class TestBatch:
    def test_it_processes_every_queued_post_in_order(self) -> None:
        posts = [post(index) for index in range(1, 4)]
        sessions, store, runner = batch(posts)
        session = approve(sessions)

        outcome = run(sessions, session.id)

        assert runner.seen == [entry.id for entry in posts]
        assert outcome.processed == 3
        assert store.get(session.id).state is SessionState.COMPLETED

    def test_it_stops_at_the_approved_count(self) -> None:
        sessions, store, runner = batch([post(index) for index in range(1, 6)])
        session = approve(sessions, max_posts=2)

        run(sessions, session.id)

        assert len(runner.seen) == 2
        assert store.get(session.id).processed_count == 2

    def test_cancelling_stops_before_the_next_post(self) -> None:
        posts = [post(index) for index in range(1, 4)]
        sessions, store, runner = batch(posts)
        session = approve(sessions)
        runner.on_run = lambda _post: sessions.cancel(session.id)

        outcome = run(sessions, session.id)

        assert len(runner.seen) == 1
        assert store.get(session.id).state is SessionState.CANCELLED
        assert outcome.aborted_reason is None

    def test_cancelling_a_pending_session_never_runs_it(self) -> None:
        sessions, store, runner = batch([post(1)])
        session = approve(sessions)

        sessions.cancel(session.id)
        run(sessions, session.id)

        assert runner.seen == []
        assert store.get(session.id).state is SessionState.CANCELLED

    def test_cancelling_a_finished_session_is_a_no_op(self) -> None:
        sessions, store, _ = batch([post(1)])
        session = approve(sessions)
        run(sessions, session.id)

        cancelled = sessions.cancel(session.id)

        assert cancelled.state is SessionState.COMPLETED
        assert store.get(session.id).state is SessionState.COMPLETED

    @pytest.mark.parametrize("code", ["captcha_required", "login_required"])
    def test_a_blocking_result_aborts_the_batch(self, code: str) -> None:
        posts = [post(1), post(2)]
        sessions, store, runner = batch(posts, [(EngagementRunState.FAILED, (code,))])
        session = approve(sessions)

        outcome = run(sessions, session.id)

        assert len(runner.seen) == 1
        assert outcome.aborted_reason == code
        assert store.get(session.id).state is SessionState.ABORTED
        assert store.get(session.id).abort_reason == code

    def test_a_normal_failure_does_not_stop_the_batch(self) -> None:
        posts = [post(1), post(2)]
        sessions, store, runner = batch(posts, [(EngagementRunState.FAILED, ("not_found",))])
        session = approve(sessions)

        run(sessions, session.id)

        assert len(runner.seen) == 2
        assert store.get(session.id).state is SessionState.COMPLETED

    def test_an_empty_queue_completes_immediately(self) -> None:
        sessions, store, runner = batch([])
        session = approve(sessions)

        outcome = run(sessions, session.id)

        assert runner.seen == []
        assert outcome.processed == 0
        assert store.get(session.id).state is SessionState.COMPLETED

    def test_an_unexpected_error_aborts_with_a_stable_reason(self) -> None:
        sessions, store, runner = batch([post(1)])
        session = approve(sessions)

        def explode(_post: DiscoveredPost) -> None:
            raise RuntimeError("boom")

        runner.on_run = explode
        outcome = run(sessions, session.id)

        assert outcome.aborted_reason == "internal_error"
        assert store.get(session.id).state is SessionState.ABORTED

    def test_it_streams_one_event_per_post(self) -> None:
        posts = [post(1), post(2)]
        sessions, _, _ = batch(posts)
        session = approve(sessions)

        async def scenario() -> list[str]:
            async with asyncio.timeout(10):
                await sessions.run(session.id)
                return [event.event async for event in sessions.events(session.id)]

        events = asyncio.run(scenario())

        assert events[0] == "session_started"
        assert events.count("post_completed") == 2
        assert events[-1] == "session_completed"

    def test_an_unknown_session_yields_no_events(self) -> None:
        sessions, _, _ = batch([])

        async def scenario() -> list[str]:
            async with asyncio.timeout(5):
                return [event.event async for event in sessions.events(uuid4())]

        assert asyncio.run(scenario()) == []

    def test_a_session_without_a_channel_yields_one_snapshot(self) -> None:
        sessions, store, _ = batch([])
        session = approve(sessions)

        async def scenario() -> list[Any]:
            async with asyncio.timeout(5):
                return [event async for event in sessions.events(session.id)]

        events = asyncio.run(scenario())

        assert [event.event for event in events] == ["session_snapshot"]
        assert events[0].payload == session_snapshot(store.get(session.id))

    def test_shutdown_closes_every_open_channel(self) -> None:
        sessions, _, _ = batch([])
        session = approve(sessions)
        channel = sessions.open_channel(session.id)

        asyncio.run(sessions.shutdown())

        assert channel.finished is True

    def test_it_rejects_unusable_stream_settings(self) -> None:
        store = _Sessions()
        with pytest.raises(ValueError, match="positive"):
            RunSession(
                sessions=store,
                queue=_Queue([]),
                runner=_Runner([]),
                keepalive_seconds=0,
            )
