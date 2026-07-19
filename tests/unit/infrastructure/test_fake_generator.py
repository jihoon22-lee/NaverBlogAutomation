"""Tests for deterministic preference-aware local generation."""

import pytest

from naver_blog_assistant.domain import (
    CapturedPost,
    CommentLength,
    CommentMood,
    GenerationPreferences,
    Relationship,
    SpeechStyle,
)
from naver_blog_assistant.infrastructure.generators.fake import DeterministicFakeGenerator


def _post() -> CapturedPost:
    return CapturedPost(
        source_url="https://blog.naver.com/synthetic/1",
        title="합성 전시 후기",
        body="푸른 조각과 조용한 2층 전시 동선이 인상적이었다. 자세한 후기입니다.",
    )


@pytest.mark.parametrize(
    ("length", "minimum", "maximum"),
    [
        (CommentLength.SHORT, 40, 80),
        (CommentLength.MEDIUM, 100, 160),
        (CommentLength.LONG, 200, 320),
    ],
)
def test_fake_generator_follows_length_targets(
    length: CommentLength, minimum: int, maximum: int
) -> None:
    output = DeterministicFakeGenerator().generate(
        _post(),
        GenerationPreferences(
            relationship=Relationship.FRIENDLY,
            speech=SpeechStyle.HONORIFIC,
            length=length,
        ),
    )

    assert all(minimum <= len(candidate.comment) <= maximum for candidate in output.candidates)


def test_fake_generator_changes_relationship_and_speech_without_inventing_history() -> None:
    generator = DeterministicFakeGenerator()
    friendly = generator.generate(
        _post(),
        GenerationPreferences(
            relationship=Relationship.FRIENDLY,
            speech=SpeechStyle.HONORIFIC,
            length=CommentLength.SHORT,
        ),
    )
    close = generator.generate(
        _post(),
        GenerationPreferences(
            relationship=Relationship.CLOSE,
            speech=SpeechStyle.BANMAL,
            length=CommentLength.SHORT,
        ),
    )

    assert all("따뜻한 마음으로" in candidate.comment for candidate in friendly.candidates)
    assert all("편하게 읽어 보니" in candidate.comment for candidate in close.candidates)
    assert all(
        "요" in candidate.comment or "습니다" in candidate.comment
        for candidate in friendly.candidates
    )
    assert all(
        "요" not in candidate.comment and "습니다" not in candidate.comment
        for candidate in close.candidates
    )
    combined = " ".join(
        candidate.comment for candidate in (*friendly.candidates, *close.candidates)
    )
    assert "전에" not in combined
    assert "약속" not in combined


@pytest.mark.parametrize(
    ("mood", "marker"),
    [
        (CommentMood.CALM, "차분히"),
        (CommentMood.WARM, "따뜻하게"),
        (CommentMood.LIVELY, "생기 있게"),
    ],
)
def test_fake_generator_applies_mood_and_fixed_role_question_policy(
    mood: CommentMood, marker: str
) -> None:
    output = DeterministicFakeGenerator().generate(
        _post(),
        GenerationPreferences(
            relationship=Relationship.FRIENDLY,
            speech=SpeechStyle.HONORIFIC,
            length=CommentLength.MEDIUM,
            mood=mood,
        ),
    )

    assert all(marker in candidate.comment for candidate in output.candidates)
    by_tone = {candidate.tone.value: candidate.comment for candidate in output.candidates}
    assert by_tone["curious"].count("?") + by_tone["curious"].count("？") == 1
    assert not any(mark in by_tone["warm"] + by_tone["supportive"] for mark in ("?", "？"))
