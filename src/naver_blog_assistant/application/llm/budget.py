"""Refuse a fan-out before it spends anything.

Cost grows with the number of providers, so both limits are checked before the first call: how many
providers one request may use, and how many provider calls this installation may make in a day.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from naver_blog_assistant.application.errors import ApplicationError
from naver_blog_assistant.domain import AppSettingKind, ModelSelection


class BudgetExceededError(ApplicationError):
    """Raised with a stable code when a request would exceed a configured limit."""

    CODES = frozenset({"provider_cap_exceeded", "daily_cap_exceeded"})

    def __init__(self, code: str, *, limit: int, observed: int) -> None:
        if code not in self.CODES:
            raise ValueError(f"{code} is not a known budget code")
        super().__init__(code)
        self.code = code
        self.limit = limit
        self.observed = observed


class SettingReader(Protocol):
    """Read one settings record, falling back to its documented default."""

    def execute(self, kind: AppSettingKind) -> Any: ...


class AttemptCounter(Protocol):
    """Count the provider attempts recorded at or after one moment."""

    def count_since(self, moment: datetime) -> int: ...


@dataclass(frozen=True, slots=True)
class BudgetLimits:
    """The configured limits for one request."""

    daily_call_cap: int
    per_request_provider_cap: int


class CallBudget:
    """Check the configured limits before any provider is called."""

    def __init__(
        self,
        *,
        read_setting: SettingReader,
        attempts: AttemptCounter,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._read_setting = read_setting
        self._attempts = attempts
        self._clock = clock or (lambda: datetime.now(UTC))

    def limits(self) -> BudgetLimits:
        """Return the stored limits, or the documented defaults before any save."""
        payload = self._read_setting.execute(AppSettingKind.LLM_BUDGET).payload
        return BudgetLimits(
            daily_call_cap=int(payload["daily_call_cap"]),
            per_request_provider_cap=int(payload["per_request_provider_cap"]),
        )

    def check(self, selections: Sequence[ModelSelection]) -> BudgetLimits:
        """Raise when ``selections`` would exceed a limit; otherwise return the limits."""
        limits = self.limits()
        if len(selections) > limits.per_request_provider_cap:
            raise BudgetExceededError(
                "provider_cap_exceeded",
                limit=limits.per_request_provider_cap,
                observed=len(selections),
            )
        used = self._attempts.count_since(self._day_start())
        if used + len(selections) > limits.daily_call_cap:
            raise BudgetExceededError(
                "daily_cap_exceeded", limit=limits.daily_call_cap, observed=used
            )
        return limits

    def _day_start(self) -> datetime:
        now = self._clock().astimezone(UTC)
        return now - timedelta(
            hours=now.hour, minutes=now.minute, seconds=now.second, microseconds=now.microsecond
        )
