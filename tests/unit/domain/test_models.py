"""Tests for framework-independent domain invariants."""

import json
from dataclasses import MISSING, FrozenInstanceError, fields
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import pytest

from naver_blog_assistant.api.models import CreateRecommendationRequest
from naver_blog_assistant.domain import (
    DEFAULT_GENERATION_PREFERENCES,
    CandidateSelectionError,
    CandidateTone,
    CapturedPost,
    CommentCandidate,
    CommentLength,
    DomainValidationError,
    GenerationPreferences,
    Recommendation,
    Relationship,
    ReviewPatch,
    ReviewStatus,
    ReviewTransitionError,
    SpeechStyle,
)

POST_ID = UUID("00000000-0000-0000-0000-000000000001")
CANDIDATE_IDS = tuple(UUID(f"00000000-0000-0000-0000-{index:012d}") for index in range(2, 5))
NOW = datetime(2026, 7, 16, 10, tzinfo=UTC)
ROOT = Path(__file__).parents[3]


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
        "preferences": DEFAULT_GENERATION_PREFERENCES,
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
    ("raw_payload", "expected_hash"),
    [
        (
            {
                "source_url": " https://blog.naver.com/example/1 ",
                "title": " 주말\n전시\t후기 ",
                "body": "푸른\u00a0조각과 😀 작품을\n 자세히 소개한 합성 본문입니다.",
            },
            "822c3c39d1f9934a7c2f54a7b2eb01eb2e9985f1f2b33c3ae9ae597f81b60603",
        ),
        (
            {
                "source_url": "https://m.blog.naver.com/example/2",
                "title": "\ufeff제목\ufeff",
                "body": "\ufeff앞뒤 FEFF는 Python에서 유지되는 충분히 긴 합성 본문입니다.\ufeff",
            },
            "7874c875551b748d65819f09b8cff429326d7f164fe5d56d2f9669f8209ba932",
        ),
        (
            {
                "source_url": "https://blog.naver.com/example/3",
                "title": "Unicode 공백",
                "body": "A\u001cB\u0085C\u2028D\u3000E 문자를 포함한 충분히 긴 합성 본문입니다.",
            },
            "3cbb31fae5eb30b4a084c67cefbd91f7bf7da6a686afb78d30d47828f351cb95",
        ),
    ],
)
def test_request_hash_matches_cross_language_normalization_vectors(
    raw_payload: dict[str, str], expected_hash: str
) -> None:
    payload = CreateRecommendationRequest.model_validate(raw_payload)
    post = CapturedPost(
        source_url=payload.source_url,
        title=payload.title,
        body=payload.body,
    )

    assert post.request_hash == expected_hash


def test_preference_aware_request_hash_matches_shared_contract_vectors() -> None:
    vectors = json.loads(
        (ROOT / "tests/contract/generation-request-hash-vectors.json").read_text(encoding="utf-8")
    )
    hashes: dict[str, str] = {}
    for vector in vectors:
        payload = CreateRecommendationRequest(**vector["request"])
        post = CapturedPost(
            source_url=payload.source_url,
            title=payload.title,
            body=payload.body,
        )
        hashes[vector["id"]] = post.request_hash_for(payload.to_generation_preferences())
        assert hashes[vector["id"]] == vector["expected_hash"]

    assert hashes["omitted-defaults"] == hashes["explicit-defaults"]
    assert len(set(hashes.values())) == len(hashes) - 1


@pytest.mark.parametrize(
    ("body", "expected_excerpt"),
    [
        ("가", ""),
        ("짧은 본문", "짧은"),
        ("가" * 600, "가" * 300),
    ],
)
def test_captured_post_excerpt_is_always_incomplete(body: str, expected_excerpt: str) -> None:
    post = CapturedPost(source_url="url", title="title", body=body)

    assert post.excerpt == expected_excerpt
    assert post.excerpt != post.body


def test_recommendation_has_no_body_field() -> None:
    assert "body" not in {model_field.name for model_field in fields(Recommendation)}


def test_generation_preferences_have_one_named_legacy_default() -> None:
    assert (
        GenerationPreferences(
            relationship=Relationship.FRIENDLY,
            speech=SpeechStyle.HONORIFIC,
            length=CommentLength.MEDIUM,
        )
        == DEFAULT_GENERATION_PREFERENCES
    )
    preference_field = next(
        model_field for model_field in fields(Recommendation) if model_field.name == "preferences"
    )
    assert preference_field.default is MISSING
    assert preference_field.default_factory is MISSING


def test_generation_preferences_are_immutable() -> None:
    attribute = "length"
    with pytest.raises(FrozenInstanceError):
        setattr(DEFAULT_GENERATION_PREFERENCES, attribute, CommentLength.LONG)


@pytest.mark.parametrize(
    ("relationship", "speech"),
    [
        (Relationship.NEW, SpeechStyle.HONORIFIC),
        (Relationship.POLITE, SpeechStyle.HONORIFIC),
        (Relationship.FRIENDLY, SpeechStyle.HONORIFIC),
        (Relationship.CLOSE, SpeechStyle.HONORIFIC),
        (Relationship.CLOSE, SpeechStyle.BANMAL),
    ],
)
def test_generation_preferences_accept_supported_combinations(
    relationship: Relationship, speech: SpeechStyle
) -> None:
    assert (
        GenerationPreferences(
            relationship=relationship,
            speech=speech,
            length=CommentLength.SHORT,
        ).relationship
        is relationship
    )


@pytest.mark.parametrize("relationship", list(Relationship)[:-1])
def test_generation_preferences_allow_banmal_only_for_close(
    relationship: Relationship,
) -> None:
    with pytest.raises(DomainValidationError, match="banmal"):
        GenerationPreferences(
            relationship=relationship,
            speech=SpeechStyle.BANMAL,
            length=CommentLength.MEDIUM,
        )


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"relationship": "friendly"}, "relationship"),
        ({"speech": "honorific"}, "speech"),
        ({"length": "medium"}, "length"),
    ],
)
def test_generation_preferences_reject_raw_or_unknown_enum_values(
    changes: dict[str, object], message: str
) -> None:
    values: dict[str, object] = {
        "relationship": Relationship.FRIENDLY,
        "speech": SpeechStyle.HONORIFIC,
        "length": CommentLength.MEDIUM,
    }
    values.update(changes)
    with pytest.raises(DomainValidationError, match=message):
        GenerationPreferences(**cast(Any, values))


def test_recommendation_version_starts_at_zero_and_cannot_be_negative() -> None:
    assert make_recommendation().version == 0
    with pytest.raises(DomainValidationError, match="version"):
        make_recommendation(version=-1)


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
        ({"preferences": {}}, "preferences"),
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
