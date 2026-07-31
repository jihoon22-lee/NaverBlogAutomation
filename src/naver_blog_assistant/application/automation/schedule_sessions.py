"""Start one approved session on a schedule, without a person present.

Unattended mode is opt-in and gated twice: the automation consent must be accepted and the safety
policy must be saved explicitly. Without both, the schedule refuses to run rather than fall back to
defaults nobody chose. At most one scheduled session starts per local day.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Protocol
from uuid import UUID
from zoneinfo import ZoneInfo

from naver_blog_assistant.domain import (
    AppSettingKind,
    BrowserSessionState,
    DiscoverySource,
    SessionTrigger,
    approved_steps_for,
)

logger = logging.getLogger("naver_blog_assistant.api")
DEFAULT_TIMEZONE = "Asia/Seoul"

SKIP_REASONS = (
    "not_scheduled",
    "not_due",
    "already_ran_today",
    "consent_missing",
    "safety_policy_missing",
    "session_active",
    "browser_unavailable",
)


class SettingReader(Protocol):
    """Read one settings record, reporting whether it was ever saved."""

    def execute(self, kind: AppSettingKind) -> Any: ...


class SessionStore(Protocol):
    """The subset of the session repository the schedule needs."""

    def active(self) -> Any: ...

    def created_on(self, day: date, trigger: SessionTrigger) -> bool: ...


class BrowserSession(Protocol):
    """Launch and report the automation browser."""

    def status(self) -> Any: ...

    async def launch(self) -> Any: ...


class SessionStarter(Protocol):
    """Approve and run one session batch."""

    def approve(
        self,
        *,
        trigger: SessionTrigger,
        approved_steps: Sequence[Any],
        max_posts: int,
        sources: Sequence[DiscoverySource],
    ) -> Any: ...

    def start_background(self, session_id: UUID) -> None: ...


@dataclass(frozen=True, slots=True)
class ScheduleDecision:
    """Why the schedule did or did not start a session."""

    started: bool
    reason: str | None = None
    session_id: Any = None


class ScheduleSessions:
    """Decide whether the unattended schedule should start a session now."""

    def __init__(
        self,
        *,
        read_setting: SettingReader,
        store: SessionStore,
        sessions: SessionStarter,
        browser: BrowserSession,
        clock: Callable[[], datetime] | None = None,
        notify: Callable[[str], Awaitable[None]] | None = None,
        timezone: str = DEFAULT_TIMEZONE,
    ) -> None:
        self._read_setting = read_setting
        self._store = store
        self._sessions = sessions
        self._browser = browser
        self._clock = clock or (lambda: datetime.now(UTC))
        self._notify = notify
        self._zone = ZoneInfo(timezone)

    def enabled(self) -> bool:
        """Report whether unattended mode is configured and consented to."""
        policy = self._read_setting.execute(AppSettingKind.SCHEDULE_POLICY)
        if policy.payload.get("mode") != "schedule":
            return False
        consent = self._read_setting.execute(AppSettingKind.AUTOMATION_CONSENT)
        if consent.payload.get("accepted") is not True:
            return False
        return self._read_setting.execute(AppSettingKind.SAFETY_POLICY).updated_at is not None

    async def run_if_due(self) -> ScheduleDecision:
        """Start one scheduled session when every gate allows it."""
        reason = self._blocking_reason()
        if reason is not None:
            return ScheduleDecision(started=False, reason=reason)
        if not await self._ensure_browser():
            await self._announce("browser_unavailable")
            return ScheduleDecision(started=False, reason="browser_unavailable")
        policy = self._read_setting.execute(AppSettingKind.SCHEDULE_POLICY).payload
        sources = (DiscoverySource.NEIGHBOR,)
        session = self._sessions.approve(
            trigger=SessionTrigger.SCHEDULE,
            approved_steps=list(approved_steps_for(DiscoverySource.NEIGHBOR)),
            max_posts=int(policy["max_posts"]),
            sources=list(sources),
        )
        self._sessions.start_background(session.id)
        logger.info("schedule_session_started session=%s", session.id)
        return ScheduleDecision(started=True, session_id=session.id)

    def _blocking_reason(self) -> str | None:
        policy = self._read_setting.execute(AppSettingKind.SCHEDULE_POLICY)
        if policy.payload.get("mode") != "schedule":
            return "not_scheduled"
        if (
            self._read_setting.execute(AppSettingKind.AUTOMATION_CONSENT).payload.get("accepted")
            is not True
        ):
            return "consent_missing"
        if self._read_setting.execute(AppSettingKind.SAFETY_POLICY).updated_at is None:
            return "safety_policy_missing"
        local = self._clock().astimezone(self._zone)
        if not self._due(local, policy.payload):
            return "not_due"
        if self._store.created_on(local.date(), SessionTrigger.SCHEDULE):
            return "already_ran_today"
        if self._store.active() is not None:
            return "session_active"
        return None

    def _due(self, local: datetime, policy: dict[str, Any]) -> bool:
        hour = int(policy["hour"])
        minute = int(policy["minute"])
        if local.hour != hour:
            return False
        return minute <= local.minute < minute + 5

    async def _ensure_browser(self) -> bool:
        status = self._browser.status()
        if status.state is BrowserSessionState.READY:
            return True
        try:
            launched = await self._browser.launch()
        except Exception:  # noqa: BLE001 - a schedule must not crash the loop
            logger.warning("schedule_browser_launch_failed")
            return False
        return bool(launched.state is BrowserSessionState.READY)

    async def _announce(self, reason: str) -> None:
        if self._notify is None:
            return
        try:
            await self._notify(reason)
        except Exception:  # noqa: BLE001 - a failed notification must not lose the state
            logger.warning("schedule_notification_failed reason=%s", reason)
