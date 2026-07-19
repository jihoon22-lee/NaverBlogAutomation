"""Explicitly opt-in live provider smoke test; never runs in normal CI."""

import os

import pytest

from naver_blog_assistant.domain import (
    CandidateTone,
    CapturedPost,
    CommentLength,
    CommentMood,
    GenerationPreferences,
    Relationship,
    SpeechStyle,
    comment_length_bounds,
)
from naver_blog_assistant.infrastructure.generators.openai import OpenAICommentGenerator


def _question_mark_count(value: str) -> int:
    return value.count("?") + value.count("？")


@pytest.mark.live_openai
@pytest.mark.parametrize(
    ("length", "mood"),
    [
        (CommentLength.SHORT, CommentMood.CALM),
        (CommentLength.MEDIUM, CommentMood.WARM),
        (CommentLength.LONG, CommentMood.LIVELY),
    ],
)
def test_live_openai_structured_generation(length: CommentLength, mood: CommentMood) -> None:
    if os.getenv("RUN_LIVE_OPENAI") != "1":
        pytest.skip("set RUN_LIVE_OPENAI=1 to make a real provider request")
    generator = OpenAICommentGenerator(api_key=os.environ["OPENAI_API_KEY"])
    try:
        result = generator.generate(
            CapturedPost(
                source_url="https://blog.naver.com/example/synthetic",
                title="합성 전시 후기",
                body="푸른 조각과 조용한 2층 관람 동선이 인상적이었다.",
            ),
            GenerationPreferences(
                relationship=Relationship.FRIENDLY,
                speech=SpeechStyle.HONORIFIC,
                length=length,
                mood=mood,
            ),
        )
    finally:
        generator.close()
    assert len(result.candidates) == 3
    minimum, maximum = comment_length_bounds(length)
    assert all(minimum <= len(candidate.comment) <= maximum for candidate in result.candidates)
    comments = {candidate.tone: candidate.comment for candidate in result.candidates}
    assert _question_mark_count(comments[CandidateTone.CURIOUS]) == 1
    assert _question_mark_count(comments[CandidateTone.WARM]) == 0
    assert _question_mark_count(comments[CandidateTone.SUPPORTIVE]) == 0
