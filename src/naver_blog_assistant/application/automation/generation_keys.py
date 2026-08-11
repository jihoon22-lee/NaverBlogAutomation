"""Server-owned idempotency keys for web app generation requests.

The service derives the key from the normalized request: the same request always maps to the same
key, which makes duplicate clicks, interrupted responses, and timeouts replay instead of paying for
a second provider call.

A replacement attempt is deliberate. It requires an explicit flag, because the prior provider result
may be unknown and a new key can bill again.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final
from uuid import UUID, uuid5

GENERATION_KEY_NAMESPACE: Final = UUID("6f0d5b62-5a4a-5f9e-9f2c-2b6a1c0d4e77")
FIRST_ATTEMPT: Final = 1


def derive_generation_key(request_hash: str, attempt: int) -> UUID:
    """Return the deterministic key for one request digest and attempt number."""
    if not request_hash:
        raise ValueError("request_hash must not be empty")
    if attempt < FIRST_ATTEMPT:
        raise ValueError("attempt must start at 1")
    return uuid5(GENERATION_KEY_NAMESPACE, f"{request_hash}:{attempt}")


@dataclass(slots=True)
class GenerationAttempt:
    """The current attempt for one request digest."""

    attempt: int
    key: UUID
    outcome: str = "unknown"


@dataclass(slots=True)
class GenerationKeyRegistry:
    """Track the current attempt per request digest for this process."""

    attempts: dict[str, GenerationAttempt] = field(default_factory=dict)

    def current(self, request_hash: str) -> GenerationAttempt:
        """Return the existing attempt or start the first one."""
        existing = self.attempts.get(request_hash)
        if existing is not None:
            return existing
        started = GenerationAttempt(
            attempt=FIRST_ATTEMPT, key=derive_generation_key(request_hash, FIRST_ATTEMPT)
        )
        self.attempts[request_hash] = started
        return started

    def replace(self, request_hash: str) -> GenerationAttempt:
        """Start a new attempt after the user accepted that the prior result is unknown."""
        previous = self.current(request_hash)
        replacement = GenerationAttempt(
            attempt=previous.attempt + 1,
            key=derive_generation_key(request_hash, previous.attempt + 1),
        )
        self.attempts[request_hash] = replacement
        return replacement

    def record(self, request_hash: str, outcome: str) -> None:
        """Remember the last observed outcome for diagnostics and recovery hints."""
        attempt = self.current(request_hash)
        attempt.outcome = outcome

    def forget(self, request_hash: str) -> None:
        """Drop a digest once its work is complete and no retry can apply."""
        self.attempts.pop(request_hash, None)
