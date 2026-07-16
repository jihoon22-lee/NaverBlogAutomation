"""Tests for framework-independent domain invariants."""

from dataclasses import fields
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID

import pytest

from naver_blog_assistant.domain import (
    CandidateSelectionError,
    CandidateTone,
    CapturedPost,
    CommentCandidate,
    DomainValidationError,
    Recommendation,
    ReviewPatch,
    ReviewStatus,
    ReviewTransitionError,
)

POST_ID = UUID("00000000-0000-0000-0000-000000000001")
CANDIDATE_IDS = tuple(UUID(f"00000000-0000-0000-0000-{index:012d}") for index in range(2, 5))
NOW = datetime(2026, 7, 16, 10, tzinfo=UTC)


def make_candidates() -> tuple[CommentCandidate, ...]:
    return tuple(
        CommentCandidate(
            id=candidate_id,
            tone=tone,
            comment=f"{tone.value} 댓글",
            referenced_detail=f"{tone.value} 근거",
        )
        for candidate_id, tone in zip(CANDIDATE_IDS, CandidateTone, strict=True)
    )


def make_recommendation(**changes: object) -> Recommendation:
    values: dict[str, object] = {
        "id": POST_ID,
        "source_url": "https://blog.naver.com/example/1",
        "title": "전시 후기",
        "content_hash": "a" * 64,
        "excerpt": "본문 일부",
        "summary": "전시 관람 후기",
        "topics": ("전시", "관람"),
        "candidates": make_candidates(),
        "review_status": ReviewStatus.DRAFTED,
        "created_at": NOW,
    }
    values.update(changes)
    return Recommendation(**cast(Any, values))


def test_captured_post_hashes_content_without_exposing_body_in_repr() -> None:
    post = CapturedPost(
        source_url="https://blog.naver.com/example/1",
        title="전시 후기",
        body="비공개일 수 있는 전체 본문",
    )

    assert post.content_hash == "a657082eb0a689190e0d925438266e6361246e6c789eb9fd3bf9023e8d63356b"
    assert post.request_hash == post.request_hash
    assert "비공개일 수 있는 전체 본문" not in repr(post)


@pytest.mark.parametrize(
    ("body", "expected_excerpt"),
    [
        ("가", ""),
        ("짧은 본문", "짧은 본"),
        ("가" * 600, "가" * 500),
    ],
)
def test_captured_post_excerpt_is_always_incomplete(body: str, expected_excerpt: str) -> None:
    post = CapturedPost(source_url="url", title="title", body=body)

    assert post.excerpt == expected_excerpt
    assert post.excerpt != post.body


def test_recommendation_has_no_body_field() -> None:
    assert "body" not in {model_field.name for model_field in fields(Recommendation)}


@pytest.mark.parametrize(
    ("source_url", "title", "body", "message"),
    [
        (" ", "title", "body", "source_url"),
        ("url", " ", "body", "title"),
        ("url", "title", " ", "body"),
    ],
)
def test_captured_post_rejects_empty_required_text(
    source_url: str, title: str, body: str, message: str
) -> None:
    with pytest.raises(DomainValidationError, match=message):
        CapturedPost(source_url=source_url, title=title, body=body)


def test_recommendation_requires_exactly_three_distinct_tones() -> None:
    with pytest.raises(DomainValidationError, match="exactly three"):
        make_recommendation(candidates=make_candidates()[:2])

    duplicate_tone = (
        make_candidates()[0],
        make_candidates()[1],
        CommentCandidate(
            id=CANDIDATE_IDS[2],
            tone=CandidateTone.WARM,
            comment="다른 댓글",
            referenced_detail="다른 근거",
        ),
    )
    with pytest.raises(DomainValidationError, match="required tones"):
        make_recommendation(candidates=duplicate_tone)


def test_recommendation_rejects_duplicate_candidate_ids() -> None:
    candidates = make_candidates()
    duplicate = CommentCandidate(
        id=candidates[0].id,
        tone=CandidateTone.SUPPORTIVE,
        comment="응원 댓글",
        referenced_detail="응원 근거",
    )

    with pytest.raises(DomainValidationError, match="ids must be unique"):
        make_recommendation(candidates=(*candidates[:2], duplicate))


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"source_url": " "}, "source_url"),
        ({"title": " "}, "title"),
        ({"title": "가" * 301}, "maximum"),
        ({"summary": " "}, "summary"),
        ({"content_hash": "nope"}, "SHA-256"),
        ({"content_hash": "z" * 64}, "SHA-256"),
        ({"excerpt": "가" * 501}, "excerpt"),
        ({"topics": ()}, "between one and five"),
        ({"topics": ("중복", "중복")}, "unique"),
        ({"topics": ("가" * 81,)}, "maximum"),
        ({"created_at": datetime(2026, 7, 16)}, "timezone-aware"),
        ({"updated_at": datetime(2026, 7, 16)}, "timezone-aware"),
    ],
)
def test_recommendation_rejects_invalid_persisted_values(
    changes: dict[str, object], message: str
) -> None:
    with pytest.raises(DomainValidationError, match=message):
        make_recommendation(**changes)


@pytest.mark.parametrize(
    ("comment", "detail", "message"),
    [
        (" ", "근거", "comment"),
        ("가" * 501, "근거", "comment"),
        ("댓글", " ", "referenced_detail"),
        ("댓글", "가" * 301, "referenced_detail"),
    ],
)
def test_comment_candidate_rejects_invalid_text(comment: str, detail: str, message: str) -> None:
    with pytest.raises(DomainValidationError, match=message):
        CommentCandidate(
            id=CANDIDATE_IDS[0],
            tone=CandidateTone.WARM,
            comment=comment,
            referenced_detail=detail,
        )


def test_review_can_select_by_id_or_index_and_edit() -> None:
    recommendation = make_recommendation()

    by_id = recommendation.apply_review(
        ReviewPatch(selected_candidate_id=CANDIDATE_IDS[1], edited_comment="직접 다듬은 댓글"),
        reviewed_at=NOW,
    )
    by_index = recommendation.apply_review(
        ReviewPatch(selected_candidate_index=2),
        reviewed_at=NOW,
    )

    assert by_id.selected_candidate_id == CANDIDATE_IDS[1]
    assert by_id.edited_comment == "직접 다듬은 댓글"
    assert by_index.selected_candidate_id == CANDIDATE_IDS[2]
    assert recommendation.selected_candidate_id is None


def test_review_can_clear_selection_and_edited_comment() -> None:
    recommendation = make_recommendation(
        selected_candidate_id=CANDIDATE_IDS[0], edited_comment="편집 댓글"
    )

    updated = recommendation.apply_review(
        ReviewPatch(clear_selection=True, clear_edited_comment=True), reviewed_at=NOW
    )

    assert updated.selected_candidate_id is None
    assert updated.edited_comment is None


@pytest.mark.parametrize(
    "patch",
    [
        ReviewPatch(selected_candidate_id=UUID("00000000-0000-0000-0000-000000000099")),
        ReviewPatch(selected_candidate_index=3),
    ],
)
def test_review_rejects_unknown_candidate_id_or_index(patch: ReviewPatch) -> None:
    with pytest.raises(CandidateSelectionError):
        make_recommendation().apply_review(patch, reviewed_at=NOW)


def test_review_rejects_negative_candidate_index() -> None:
    with pytest.raises(CandidateSelectionError, match="negative"):
        ReviewPatch(selected_candidate_index=-1)


def test_review_status_moves_forward_one_step_and_allows_same_status() -> None:
    drafted = make_recommendation()
    approved = drafted.apply_review(
        ReviewPatch(review_status=ReviewStatus.APPROVED), reviewed_at=NOW
    )
    unchanged = approved.apply_review(
        ReviewPatch(review_status=ReviewStatus.APPROVED), reviewed_at=NOW
    )
    completed = unchanged.apply_review(
        ReviewPatch(review_status=ReviewStatus.COMPLETED), reviewed_at=NOW
    )

    assert approved.review_status is ReviewStatus.APPROVED
    assert unchanged.review_status is ReviewStatus.APPROVED
    assert completed.review_status is ReviewStatus.COMPLETED


@pytest.mark.parametrize(
    ("current", "requested"),
    [
        (ReviewStatus.DRAFTED, ReviewStatus.COMPLETED),
        (ReviewStatus.APPROVED, ReviewStatus.DRAFTED),
        (ReviewStatus.COMPLETED, ReviewStatus.APPROVED),
    ],
)
def test_review_rejects_skipped_or_backward_status(
    current: ReviewStatus, requested: ReviewStatus
) -> None:
    recommendation = make_recommendation(review_status=current)

    with pytest.raises(ReviewTransitionError):
        recommendation.apply_review(ReviewPatch(review_status=requested), reviewed_at=NOW)


def test_completed_recommendation_rejects_content_changes() -> None:
    recommendation = make_recommendation(review_status=ReviewStatus.COMPLETED)

    with pytest.raises(ReviewTransitionError, match="cannot be edited"):
        recommendation.apply_review(ReviewPatch(edited_comment="수정"), reviewed_at=NOW)


def test_review_rejects_naive_timestamp() -> None:
    with pytest.raises(DomainValidationError, match="reviewed_at"):
        make_recommendation().apply_review(
            ReviewPatch(review_status=ReviewStatus.APPROVED),
            reviewed_at=datetime(2026, 7, 16),
        )


@pytest.mark.parametrize(
    "patch_args",
    [
        {},
        {"selected_candidate_id": CANDIDATE_IDS[0], "selected_candidate_index": 0},
        {"selected_candidate_id": CANDIDATE_IDS[0], "clear_selection": True},
        {"edited_comment": "댓글", "clear_edited_comment": True},
        {"edited_comment": " "},
        {"edited_comment": "가" * 501},
    ],
)
def test_review_patch_rejects_ambiguous_or_empty_operations(
    patch_args: dict[str, object],
) -> None:
    with pytest.raises(DomainValidationError):
        ReviewPatch(**cast(Any, patch_args))


def test_recommendation_rejects_invalid_selected_candidate_and_edited_comment() -> None:
    with pytest.raises(CandidateSelectionError):
        make_recommendation(selected_candidate_id=UUID(int=99))
    with pytest.raises(DomainValidationError, match="edited_comment"):
        make_recommendation(edited_comment=" ")
