"""Deterministic local generator used only when development mode is explicit."""

from __future__ import annotations

import re

from naver_blog_assistant.domain import (
    CandidateTone,
    CapturedPost,
    CommentLength,
    GeneratedComment,
    GenerationOutput,
    GenerationPreferences,
    Relationship,
    SpeechStyle,
)

_RELATIONSHIP_PREFIX = {
    Relationship.NEW: "처음 뵙지만",
    Relationship.POLITE: "정중히 읽어 보니",
    Relationship.FRIENDLY: "따뜻한 마음으로",
    Relationship.CLOSE: "편하게 읽어 보니",
}


class DeterministicFakeGenerator:
    """Return predictable Korean drafts without contacting a provider."""

    def generate(self, post: CapturedPost, preferences: GenerationPreferences) -> GenerationOutput:
        """Build three valid candidates from a short, non-persisted body detail."""
        detail = _first_sentence(post.body)
        subject = post.title[:80]
        comments = _comments(detail, preferences)
        return GenerationOutput(
            summary=f"{subject}의 주요 내용을 소개한 글",
            topics=(subject,),
            candidates=(
                GeneratedComment(
                    tone=CandidateTone.WARM,
                    comment=comments[0],
                    referenced_detail=detail,
                ),
                GeneratedComment(
                    tone=CandidateTone.CURIOUS,
                    comment=comments[1],
                    referenced_detail=detail,
                ),
                GeneratedComment(
                    tone=CandidateTone.SUPPORTIVE,
                    comment=comments[2],
                    referenced_detail=detail,
                ),
            ),
        )


def _comments(detail: str, preferences: GenerationPreferences) -> tuple[str, str, str]:
    prefix = _RELATIONSHIP_PREFIX[preferences.relationship]
    detail_limit = {
        CommentLength.SHORT: 12,
        CommentLength.MEDIUM: 20,
        CommentLength.LONG: 30,
    }[preferences.length]
    grounded = detail[:detail_limit]
    if preferences.speech is SpeechStyle.BANMAL:
        templates = {
            CommentLength.SHORT: (
                "{prefix} {detail} 부분이 인상 깊었어. 잘 읽었어!",
                "{prefix} {detail} 이야기가 흥미로운데 더 들려줄래?",
                "{prefix} {detail} 정리가 유익했어. 다음 글도 기대할게!",
            ),
            CommentLength.MEDIUM: (
                "{prefix} {detail} 부분이 특히 인상 깊었어. "
                "생생한 이야기를 나눠 줘서 즐겁게 읽었어!",
                "{prefix} {detail} 이야기가 정말 흥미롭네. "
                "직접 겪으며 가장 기억에 남은 점도 궁금해!",
                "{prefix} {detail} 내용을 알기 쉽게 정리해 줘서 유익했어. 다음 기록도 기대할게!",
            ),
            CommentLength.LONG: (
                "{prefix} {detail} 부분을 읽으며 글의 분위기와 경험이 생생하게 전해졌어. "
                "구체적인 장면을 차근차근 나눠 줘서 핵심을 편하게 이해할 수 있었어. "
                "정성스러운 이야기 잘 읽었고 다음 기록도 기대할게!",
                "{prefix} {detail} 이야기가 눈에 그려질 만큼 흥미로웠어. "
                "경험을 세심하게 풀어낸 덕분에 어떤 순간이었는지 더 알고 싶어졌어. "
                "직접 겪으며 가장 오래 기억에 남은 점도 다음에 들려줘!",
                "{prefix} {detail} 내용을 이해하기 쉽게 정리해 줘서 큰 도움이 됐어. "
                "세심하게 담아낸 과정에서 글에 들인 정성과 즐거움이 함께 느껴졌어. "
                "앞으로 이어질 새로운 이야기도 기분 좋게 기다릴게!",
            ),
        }
    else:
        templates = {
            CommentLength.SHORT: (
                "{prefix} {detail} 부분이 인상 깊었어요. 잘 읽었습니다!",
                "{prefix} {detail} 이야기가 흥미로운데 더 들려주실래요?",
                "{prefix} {detail} 정리가 유익했어요. 다음 글도 기대할게요!",
            ),
            CommentLength.MEDIUM: (
                "{prefix} {detail} 부분이 특히 인상 깊었어요. "
                "생생한 이야기를 나눠 주셔서 즐겁게 읽었습니다!",
                "{prefix} {detail} 이야기가 정말 흥미롭네요. "
                "직접 겪으며 가장 기억에 남은 점도 궁금해요!",
                "{prefix} {detail} 내용을 알기 쉽게 정리해 주셔서 유익했어요. "
                "다음 기록도 기대할게요!",
            ),
            CommentLength.LONG: (
                "{prefix} {detail} 부분을 읽으며 글의 분위기와 경험이 생생하게 전해졌어요. "
                "구체적인 장면을 차근차근 나눠 주신 덕분에 핵심을 편하게 이해할 수 있었습니다. "
                "정성스러운 이야기 잘 읽었고 다음 기록도 기대하겠습니다!",
                "{prefix} {detail} 이야기가 눈에 그려질 만큼 흥미로웠어요. "
                "경험을 세심하게 풀어 주신 덕분에 어떤 순간이었는지 더 알고 싶어졌습니다. "
                "직접 겪으며 가장 오래 기억에 남은 점도 다음에 들려주세요!",
                "{prefix} {detail} 내용을 이해하기 쉽게 정리해 주셔서 큰 도움이 됐어요. "
                "세심하게 담아낸 과정에서 글에 들인 정성과 즐거움이 함께 느껴졌습니다. "
                "앞으로 이어질 새로운 이야기도 기분 좋게 기다리겠습니다!",
            ),
        }
    first, second, third = templates[preferences.length]
    return (
        first.format(prefix=prefix, detail=grounded),
        second.format(prefix=prefix, detail=grounded),
        third.format(prefix=prefix, detail=grounded),
    )


def _first_sentence(body: str) -> str:
    normalized_body = body.strip()
    sentence = re.split(r"[.!?。！？]\s*", normalized_body, maxsplit=1)[0].strip()
    detail_length = min(120, max(1, len(normalized_body) // 2))
    detail = (sentence[:detail_length] or normalized_body[:detail_length]).strip()
    if detail == normalized_body:
        detail = detail[:-1].rstrip() or "본문 내용"
    return detail
