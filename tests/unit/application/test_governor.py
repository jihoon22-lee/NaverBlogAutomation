"""Safety governor: daily caps, allowed hours, pacing, and failure streaks."""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest

from naver_blog_assistant.application.automation.governor import (
    MAX_DWELL_SECONDS,
    GovernorRefusedError,
    SafetyGovernor,
)
from naver_blog_assistant.application.automation.run_session import RunSession
from naver_blog_assistant.domain import (
    AppSettingKind,
    DiscoveredPost,
    DiscoverySource,
    DiscoveryState,
    EngagementRunState,
    EngagementStepName,
    SessionState,
    SessionTrigger,
)

SEOUL_NOON = datetime(2026, 8, 1, 3, 0, tzinfo=UTC)  # 12:00 in Asia/Seoul
SEOUL_MIDNIGHT = datetime(2026, 7, 31, 16, 30, tzinfo=UTC)  # 01:30 in Asia/Seoul
STEPS = (EngagementStepName.LIKE, EngagementStepName.COMMENT)


class _Setting:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload


class _Settings:
    def __init__(self, **overrides: Any) -> None:
        self.payload: dict[str, Any] = {
            "daily_like_cap": 5,
            "daily_comment_cap": 5,
            "daily_neighbor_cap": 2,
            "min_interval_seconds": 60,
            "jitter_ratio": 0.5,
            "allowed_hours": list(range(9, 23)),
            "max_consecutive_failures": 2,
        }
        self.payload.update(overrides)

    def execute(self, kind: AppSettingKind) -> _Setting:
        assert kind is AppSettingKind.SAFETY_POLICY
        return _Setting(self.payload)


class _Ledger:
    def __init__(self, counts: dict[EngagementStepName, int] | None = None) -> None:
        self.data: dict[tuple[date, EngagementStepName], int] = {}
        self.seeded = counts or {}

    def count(self, day: date, action: EngagementStepName) -> int:
        return self.data.get((day, action), self.seeded.get(action, 0))

    def record(self, day: date, action: EngagementStepName, *, amount: int = 1) -> int:
        total = self.count(day, action) + amount
        self.data[(day, action)] = total
        return total


def governor(
    *,
    settings: _Settings | None = None,
    ledger: _Ledger | None = None,
    now: datetime = SEOUL_NOON,
    jitter: Any = None,
) -> tuple[SafetyGovernor, _Ledger]:
    store = ledger or _Ledger()
    return (
        SafetyGovernor(
            read_setting=settings or _Settings(),
            ledger=store,
            clock=lambda: now,
            jitter=jitter or (lambda low, high: (low + high) / 2),
        ),
        store,
    )


class TestPolicy:
    def test_it_reads_the_stored_caps(self) -> None:
        gate, _ = governor(settings=_Settings(daily_like_cap=3))

        policy = gate.policy()

        assert policy.daily_caps[EngagementStepName.LIKE] == 3
        assert policy.min_interval_seconds == 60
        assert policy.allowed_hours[0] == 9

    def test_the_local_date_follows_the_configured_zone(self) -> None:
        gate, _ = governor(now=SEOUL_MIDNIGHT)

        assert gate.today == date(2026, 8, 1)


class TestChecks:
    def test_it_allows_a_post_inside_every_limit(self) -> None:
        gate, _ = governor()

        assert gate.check(STEPS).min_interval_seconds == 60

    def test_it_refuses_outside_the_allowed_hours(self) -> None:
        gate, _ = governor(now=SEOUL_MIDNIGHT)

        with pytest.raises(GovernorRefusedError) as error:
            gate.check(STEPS)
        assert error.value.reason == "outside_allowed_hours"

    def test_it_allows_the_first_and_last_allowed_hour(self) -> None:
        for hour in (9, 22):
            moment = datetime(2026, 8, 1, hour - 9, 0, tzinfo=UTC)
            gate, _ = governor(now=moment)
            gate.check(STEPS)

    def test_it_refuses_when_a_cap_is_already_reached(self) -> None:
        gate, _ = governor(ledger=_Ledger({EngagementStepName.LIKE: 5}))

        with pytest.raises(GovernorRefusedError) as error:
            gate.check(STEPS)
        assert error.value.reason == "daily_cap_reached"

    def test_it_allows_the_post_that_exactly_reaches_the_cap(self) -> None:
        gate, _ = governor(ledger=_Ledger({EngagementStepName.LIKE: 4}))

        gate.check(STEPS)

    def test_it_only_checks_the_approved_steps(self) -> None:
        gate, _ = governor(ledger=_Ledger({EngagementStepName.MUTUAL_NEIGHBOR: 99}))

        gate.check(STEPS)

    def test_it_refuses_after_the_failure_threshold(self) -> None:
        gate, _ = governor()

        gate.record_result(succeeded=False)
        gate.record_result(succeeded=False)

        with pytest.raises(GovernorRefusedError) as error:
            gate.check(STEPS)
        assert error.value.reason == "consecutive_failures"

    def test_a_success_clears_the_streak(self) -> None:
        gate, _ = governor()
        gate.record_result(succeeded=False)

        assert gate.record_result(succeeded=True) == 0
        gate.check(STEPS)

    def test_resetting_forgets_the_streak(self) -> None:
        gate, _ = governor()
        gate.record_result(succeeded=False)
        gate.record_result(succeeded=False)

        gate.reset_failures()

        gate.check(STEPS)

    def test_recorded_actions_count_toward_the_cap(self) -> None:
        gate, ledger = governor()

        gate.record_actions(STEPS)

        assert ledger.count(gate.today, EngagementStepName.LIKE) == 1
        assert ledger.count(gate.today, EngagementStepName.COMMENT) == 1

    def test_an_unknown_reason_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="not a known governor reason"):
            GovernorRefusedError("unknown")


class TestPacing:
    def test_the_interval_includes_jitter_within_the_ratio(self) -> None:
        gate, _ = governor(jitter=lambda low, _high: low)

        assert gate.next_interval_seconds(gate.policy()) == pytest.approx(30.0)

    def test_the_interval_never_goes_negative(self) -> None:
        gate, _ = governor(settings=_Settings(jitter_ratio=1.0), jitter=lambda low, _high: low)

        assert gate.next_interval_seconds(gate.policy()) == 0.0

    def test_a_zero_jitter_ratio_keeps_the_base_interval(self) -> None:
        gate, _ = governor(settings=_Settings(jitter_ratio=0.0))

        assert gate.next_interval_seconds(gate.policy()) == 60.0

    def test_dwell_grows_with_the_body_and_is_bounded(self) -> None:
        gate, _ = governor()

        assert gate.dwell_seconds(0) == 0.0
        assert gate.dwell_seconds(1_000) == pytest.approx(6.0)
        assert gate.dwell_seconds(10_000_000) == MAX_DWELL_SECONDS


class _Sessions:
    def __init__(self) -> None:
        self.sessions: dict[UUID, Any] = {}

    def create(self, **kwargs: Any) -> Any:
        from naver_blog_assistant.domain.sessions import AutomationSession

        session = AutomationSession(
            id=uuid4(),
            trigger=kwargs["trigger"],
            state=SessionState.PENDING,
            approved_steps=tuple(kwargs["approved_steps"]),
            max_posts=kwargs["max_posts"],
            sources=tuple(kwargs["sources"]),
        )
        self.sessions[session.id] = session
        return session

    def get(self, session_id: UUID) -> Any:
        return self.sessions[session_id]

    def transition(self, session_id: UUID, state: Any, *, abort_reason: Any = None) -> Any:
        from dataclasses import replace

        updated = replace(self.sessions[session_id], state=state, abort_reason=abort_reason)
        self.sessions[session_id] = updated
        return updated

    def record_processed(self, session_id: UUID) -> Any:
        from dataclasses import replace

        current = self.sessions[session_id]
        updated = replace(current, processed_count=current.processed_count + 1)
        self.sessions[session_id] = updated
        return updated


def post(index: int) -> DiscoveredPost:
    moment = datetime(2026, 8, 1, 3, 0, tzinfo=UTC)
    return DiscoveredPost(
        id=UUID(f"00000000-0000-4000-8000-{index:012d}"),
        source=DiscoverySource.NEIGHBOR,
        state=DiscoveryState.QUEUED,
        source_url=f"https://blog.naver.com/example/22345678901{index}",
        title=f"합성 글 {index}",
        publisher_name="합성 이웃",
        publisher_blog_id="example",
        published_at=moment,
        neighbor_id=uuid4(),
        search_id=None,
        created_at=moment,
        updated_at=moment,
    )


class _Queue:
    def __init__(self, posts: list[DiscoveredPost]) -> None:
        self.posts = posts

    def list_queue(self, source: DiscoverySource) -> list[DiscoveredPost]:
        return [entry for entry in self.posts if entry.source is source]


class _Runner:
    def __init__(self, state: EngagementRunState = EngagementRunState.SUCCEEDED) -> None:
        self.state = state
        self.seen: list[UUID] = []

    async def run_one(self, post: DiscoveredPost) -> tuple[EngagementRunState, tuple[str, ...]]:
        self.seen.append(post.id)
        return self.state, ("liked", "comment_published")


class TestBatchIntegration:
    def batch(
        self,
        posts: list[DiscoveredPost],
        *,
        gate: SafetyGovernor,
        runner: _Runner | None = None,
    ) -> tuple[RunSession, _Sessions, _Runner, list[float]]:
        store = _Sessions()
        executor = runner or _Runner()
        pauses: list[float] = []

        async def pause(seconds: float) -> None:
            pauses.append(seconds)

        return (
            RunSession(
                sessions=store,
                queue=_Queue(posts),
                runner=executor,
                governor=gate,
                pause=pause,
                keepalive_seconds=0.01,
            ),
            store,
            executor,
            pauses,
        )

    def approve(self, sessions: RunSession, *, max_posts: int = 5) -> Any:
        return sessions.approve(
            trigger=SessionTrigger.SESSION,
            approved_steps=list(STEPS),
            max_posts=max_posts,
            sources=[DiscoverySource.NEIGHBOR],
        )

    def run(self, sessions: RunSession, session_id: UUID) -> Any:
        async def scenario() -> Any:
            async with asyncio.timeout(10):
                return await sessions.run(session_id)

        return asyncio.run(scenario())

    def test_it_paces_between_posts_but_not_before_the_first(self) -> None:
        gate, _ = governor()
        sessions, _, runner, pauses = self.batch([post(1), post(2), post(3)], gate=gate)
        session = self.approve(sessions)

        self.run(sessions, session.id)

        assert len(runner.seen) == 3
        assert len(pauses) == 2
        assert all(value > 0 for value in pauses)

    def test_a_reached_cap_aborts_before_the_first_post(self) -> None:
        gate, _ = governor(ledger=_Ledger({EngagementStepName.LIKE: 5}))
        sessions, store, runner, _ = self.batch([post(1)], gate=gate)
        session = self.approve(sessions)

        outcome = self.run(sessions, session.id)

        assert runner.seen == []
        assert outcome.aborted_reason == "daily_cap_reached"
        assert store.get(session.id).state is SessionState.ABORTED

    def test_a_cap_reached_mid_batch_stops_the_rest(self) -> None:
        gate, _ = governor(settings=_Settings(daily_like_cap=2, daily_comment_cap=2))
        sessions, store, runner, _ = self.batch([post(1), post(2), post(3)], gate=gate)
        session = self.approve(sessions)

        outcome = self.run(sessions, session.id)

        assert len(runner.seen) == 2
        assert outcome.aborted_reason == "daily_cap_reached"
        assert store.get(session.id).abort_reason == "daily_cap_reached"

    def test_outside_allowed_hours_aborts_the_batch(self) -> None:
        gate, _ = governor(now=SEOUL_MIDNIGHT)
        sessions, store, runner, _ = self.batch([post(1)], gate=gate)
        session = self.approve(sessions)

        outcome = self.run(sessions, session.id)

        assert runner.seen == []
        assert outcome.aborted_reason == "outside_allowed_hours"
        assert store.get(session.id).state is SessionState.ABORTED

    def test_consecutive_failures_stop_the_batch(self) -> None:
        gate, _ = governor(settings=_Settings(max_consecutive_failures=2))
        sessions, store, runner, _ = self.batch(
            [post(index) for index in range(1, 6)],
            gate=gate,
            runner=_Runner(EngagementRunState.FAILED),
        )
        session = self.approve(sessions)

        outcome = self.run(sessions, session.id)

        assert len(runner.seen) == 2
        assert outcome.aborted_reason == "consecutive_failures"
        assert store.get(session.id).state is SessionState.ABORTED

    def test_the_ledger_counts_every_executed_action(self) -> None:
        gate, ledger = governor()
        sessions, _, _, _ = self.batch([post(1), post(2)], gate=gate)
        session = self.approve(sessions)

        self.run(sessions, session.id)

        assert ledger.count(gate.today, EngagementStepName.LIKE) == 2
        assert ledger.count(gate.today, EngagementStepName.COMMENT) == 2
