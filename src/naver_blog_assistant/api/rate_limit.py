"""Small in-process rate limiter for the single-user loopback service."""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable


class LocalRateLimiter:
    """Apply a process-wide sliding-window limit to generation requests."""

    def __init__(
        self,
        *,
        requests: int,
        window_seconds: float,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if requests < 1 or window_seconds <= 0:
            raise ValueError("rate limit values must be positive")
        self._limit = requests
        self._window = window_seconds
        self._clock = clock or time.monotonic
        self._events: deque[float] = deque()
        self._lock = threading.Lock()

    def acquire(self) -> int | None:
        """Record an accepted request or return whole seconds until retry."""
        with self._lock:
            now = self._clock()
            boundary = now - self._window
            while self._events and self._events[0] <= boundary:
                self._events.popleft()
            if len(self._events) >= self._limit:
                remaining = self._window - (now - self._events[0])
                return max(1, int(remaining) + (not remaining.is_integer()))
            self._events.append(now)
            return None
