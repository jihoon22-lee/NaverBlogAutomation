"""Lossless, body-free serialization for domain recommendations."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from naver_blog_assistant.domain import (
    DEFAULT_GENERATION_PREFERENCES,
    CandidateTone,
    CommentCandidate,
    CommentLength,
    CommentMood,
    GenerationPreferences,
    PersonalizationMode,
    Recommendation,
    Relationship,
    ReviewStatus,
    SpeechStyle,
)


def serialize_generation_preferences(preferences: GenerationPreferences) -> str:
    """Serialize generation provenance in one canonical JSON representation."""
    return json.dumps(
        {
            "relationship": preferences.relationship.value,
            "speech": preferences.speech.value,
            "length": preferences.length.value,
            "mood": preferences.mood.value,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


DEFAULT_GENERATION_PREFERENCES_JSON = serialize_generation_preferences(
    DEFAULT_GENERATION_PREFERENCES
)


def deserialize_generation_preferences(value: str) -> GenerationPreferences:
    """Restore and validate generation provenance from canonical JSON."""
    data: Any = json.loads(value)
    if not isinstance(data, dict):
        raise ValueError("generation preferences must be an object")
    try:
        relationship = data["relationship"]
        speech = data["speech"]
        length = data["length"]
    except KeyError as error:
        raise ValueError("generation preferences are incomplete") from error
    if set(data) not in (
        {"relationship", "speech", "length"},
        {"relationship", "speech", "length", "mood"},
    ):
        raise ValueError("generation preferences contain unknown fields")
    try:
        preferences = GenerationPreferences(
            relationship=Relationship(relationship),
            speech=SpeechStyle(speech),
            length=CommentLength(length),
            mood=CommentMood(data.get("mood", CommentMood.WARM.value)),
        )
    except (TypeError, ValueError) as error:
        raise ValueError("generation preferences are invalid") from error
    if preferences == DEFAULT_GENERATION_PREFERENCES:
        return DEFAULT_GENERATION_PREFERENCES
    return preferences


def format_timestamp(value: datetime) -> str:
    """Serialize a timezone-aware timestamp in canonical UTC form."""
    if value.tzinfo is None:
        raise ValueError("timestamp must be timezone-aware")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: str) -> datetime:
    """Parse a timestamp produced by :func:`format_timestamp`."""
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def serialize_topics(topics: tuple[str, ...]) -> str:
    """Serialize ordered topics without ASCII escaping."""
    return json.dumps(topics, ensure_ascii=False, separators=(",", ":"))


def deserialize_topics(value: str) -> tuple[str, ...]:
    """Deserialize and validate an ordered topic list."""
    data = json.loads(value)
    if not isinstance(data, list) or not all(isinstance(topic, str) for topic in data):
        raise ValueError("topics_json must contain a string list")
    return tuple(data)


def serialize_snapshot(recommendation: Recommendation) -> str:
    """Freeze the first response without storing the captured article body."""
    data = {
        "id": str(recommendation.id),
        "source_url": recommendation.source_url,
        "title": recommendation.title,
        "content_hash": recommendation.content_hash,
        "excerpt": recommendation.excerpt,
        "summary": recommendation.summary,
        "topics": list(recommendation.topics),
        "candidates": [
            {
                "id": str(candidate.id),
                "tone": candidate.tone.value,
                "comment": candidate.comment,
                "referenced_detail": candidate.referenced_detail,
            }
            for candidate in recommendation.candidates
        ],
        "review_status": recommendation.review_status.value,
        "created_at": format_timestamp(recommendation.created_at),
        "generation_preferences": json.loads(
            serialize_generation_preferences(recommendation.preferences)
        ),
        "personalization_mode": recommendation.personalization_mode.value,
        "personalization_sample_count": recommendation.personalization_sample_count,
        "personalization_eligible": recommendation.personalization_eligible,
        "selected_candidate_id": (
            str(recommendation.selected_candidate_id)
            if recommendation.selected_candidate_id is not None
            else None
        ),
        "edited_comment": recommendation.edited_comment,
        "updated_at": (
            format_timestamp(recommendation.updated_at)
            if recommendation.updated_at is not None
            else None
        ),
        "version": recommendation.version,
    }
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def deserialize_snapshot(value: str) -> Recommendation:
    """Restore an immutable first-response snapshot."""
    data: Any = json.loads(value)
    if not isinstance(data, dict):
        raise ValueError("response snapshot must be an object")
    return _recommendation_from_mapping(data)


def _recommendation_from_mapping(data: Mapping[str, Any]) -> Recommendation:
    candidates_data = data["candidates"]
    topics_data = data["topics"]
    if not isinstance(candidates_data, Sequence) or isinstance(candidates_data, str):
        raise ValueError("snapshot candidates must be a list")
    if not isinstance(topics_data, Sequence) or isinstance(topics_data, str):
        raise ValueError("snapshot topics must be a list")
    if "generation_preferences" in data:
        preferences = deserialize_generation_preferences(
            json.dumps(
                data["generation_preferences"],
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            )
        )
    else:
        preferences = DEFAULT_GENERATION_PREFERENCES
    return Recommendation(
        id=UUID(str(data["id"])),
        source_url=str(data["source_url"]),
        title=str(data["title"]),
        content_hash=str(data["content_hash"]),
        excerpt=str(data["excerpt"]),
        summary=str(data["summary"]),
        topics=tuple(str(topic) for topic in topics_data),
        candidates=tuple(
            CommentCandidate(
                id=UUID(str(candidate["id"])),
                tone=CandidateTone(str(candidate["tone"])),
                comment=str(candidate["comment"]),
                referenced_detail=str(candidate["referenced_detail"]),
            )
            for candidate in candidates_data
        ),
        review_status=ReviewStatus(str(data["review_status"])),
        created_at=parse_timestamp(str(data["created_at"])),
        preferences=preferences,
        personalization_mode=PersonalizationMode(
            str(data.get("personalization_mode", PersonalizationMode.OFF.value))
        ),
        personalization_sample_count=int(data.get("personalization_sample_count", 0)),
        personalization_eligible=bool(data.get("personalization_eligible", True)),
        selected_candidate_id=(
            UUID(str(data["selected_candidate_id"]))
            if data.get("selected_candidate_id") is not None
            else None
        ),
        edited_comment=(
            str(data["edited_comment"]) if data.get("edited_comment") is not None else None
        ),
        updated_at=(
            parse_timestamp(str(data["updated_at"])) if data.get("updated_at") is not None else None
        ),
        version=int(data["version"]),
    )
