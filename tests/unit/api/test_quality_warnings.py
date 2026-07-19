"""Deterministic response-only generation quality diagnostics."""

from datetime import UTC, datetime
from uuid import UUID

from naver_blog_assistant.api.models import RecommendationResponse
from naver_blog_assistant.domain import (
    DEFAULT_GENERATION_PREFERENCES,
    CandidateTone,
    CommentCandidate,
    CommentLength,
    GenerationPreferences,
    Recommendation,
    Relationship,
    ReviewStatus,
    SpeechStyle,
)


def _bounded(seed: str, length: int) -> str:
    return (seed * (length // len(seed) + 1))[:length]


def _recommendation(
    comments: tuple[str, str, str],
    *,
    length: CommentLength = CommentLength.MEDIUM,
) -> Recommendation:
    preferences = GenerationPreferences(
        relationship=Relationship.FRIENDLY,
        speech=SpeechStyle.HONORIFIC,
        length=length,
    )
    return Recommendation(
        id=UUID(int=1),
        source_url="https://blog.naver.com/example/1",
        title="합성 제목",
        content_hash="a" * 64,
        excerpt="합성 본문 일부",
        summary="합성 요약",
        topics=("합성",),
        candidates=tuple(
            CommentCandidate(
                id=UUID(int=index),
                tone=tone,
                comment=comment,
                referenced_detail="합성 근거",
            )
            for index, (tone, comment) in enumerate(
                zip(CandidateTone, comments, strict=True), start=2
            )
        ),
        review_status=ReviewStatus.DRAFTED,
        created_at=datetime(2026, 7, 19, tzinfo=UTC),
        preferences=preferences,
    )


def _role_distinct_comments() -> tuple[str, str, str]:
    return (
        _bounded("공감되는 장면을 차분히 돌아보았습니다. ", 120),
        _bounded("본문의 구체적인 다음 과정이 궁금합니다. ", 119) + "?",
        _bounded("앞으로 이어질 기록과 새로운 시도를 응원합니다. ", 120),
    )


def test_quality_warnings_are_empty_for_distinct_role_correct_candidates() -> None:
    response = RecommendationResponse.from_domain(_recommendation(_role_distinct_comments()))

    assert response.quality_warnings == []
    assert response.comment_mood == DEFAULT_GENERATION_PREFERENCES.mood.value


def test_quality_warnings_flag_length_and_question_role_drift_in_stable_order() -> None:
    warm, curious, supportive = _role_distinct_comments()
    response = RecommendationResponse.from_domain(
        _recommendation((warm[:98] + "?", curious.rstrip("?"), supportive))
    )

    assert response.quality_warnings[:2] == [
        "length_target_missed",
        "candidate_roles_blurred",
    ]


def test_quality_warnings_flag_normalized_pair_similarity_at_threshold() -> None:
    common = _bounded("동일한 후보 문장을 비교하기 위한 합성 내용입니다. ", 120)
    response = RecommendationResponse.from_domain(
        _recommendation((common, common[:-1] + "?", common))
    )

    assert response.quality_warnings == ["candidates_too_similar"]
