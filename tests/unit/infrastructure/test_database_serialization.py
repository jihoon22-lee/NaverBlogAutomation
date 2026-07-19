"""Tests for canonical recommendation persistence serialization."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import UUID

import pytest

from naver_blog_assistant.domain import (
    DEFAULT_GENERATION_PREFERENCES,
    CandidateTone,
    CommentCandidate,
    CommentLength,
    DomainValidationError,
    GenerationPreferences,
    Recommendation,
    Relationship,
    ReviewStatus,
    SpeechStyle,
)
from naver_blog_assistant.infrastructure.database.serialization import (
    DEFAULT_GENERATION_PREFERENCES_JSON,
    deserialize_generation_preferences,
    deserialize_snapshot,
    serialize_generation_preferences,
    serialize_snapshot,
)


def _recommendation(preferences: GenerationPreferences) -> Recommendation:
    return Recommendation(
        id=UUID(int=1),
        source_url="https://blog.naver.com/example/1",
        title="합성 제목",
        content_hash="a" * 64,
        excerpt="합성 본문 일부",
        summary="합성 요약",
        topics=("전시",),
        candidates=tuple(
            CommentCandidate(
                id=UUID(int=index),
                tone=tone,
                comment=f"{tone.value} 댓글",
                referenced_detail=f"{tone.value} 근거",
            )
            for index, tone in enumerate(CandidateTone, start=2)
        ),
        review_status=ReviewStatus.DRAFTED,
        created_at=datetime(2026, 7, 19, tzinfo=UTC),
        preferences=preferences,
    )


def test_generation_preferences_use_stable_canonical_json() -> None:
    assert DEFAULT_GENERATION_PREFERENCES_JSON == (
        '{"length":"medium","relationship":"friendly","speech":"honorific"}'
    )
    assert (
        deserialize_generation_preferences(DEFAULT_GENERATION_PREFERENCES_JSON)
        == DEFAULT_GENERATION_PREFERENCES
    )


@pytest.mark.parametrize(
    "payload",
    [
        "null",
        "[]",
        '{"relationship":"friendly","speech":"honorific"}',
        '{"length":"medium","relationship":"friendly","speech":"honorific","x":1}',
        '{"length":"medium","relationship":"unknown","speech":"honorific"}',
        '{"length":"medium","relationship":{},"speech":"honorific"}',
        '{"length":"medium","relationship":"friendly","speech":"banmal"}',
    ],
)
def test_generation_preferences_reject_corrupt_json(payload: str) -> None:
    with pytest.raises((ValueError, DomainValidationError)):
        deserialize_generation_preferences(payload)


def test_snapshot_round_trip_preserves_non_default_generation_preferences() -> None:
    preferences = GenerationPreferences(
        relationship=Relationship.CLOSE,
        speech=SpeechStyle.BANMAL,
        length=CommentLength.LONG,
    )
    item = _recommendation(preferences)

    encoded = serialize_snapshot(item)

    assert json.loads(encoded)["generation_preferences"] == {
        "relationship": "close",
        "speech": "banmal",
        "length": "long",
    }
    assert deserialize_snapshot(encoded) == item


def test_legacy_snapshot_without_generation_preferences_uses_named_default() -> None:
    snapshot = json.loads(serialize_snapshot(_recommendation(DEFAULT_GENERATION_PREFERENCES)))
    del snapshot["generation_preferences"]

    restored = deserialize_snapshot(json.dumps(snapshot))

    assert restored.preferences is DEFAULT_GENERATION_PREFERENCES


@pytest.mark.parametrize(
    "preferences",
    [
        None,
        "friendly",
        {},
        {"relationship": "friendly", "speech": "honorific", "length": "unknown"},
        {"relationship": "friendly", "speech": "banmal", "length": "medium"},
    ],
)
def test_snapshot_does_not_treat_present_invalid_preferences_as_legacy(
    preferences: object,
) -> None:
    snapshot = json.loads(serialize_snapshot(_recommendation(DEFAULT_GENERATION_PREFERENCES)))
    snapshot["generation_preferences"] = preferences

    with pytest.raises((ValueError, DomainValidationError)):
        deserialize_snapshot(json.dumps(snapshot))


def test_serializer_preserves_all_preference_values() -> None:
    preferences = GenerationPreferences(
        relationship=Relationship.NEW,
        speech=SpeechStyle.HONORIFIC,
        length=CommentLength.SHORT,
    )

    assert deserialize_generation_preferences(serialize_generation_preferences(preferences)) == (
        preferences
    )
