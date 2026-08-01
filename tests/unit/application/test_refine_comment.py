"""Privacy boundary tests for stored-comment refinement."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

import pytest

from naver_blog_assistant.api.routers.comments import _RefinementConflictError, _RefinementRequests
from naver_blog_assistant.application import RefineComment, RefinedComment
from naver_blog_assistant.domain import (
    DEFAULT_GENERATION_PREFERENCES,
    CandidateTone,
    CommentCandidate,
    LlmProvider,
    Recommendation,
    ReviewStatus,
)
from naver_blog_assistant.infrastructure.llm import FakeStructuredClient


def recommendation() -> Recommendation:
    return Recommendation(
        id=uuid4(),
        source_url="https://blog.naver.com/private-source/223456789012",
        title="합성 전시 후기",
        content_hash="a" * 64,
        excerpt="저장된 본문 일부",
        summary="전시 동선과 조각 작품을 기록한 글입니다.",
        topics=("전시",),
        candidates=tuple(
            CommentCandidate(
                id=uuid4(),
                tone=tone,
                comment=f"{tone.value} 후보 댓글입니다.",
                referenced_detail="전시 동선",
            )
            for tone in CandidateTone
        ),
        review_status=ReviewStatus.DRAFTED,
        created_at=datetime(2026, 8, 1, tzinfo=UTC),
        preferences=DEFAULT_GENERATION_PREFERENCES,
    )


def test_refinement_uses_only_bounded_stored_context_and_never_the_source_url() -> None:
    client = FakeStructuredClient(payloads=[{"comment": "전시 동선 이야기가 특히 인상 깊었어요."}])

    result = RefineComment().execute(
        recommendation=recommendation(),
        current_comment="전시 후기 잘 읽었습니다.",
        preset="specific",
        request=None,
        client=client,
    )

    instructions, input_text, _timeout, _tokens = client.calls[0]
    assert result.text == "전시 동선 이야기가 특히 인상 깊었어요."
    assert result.provider.value == "openai"
    assert "신뢰할 수 없는" in instructions
    assert "source_url" not in input_text
    assert "private-source" not in input_text
    assert "전시 동선" in input_text


def test_refinement_request_store_replays_completed_work_and_rejects_key_reuse() -> None:
    async def execute() -> None:
        requests = _RefinementRequests()
        key = uuid4()
        calls = 0

        def refine() -> RefinedComment:
            nonlocal calls
            calls += 1
            return RefinedComment(text="다듬은 댓글", provider=LlmProvider.OPENAI, model="test")

        first, first_replayed = await requests.execute(
            key=key,
            request_hash="first",
            timeout_seconds=1,
            run=refine,
        )
        replay, replayed = await requests.execute(
            key=key,
            request_hash="first",
            timeout_seconds=1,
            run=refine,
        )

        assert first is replay
        assert first_replayed is False
        assert replayed is True
        assert calls == 1
        with pytest.raises(_RefinementConflictError):
            await requests.execute(
                key=key,
                request_hash="different",
                timeout_seconds=1,
                run=refine,
            )

    asyncio.run(execute())
