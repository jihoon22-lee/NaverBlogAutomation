"""Unattended schedule: activation gates, due window, and duplicate prevention."""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest

from naver_blog_assistant.application.automation.schedule_sessions import ScheduleSessions
from naver_blog_assistant.domain import (
    AppSettingKind,
    BrowserLoginState,
    BrowserSessionState,
    BrowserSessionStatus,
    SessionTrigger,
)

# 10:00 in Asia/Seoul
DUE = datetime(2026, 8, 1, 1, 0, tzinfo=UTC)
LATER = datetime(2026, 8, 1, 5, 0, tzinfo=UTC)


class _Setting:
    def __init__(self, payload: dict[str, Any], updated_at: datetime | None) -> None:
        self.payload = payload
        self.updated_at = updated_at


class _Settings:
    def __init__(
        self,
        *,
        mode: str = "schedule",
        accepted: bool = True,
        safety_saved: bool = True,
        hour: int = 10,
        minute: int = 0,
        max_posts: int = 3,
    ) -> None:
        self.schedule = {"mode": mode, "hour": hour, "minute": minute, "max_posts": max_posts}
        self.consent = {"accepted": accepted, "consent_version": 1}
        self.safety_saved = safety_saved

    def execute(self, kind: AppSettingKind) -> _Setting:
        if kind is AppSettingKind.SCHEDULE_POLICY:
            return _Setting(self.schedule, datetime(2026, 8, 1, tzinfo=UTC))
        if kind is AppSettingKind.AUTOMATION_CONSENT:
            return _Setting(self.consent, datetime(2026, 8, 1, tzinfo=UTC))
        if kind is AppSettingKind.SAFETY_POLICY:
            return _Setting({}, datetime(2026, 8, 1, tzinfo=UTC) if self.safety_saved else None)
        raise AssertionError(kind)


class _Store:
    def __init__(self, *, ran_today: bool = False, active: bool = False) -> None:
        self.ran_today = ran_today
        self.has_active = active

    def active(self) -> Any:
        return object() if self.has_active else None

    def created_on(self, day: date, trigger: SessionTrigger) -> bool:
        assert trigger is SessionTrigger.SCHEDULE
        assert day == date(2026, 8, 1)
        return self.ran_today


class _Starter:
    def __init__(self) -> None:
        self.approvals: list[dict[str, Any]] = []
        self.started: list[UUID] = []

    def approve(self, **kwargs: Any) -> Any:
        self.approvals.append(kwargs)
        return type("Session", (), {"id": uuid4()})()

    def start_background(self, session_id: UUID) -> None:
        self.started.append(session_id)


class _Browser:
    def __init__(
        self, *, state: BrowserSessionState, launch_state: BrowserSessionState | None = None
    ) -> None:
        self.state = state
        self.launch_state = launch_state or state
        self.launches = 0
        self.launch_error: Exception | None = None

    def status(self) -> BrowserSessionStatus:
        return BrowserSessionStatus(
            state=self.state,
            login=(
                BrowserLoginState.AUTHENTICATED
                if self.state is BrowserSessionState.READY
                else BrowserLoginState.UNKNOWN
            ),
            driver="fake",
            headless=True,
            profile_dir="/tmp/profile",
            open_pages=1 if self.state is BrowserSessionState.READY else 0,
        )

    async def launch(self) -> BrowserSessionStatus:
        self.launches += 1
        if self.launch_error is not None:
            raise self.launch_error
        self.state = self.launch_state
        return self.status()


def schedule(
    *,
    settings: _Settings | None = None,
    store: _Store | None = None,
    browser: _Browser | None = None,
    now: datetime = DUE,
    notices: list[str] | None = None,
) -> tuple[ScheduleSessions, _Starter, _Browser, list[str]]:
    starter = _Starter()
    session_browser = browser or _Browser(state=BrowserSessionState.READY)
    collected = notices if notices is not None else []

    async def notify(reason: str) -> None:
        collected.append(reason)

    return (
        ScheduleSessions(
            read_setting=settings or _Settings(),
            store=store or _Store(),
            sessions=starter,
            browser=session_browser,
            clock=lambda: now,
            notify=notify,
        ),
        starter,
        session_browser,
        collected,
    )


def run(scheduler: ScheduleSessions) -> Any:
    async def scenario() -> Any:
        async with asyncio.timeout(10):
            return await scheduler.run_if_due()

    return asyncio.run(scenario())


class TestActivation:
    def test_it_is_enabled_when_every_gate_passes(self) -> None:
        scheduler, _, _, _ = schedule()

        assert scheduler.enabled() is True

    @pytest.mark.parametrize(
        ("settings", "reason"),
        [
            (_Settings(mode="manual"), "not_scheduled"),
            (_Settings(accepted=False), "consent_missing"),
            (_Settings(safety_saved=False), "safety_policy_missing"),
        ],
    )
    def test_a_missing_gate_blocks_it(self, settings: _Settings, reason: str) -> None:
        scheduler, starter, _, _ = schedule(settings=settings)

        decision = run(scheduler)

        assert scheduler.enabled() is False
        assert decision.started is False
        assert decision.reason == reason
        assert starter.approvals == []


class TestDueWindow:
    def test_it_starts_inside_the_five_minute_window(self) -> None:
        for minute in (0, 4):
            moment = datetime(2026, 8, 1, 1, minute, tzinfo=UTC)
            scheduler, starter, _, _ = schedule(now=moment)

            assert run(scheduler).started is True
            assert starter.approvals[0]["max_posts"] == 3

    def test_it_skips_outside_the_window(self) -> None:
        for moment in (datetime(2026, 8, 1, 1, 5, tzinfo=UTC), LATER):
            scheduler, starter, _, _ = schedule(now=moment)

            decision = run(scheduler)

            assert decision.started is False
            assert decision.reason == "not_due"
            assert starter.approvals == []

    def test_the_window_follows_the_local_timezone(self) -> None:
        scheduler, _, _, _ = schedule(settings=_Settings(hour=1), now=DUE)

        assert run(scheduler).reason == "not_due"


class TestGuards:
    def test_it_runs_once_per_local_day(self) -> None:
        scheduler, starter, _, _ = schedule(store=_Store(ran_today=True))

        decision = run(scheduler)

        assert decision.reason == "already_ran_today"
        assert starter.approvals == []

    def test_an_active_session_blocks_the_schedule(self) -> None:
        scheduler, starter, _, _ = schedule(store=_Store(active=True))

        decision = run(scheduler)

        assert decision.reason == "session_active"
        assert starter.approvals == []

    def test_it_launches_a_stopped_browser(self) -> None:
        browser = _Browser(
            state=BrowserSessionState.STOPPED, launch_state=BrowserSessionState.READY
        )
        scheduler, starter, session_browser, _ = schedule(browser=browser)

        assert run(scheduler).started is True
        assert session_browser.launches == 1
        assert len(starter.approvals) == 1

    def test_a_browser_that_will_not_start_stops_the_schedule(self) -> None:
        browser = _Browser(
            state=BrowserSessionState.STOPPED, launch_state=BrowserSessionState.STOPPED
        )
        scheduler, starter, _, notices = schedule(browser=browser)

        decision = run(scheduler)

        assert decision.reason == "browser_unavailable"
        assert starter.approvals == []
        assert notices == ["browser_unavailable"]

    def test_a_launch_error_does_not_crash_the_loop(self) -> None:
        browser = _Browser(state=BrowserSessionState.STOPPED)
        browser.launch_error = RuntimeError("boom")
        scheduler, starter, _, notices = schedule(browser=browser)

        decision = run(scheduler)

        assert decision.reason == "browser_unavailable"
        assert starter.approvals == []
        assert notices == ["browser_unavailable"]

    def test_a_failing_notification_does_not_change_the_decision(self) -> None:
        browser = _Browser(
            state=BrowserSessionState.STOPPED, launch_state=BrowserSessionState.STOPPED
        )
        starter = _Starter()

        async def notify(_reason: str) -> None:
            raise RuntimeError("smtp down")

        scheduler = ScheduleSessions(
            read_setting=_Settings(),
            store=_Store(),
            sessions=starter,
            browser=browser,
            clock=lambda: DUE,
            notify=notify,
        )

        async def scenario() -> Any:
            async with asyncio.timeout(10):
                return await scheduler.run_if_due()

        decision = asyncio.run(scenario())

        assert decision.reason == "browser_unavailable"

    def test_it_approves_the_documented_steps_and_source(self) -> None:
        scheduler, starter, _, _ = schedule()

        run(scheduler)

        approval = starter.approvals[0]
        assert approval["trigger"] is SessionTrigger.SCHEDULE
        assert [step.value for step in approval["approved_steps"]] == ["like", "comment"]
        assert [source.value for source in approval["sources"]] == ["neighbor"]

    def test_it_starts_the_session_in_the_background(self) -> None:
        scheduler, starter, _, _ = schedule()

        decision = run(scheduler)

        assert starter.started == [decision.session_id]
