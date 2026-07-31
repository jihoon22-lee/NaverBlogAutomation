"""Decide whether one more external action is allowed.

Every limit is checked before the action, not after: a daily cap, an allowed time window, a minimum
interval with jitter, dwell time proportional to the article length, and a consecutive-failure
threshold. A refusal carries a stable reason so the session records why it stopped.
"""

from __future__ import annotations

import random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from naver_blog_assistant.application.errors import ApplicationError
from naver_blog_assistant.domain import AppSettingKind, EngagementStepName

DEFAULT_TIMEZONE = "Asia/Seoul"
DWELL_PER_1000_CHARS_SECONDS = 6.0
MAX_DWELL_SECONDS = 90.0


class GovernorRefusedError(ApplicationError):
    """Raised with a stable reason when one more action is not allowed."""

    REASONS = frozenset({"daily_cap_reached", "outside_allowed_hours", "consecutive_failures"})

    def __init__(self, reason: str) -> None:
        if reason not in self.REASONS:
            raise ValueError(f"{reason} is not a known governor reason")
        super().__init__(reason)
        self.reason = reason


class SettingReader(Protocol):
    """Read one settings record, falling back to its documented default."""

    def execute(self, kind: AppSettingKind) -> Any: ...


class ActivityCounter(Protocol):
    """Count and record external actions per day."""

    def count(self, day: date, action: EngagementStepName) -> int: ...

    def record(self, day: date, action: EngagementStepName, *, amount: int = 1) -> int: ...


@dataclass(frozen=True, slots=True)
class SafetyPolicy:
    """The configured limits for external actions."""

    daily_caps: dict[EngagementStepName, int]
    min_interval_seconds: int
    jitter_ratio: float
    allowed_hours: tuple[int, ...]
    max_consecutive_failures: int


class SafetyGovernor:
    """Gate every external action behind the configured limits."""

    def __init__(
        self,
        *,
        read_setting: SettingReader,
        ledger: ActivityCounter,
        clock: Callable[[], datetime] | None = None,
        jitter: Callable[[float, float], float] | None = None,
        timezone: str = DEFAULT_TIMEZONE,
    ) -> None:
        self._read_setting = read_setting
        self._ledger = ledger
        self._clock = clock or (lambda: datetime.now(UTC))
        self._jitter = jitter or random.uniform  # noqa: S311 - pacing, not cryptography
        self._zone = ZoneInfo(timezone)
        self._consecutive_failures = 0

    def policy(self) -> SafetyPolicy:
        """Return the stored limits, or the documented defaults before any save."""
        payload = self._read_setting.execute(AppSettingKind.SAFETY_POLICY).payload
        return SafetyPolicy(
            daily_caps={
                EngagementStepName.LIKE: int(payload["daily_like_cap"]),
                EngagementStepName.COMMENT: int(payload["daily_comment_cap"]),
                EngagementStepName.MUTUAL_NEIGHBOR: int(payload["daily_neighbor_cap"]),
            },
            min_interval_seconds=int(payload["min_interval_seconds"]),
            jitter_ratio=float(payload["jitter_ratio"]),
            allowed_hours=tuple(int(hour) for hour in payload["allowed_hours"]),
            max_consecutive_failures=int(payload["max_consecutive_failures"]),
        )

    @property
    def today(self) -> date:
        """Return the local date the caps are counted against."""
        return self._clock().astimezone(self._zone).date()

    def check(self, actions: tuple[EngagementStepName, ...]) -> SafetyPolicy:
        """Raise when the next post would break a limit; otherwise return the policy."""
        policy = self.policy()
        local = self._clock().astimezone(self._zone)
        if local.hour not in policy.allowed_hours:
            raise GovernorRefusedError("outside_allowed_hours")
        if self._consecutive_failures >= policy.max_consecutive_failures:
            raise GovernorRefusedError("consecutive_failures")
        day = local.date()
        for action in actions:
            cap = policy.daily_caps.get(action)
            if cap is None:  # pragma: no cover - every step has a cap
                continue
            if self._ledger.count(day, action) + 1 > cap:
                raise GovernorRefusedError("daily_cap_reached")
        return policy

    def record_actions(self, actions: tuple[EngagementStepName, ...]) -> None:
        """Count the actions that actually ran."""
        day = self.today
        for action in actions:
            self._ledger.record(day, action)

    def record_result(self, *, succeeded: bool) -> int:
        """Track the consecutive-failure streak and return its current length."""
        self._consecutive_failures = 0 if succeeded else self._consecutive_failures + 1
        return self._consecutive_failures

    def reset_failures(self) -> None:
        """Forget the failure streak, for a fresh approval."""
        self._consecutive_failures = 0

    def next_interval_seconds(self, policy: SafetyPolicy) -> float:
        """Return the pause before the next post, including jitter."""
        base = float(policy.min_interval_seconds)
        spread = base * max(0.0, min(policy.jitter_ratio, 1.0))
        return max(0.0, base + self._jitter(-spread, spread))

    def dwell_seconds(self, body_length: int) -> float:
        """Return how long to stay on one article, proportional to its length."""
        if body_length <= 0:
            return 0.0
        return min(body_length / 1_000 * DWELL_PER_1000_CHARS_SECONDS, MAX_DWELL_SECONDS)
