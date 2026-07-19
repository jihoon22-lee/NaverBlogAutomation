"""Deterministic local generator used only when development mode is explicit."""

from __future__ import annotations

import re

from naver_blog_assistant.domain import (
    CandidateTone,
    CapturedPost,
    CommentLength,
    CommentMood,
    GeneratedComment,
    GenerationOutput,
    GenerationPreferences,
    Relationship,
    SpeechStyle,
    comment_length_bounds,
)

_RELATIONSHIP_PREFIX = {
    Relationship.NEW: "처음 뵙지만",
    Relationship.POLITE: "정중히 읽어 보니",
    Relationship.FRIENDLY: "따뜻한 마음으로",
    Relationship.CLOSE: "편하게 읽어 보니",
}
_MOOD_ADVERB = {
    CommentMood.CALM: "차분히",
    CommentMood.WARM: "따뜻하게",
    CommentMood.LIVELY: "생기 있게",
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
    mood = _MOOD_ADVERB[preferences.mood]
    detail_limit = {
        CommentLength.SHORT: 12,
        CommentLength.MEDIUM: 20,
        CommentLength.LONG: 30,
    }[preferences.length]
    grounded = detail[:detail_limit]
    if preferences.speech is SpeechStyle.BANMAL:
        templates = {
            CommentLength.SHORT: (
                "{prefix} {detail} 대목이 {mood} 와닿았어. 정성스러운 기록 잘 읽었어!",
                "{prefix} {detail} 이야기가 {mood} 궁금해졌어. 가장 기억에 남은 순간은 뭐였어?",
                "{prefix} {detail} 정리가 {mood} 힘이 됐어. 다음 기록도 즐겁게 이어가길 응원할게!",
            ),
            CommentLength.MEDIUM: (
                "{prefix} {detail} 대목에서 글의 분위기가 {mood} 전해져 특히 인상 깊었어. "
                "구체적인 경험을 솔직하게 나눠 줘서 장면을 떠올리며 즐겁게 읽었어!",
                "{prefix} {detail} 이야기를 읽으니 경험의 다음 장면이 {mood} 궁금해졌어. "
                "직접 겪은 순간 가운데 가장 오래 기억에 남을 것 같은 부분은 뭐였어?",
                "{prefix} {detail} 내용을 이해하기 쉽게 정리해 줘서 {mood} 힘이 됐어. "
                "꾸준히 기록하는 정성이 느껴져서 다음 이야기도 기분 좋게 이어가길 응원할게!",
            ),
            CommentLength.LONG: (
                "{prefix} {detail} 대목을 읽으며 글에 담긴 분위기와 경험이 "
                "{mood} 전해져 오래 머물렀어. 구체적인 장면을 차근차근 풀어 줘서 "
                "그때의 감정과 생각을 자연스럽게 따라갈 수 있었어. "
                "특히 사실을 과장하지 않고 세심하게 기록한 점에서 글에 들인 정성이 느껴졌어. "
                "한 편의 이야기를 함께 나눈 듯한 기분으로 마지막까지 즐겁게 읽었어!",
                "{prefix} {detail} 이야기를 읽으니 글에 다 담기지 않은 다음 장면까지 "
                "{mood} 궁금해졌어. 경험을 세심하게 풀어낸 덕분에 어떤 순서로 "
                "생각이 이어졌는지 편하게 이해할 수 있었어. "
                "여러 순간 가운데 다시 떠올렸을 때 가장 먼저 생각날 것 같은 장면은 뭐였어? "
                "본문에서 확인한 구체적인 내용 덕분에 답을 상상해 보는 과정도 흥미로웠어.",
                "{prefix} {detail} 내용을 알기 쉽게 정리해 줘서 읽는 내내 {mood} 힘을 얻었어. "
                "과정을 꾸준히 기록하는 태도와 작은 부분까지 놓치지 않는 정성이 "
                "글 곳곳에서 느껴졌어. "
                "이번 경험이 앞으로 이어질 새로운 시도와 이야기에도 든든한 밑바탕이 되면 좋겠어. "
                "다음 기록도 지금처럼 즐겁게 이어가길 진심으로 응원할게!",
            ),
        }
    else:
        templates = {
            CommentLength.SHORT: (
                "{prefix} {detail} 대목이 {mood} 와닿았어요. 정성스러운 기록 잘 읽었습니다!",
                "{prefix} {detail} 이야기가 {mood} 궁금해졌어요. "
                "가장 기억에 남은 순간은 무엇인가요?",
                "{prefix} {detail} 정리가 {mood} 힘이 됐어요. "
                "다음 기록도 즐겁게 이어가시길 응원합니다!",
            ),
            CommentLength.MEDIUM: (
                "{prefix} {detail} 대목에서 글의 분위기가 {mood} 전해져 특히 인상 깊었어요. "
                "구체적인 경험을 솔직하게 나눠 주셔서 장면을 떠올리며 즐겁게 읽었습니다!",
                "{prefix} {detail} 이야기를 읽으니 경험의 다음 장면이 {mood} 궁금해졌어요. "
                "직접 겪은 순간 가운데 가장 오래 기억에 남을 것 같은 부분은 무엇인가요?",
                "{prefix} {detail} 내용을 이해하기 쉽게 정리해 주셔서 {mood} 힘이 됐어요. "
                "꾸준히 기록하는 정성이 느껴져 다음 이야기도 기분 좋게 이어가시길 응원합니다!",
            ),
            CommentLength.LONG: (
                "{prefix} {detail} 대목을 읽으며 글에 담긴 분위기와 경험이 "
                "{mood} 전해져 오래 머물렀어요. 구체적인 장면을 차근차근 풀어 주셔서 "
                "그때의 감정과 생각을 자연스럽게 따라갈 수 있었습니다. "
                "특히 사실을 과장하지 않고 세심하게 기록한 점에서 글에 들인 정성이 느껴졌어요. "
                "한 편의 이야기를 함께 나눈 듯한 기분으로 마지막까지 즐겁게 읽었습니다!",
                "{prefix} {detail} 이야기를 읽으니 글에 다 담기지 않은 다음 장면까지 "
                "{mood} 궁금해졌어요. 경험을 세심하게 풀어 주신 덕분에 어떤 순서로 "
                "생각이 이어졌는지 편하게 이해할 수 있었습니다. "
                "여러 순간 가운데 다시 떠올렸을 때 가장 먼저 생각날 것 같은 장면은 무엇인가요? "
                "본문에서 확인한 구체적인 내용 덕분에 답을 상상해 보는 과정도 흥미로웠습니다.",
                "{prefix} {detail} 내용을 알기 쉽게 정리해 주셔서 읽는 내내 {mood} 힘을 얻었어요. "
                "과정을 꾸준히 기록하는 태도와 작은 부분까지 놓치지 않는 정성이 "
                "글 곳곳에서 느껴졌습니다. "
                "이번 경험이 앞으로 이어질 새로운 시도와 이야기에도 든든한 밑바탕이 되면 좋겠어요. "
                "다음 기록도 지금처럼 즐겁게 이어가시길 진심으로 응원합니다!",
            ),
        }
    first, second, third = templates[preferences.length]
    comments = tuple(
        template.format(prefix=prefix, detail=grounded, mood=mood)
        for template in (first, second, third)
    )
    minimum, maximum = comment_length_bounds(preferences.length)
    fillers = (
        (
            " 본문에 담긴 진솔한 시선도 인상 깊게 느껴졌습니다.",
            " 글의 흐름을 따라가며 제 경험도 함께 돌아보게 되었습니다.",
            " 정성스럽게 쌓은 기록이 앞으로도 좋은 힘이 되기를 바랍니다.",
        )
        if preferences.speech is SpeechStyle.HONORIFIC
        else (
            " 본문에 담긴 진솔한 시선도 인상 깊게 느껴졌어.",
            " 글의 흐름을 따라가며 내 경험도 함께 돌아보게 됐어.",
            " 정성스럽게 쌓은 기록이 앞으로도 좋은 힘이 되길 바랄게.",
        )
    )
    padded = tuple(
        _pad_to_minimum(comment, filler, minimum)
        for comment, filler in zip(comments, fillers, strict=True)
    )
    if any(len(comment) > maximum for comment in padded):
        raise RuntimeError("fake generator template is outside its configured length band")
    return padded[0], padded[1], padded[2]


def _pad_to_minimum(comment: str, filler: str, minimum: int) -> str:
    while len(comment) < minimum:
        comment += filler
    return comment


def _first_sentence(body: str) -> str:
    normalized_body = body.strip()
    sentence = re.split(r"[.!?。！？]\s*", normalized_body, maxsplit=1)[0].strip()
    detail_length = min(120, max(1, len(normalized_body) // 2))
    detail = (sentence[:detail_length] or normalized_body[:detail_length]).strip()
    if detail == normalized_body:
        detail = detail[:-1].rstrip() or "본문 내용"
    return detail
