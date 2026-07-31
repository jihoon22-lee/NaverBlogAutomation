"""Shared provider failure vocabulary.

Every adapter maps its own SDK exceptions onto these types so the application can treat providers
interchangeably. The two mixin classes mark failures that are safe to retry with the same
idempotency key because the provider never started generating.
"""

from __future__ import annotations

from naver_blog_assistant.application import (
    GenerationIndeterminateError,
    GenerationRateLimitedError,
    GenerationUnavailableError,
)
from naver_blog_assistant.ports import GenerationNotStartedError

# HTTP statuses whose outcome the provider cannot confirm.
INDETERMINATE_STATUSES = frozenset({408, 409})


class ProviderRateLimitError(GenerationRateLimitedError, GenerationNotStartedError):
    """A definite 429 rejection that is safe to retry with the same local key."""


class ProviderRejectedError(GenerationUnavailableError, GenerationNotStartedError):
    """A definite pre-generation HTTP rejection that is safe to retry locally."""


def status_failure(status: int, *, provider: str) -> Exception:
    """Return the mapped error for one provider HTTP status."""
    if status == 429:
        return ProviderRateLimitError(None)
    if status in INDETERMINATE_STATUSES or status >= 500:
        return GenerationIndeterminateError(f"{provider} outcome is indeterminate")
    return ProviderRejectedError(f"{provider} rejected request before generation")


def parse_retry_after(value: object) -> int | None:
    """Return a non-negative retry delay in seconds, ignoring anything unparsable."""
    if isinstance(value, bool) or not isinstance(value, str | int):
        return None
    try:
        seconds = int(value)
    except ValueError:
        return None
    return seconds if seconds >= 0 else None
