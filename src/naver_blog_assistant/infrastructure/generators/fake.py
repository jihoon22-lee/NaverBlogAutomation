"""Deterministic local generator used only when development mode is explicit."""

from __future__ import annotations

import re

from naver_blog_assistant.domain import (
    CandidateTone,
    CapturedPost,
    GeneratedComment,
    GenerationOutput,
)


class DeterministicFakeGenerator:
    """Return predictable Korean drafts without contacting a provider."""

    def generate(self, post: CapturedPost) -> GenerationOutput:
        """Build three valid candidates from a short, non-persisted body detail."""
        detail = _first_sentence(post.body)
        subject = post.title[:80]
        return GenerationOutput(
            summary=f"{subject}의 주요 내용을 소개한 글",
            topics=(subject,),
            candidates=(
                GeneratedComment(
                    tone=CandidateTone.WARM,
                    comment=f"{detail} 부분이 특히 인상 깊었어요. 좋은 글 잘 읽었습니다!",
                    referenced_detail=detail,
                ),
                GeneratedComment(
                    tone=CandidateTone.CURIOUS,
                    comment=(
                        f"{detail} 이야기가 흥미롭네요. "
                        "직접 경험하면서 가장 기억에 남은 점은 무엇인가요?"
                    ),
                    referenced_detail=detail,
                ),
                GeneratedComment(
                    tone=CandidateTone.SUPPORTIVE,
                    comment=(
                        f"{detail} 내용을 알기 쉽게 정리해 주셔서 큰 도움이 되었어요. "
                        "다음 글도 기대할게요!"
                    ),
                    referenced_detail=detail,
                ),
            ),
        )


def _first_sentence(body: str) -> str:
    normalized_body = body.strip()
    sentence = re.split(r"[.!?。！？]\s*", normalized_body, maxsplit=1)[0].strip()
    detail_length = min(120, max(1, len(normalized_body) // 2))
    detail = (sentence[:detail_length] or normalized_body[:detail_length]).strip()
    if detail == normalized_body:
        detail = detail[:-1].rstrip() or "본문 내용"
    return detail
