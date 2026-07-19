"""Explicitly opt-in live provider smoke test; never runs in normal CI."""

import os

import pytest

from naver_blog_assistant.domain import DEFAULT_GENERATION_PREFERENCES, CapturedPost
from naver_blog_assistant.infrastructure.generators.openai import OpenAICommentGenerator


@pytest.mark.live_openai
def test_live_openai_structured_generation() -> None:
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
            DEFAULT_GENERATION_PREFERENCES,
        )
    finally:
        generator.close()
    assert len(result.candidates) == 3
