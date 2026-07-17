"""Tests for the process-local generation rate limiter."""

import pytest

from naver_blog_assistant.api.rate_limit import LocalRateLimiter


def test_rate_limiter_releases_capacity_after_window() -> None:
    now = 10.0
    limiter = LocalRateLimiter(requests=1, window_seconds=5, clock=lambda: now)

    assert limiter.acquire() is None
    assert limiter.acquire() == 5
    now = 15.0
    assert limiter.acquire() is None


@pytest.mark.parametrize(
    ("requests", "window"),
    [(0, 1.0), (1, 0.0)],
)
def test_rate_limiter_rejects_non_positive_configuration(requests: int, window: float) -> None:
    with pytest.raises(ValueError, match="positive"):
        LocalRateLimiter(requests=requests, window_seconds=window)
