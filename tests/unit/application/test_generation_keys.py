"""Server-owned idempotency key derivation and attempt tracking."""

from __future__ import annotations

import pytest

from naver_blog_assistant.application.automation import (
    FIRST_ATTEMPT,
    GenerationKeyRegistry,
    derive_generation_key,
)

DIGEST = "a" * 64
OTHER = "b" * 64


def test_the_same_digest_and_attempt_always_derive_the_same_key() -> None:
    assert derive_generation_key(DIGEST, 1) == derive_generation_key(DIGEST, 1)


def test_a_different_attempt_derives_a_different_key() -> None:
    assert derive_generation_key(DIGEST, 1) != derive_generation_key(DIGEST, 2)


def test_a_different_digest_derives_a_different_key() -> None:
    assert derive_generation_key(DIGEST, 1) != derive_generation_key(OTHER, 1)


def test_derived_keys_are_version_five_uuids() -> None:
    assert derive_generation_key(DIGEST, 1).version == 5


def test_an_empty_digest_is_rejected() -> None:
    with pytest.raises(ValueError, match="request_hash"):
        derive_generation_key("", 1)


@pytest.mark.parametrize("attempt", [0, -1])
def test_an_attempt_below_one_is_rejected(attempt: int) -> None:
    with pytest.raises(ValueError, match="attempt"):
        derive_generation_key(DIGEST, attempt)


def test_the_first_request_starts_at_attempt_one() -> None:
    registry = GenerationKeyRegistry()

    attempt = registry.current(DIGEST)

    assert attempt.attempt == FIRST_ATTEMPT
    assert attempt.key == derive_generation_key(DIGEST, FIRST_ATTEMPT)


def test_repeating_a_request_reuses_the_same_key() -> None:
    registry = GenerationKeyRegistry()

    first = registry.current(DIGEST)
    second = registry.current(DIGEST)

    assert first.key == second.key
    assert second.attempt == FIRST_ATTEMPT


def test_a_replacement_advances_the_attempt_and_the_key() -> None:
    registry = GenerationKeyRegistry()
    first = registry.current(DIGEST)

    replacement = registry.replace(DIGEST)

    assert replacement.attempt == first.attempt + 1
    assert replacement.key != first.key
    assert registry.current(DIGEST).key == replacement.key


def test_repeated_replacements_keep_advancing() -> None:
    registry = GenerationKeyRegistry()

    keys = {registry.replace(DIGEST).key for _ in range(3)}

    assert len(keys) == 3
    assert registry.current(DIGEST).attempt == 4


def test_a_replacement_for_an_unseen_digest_starts_at_the_second_attempt() -> None:
    registry = GenerationKeyRegistry()

    replacement = registry.replace(DIGEST)

    assert replacement.attempt == 2


def test_digests_are_tracked_independently() -> None:
    registry = GenerationKeyRegistry()
    registry.replace(DIGEST)

    assert registry.current(OTHER).attempt == FIRST_ATTEMPT
    assert registry.current(DIGEST).attempt == 2


def test_recording_an_outcome_is_visible_on_the_current_attempt() -> None:
    registry = GenerationKeyRegistry()

    registry.record(DIGEST, "indeterminate")

    assert registry.current(DIGEST).outcome == "indeterminate"


def test_forgetting_a_digest_restarts_at_the_first_attempt() -> None:
    registry = GenerationKeyRegistry()
    registry.replace(DIGEST)

    registry.forget(DIGEST)

    assert registry.current(DIGEST).attempt == FIRST_ATTEMPT


def test_forgetting_an_unknown_digest_is_safe() -> None:
    GenerationKeyRegistry().forget(DIGEST)
