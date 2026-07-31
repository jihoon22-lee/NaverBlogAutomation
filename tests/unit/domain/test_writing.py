"""Draft body blocks, tag normalization, and draft invariants."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest

from naver_blog_assistant.domain import DomainValidationError
from naver_blog_assistant.domain.writing import (
    DEFAULT_BODY_TAG_CAP,
    MAX_BLOCK_TEXT_LENGTH,
    MAX_BLOCKS,
    MAX_TAG_LENGTH,
    MAX_TAGS,
    BlockKind,
    BodyBlock,
    DraftImage,
    DraftRevision,
    DraftStatus,
    DraftTag,
    PostDraft,
    RevisionKind,
    TagSource,
    body_payload,
    body_tags,
    normalize_tag,
    normalize_tags,
    parse_body,
)

IMAGE_ID = UUID("11111111-1111-4111-8111-111111111111")
DRAFT_ID = UUID("22222222-2222-4222-8222-222222222222")


def paragraph(text: str = "문단입니다.") -> BodyBlock:
    return BodyBlock(kind=BlockKind.PARAGRAPH, text=text)


class TestBodyBlock:
    def test_a_paragraph_round_trips(self) -> None:
        block = paragraph()

        assert BodyBlock.from_payload(block.to_payload()) == block

    def test_an_image_block_round_trips_with_its_caption(self) -> None:
        block = BodyBlock(kind=BlockKind.IMAGE, image_id=IMAGE_ID, caption="설명")

        assert BodyBlock.from_payload(block.to_payload()) == block

    def test_an_image_block_requires_an_image(self) -> None:
        with pytest.raises(DomainValidationError, match="image_id"):
            BodyBlock(kind=BlockKind.IMAGE)

    def test_an_image_block_rejects_text(self) -> None:
        with pytest.raises(DomainValidationError, match="caption"):
            BodyBlock(kind=BlockKind.IMAGE, image_id=IMAGE_ID, text="본문")

    def test_a_text_block_rejects_an_image_reference(self) -> None:
        with pytest.raises(DomainValidationError, match="image block"):
            BodyBlock(kind=BlockKind.PARAGRAPH, text="본문", image_id=IMAGE_ID)

    def test_a_text_block_rejects_a_caption(self) -> None:
        with pytest.raises(DomainValidationError, match="caption"):
            BodyBlock(kind=BlockKind.PARAGRAPH, text="본문", caption="설명")

    def test_an_empty_paragraph_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError):
            paragraph("   ")

    def test_an_over_long_paragraph_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match=str(MAX_BLOCK_TEXT_LENGTH)):
            paragraph("가" * (MAX_BLOCK_TEXT_LENGTH + 1))

    def test_a_paragraph_at_the_limit_is_accepted(self) -> None:
        assert len(paragraph("가" * MAX_BLOCK_TEXT_LENGTH).text) == MAX_BLOCK_TEXT_LENGTH

    @pytest.mark.parametrize(
        "payload",
        [
            "문자열",
            {"type": "table", "text": "표"},
            {"type": "paragraph"},
            {"type": "paragraph", "text": 1},
            {"type": "image"},
            {"type": "image", "image_id": "not-a-uuid"},
            {"type": "image", "image_id": str(IMAGE_ID), "caption": 1},
        ],
    )
    def test_it_rejects_an_unusable_payload(self, payload: Any) -> None:
        with pytest.raises(DomainValidationError):
            BodyBlock.from_payload(payload)


class TestBody:
    def test_it_parses_a_mixed_body(self) -> None:
        blocks = parse_body(
            [
                {"type": "heading", "text": "제목"},
                {"type": "paragraph", "text": "문단"},
                {"type": "image", "image_id": str(IMAGE_ID), "caption": "사진"},
                {"type": "quote", "text": "인용"},
            ]
        )

        assert [block.kind for block in blocks] == [
            BlockKind.HEADING,
            BlockKind.PARAGRAPH,
            BlockKind.IMAGE,
            BlockKind.QUOTE,
        ]
        assert body_payload(blocks)[2]["image_id"] == str(IMAGE_ID)

    @pytest.mark.parametrize("payload", [[], {}, "문자열", None])
    def test_it_rejects_an_unusable_body(self, payload: Any) -> None:
        with pytest.raises(DomainValidationError):
            parse_body(payload)

    def test_it_rejects_too_many_blocks(self) -> None:
        payload = [{"type": "paragraph", "text": "문단"}] * (MAX_BLOCKS + 1)

        with pytest.raises(DomainValidationError, match=str(MAX_BLOCKS)):
            parse_body(payload)


class TestTags:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("#전시", "전시"),
            ("  전시 후기  ", "전시후기"),
            ("전시\n후기", "전시후기"),
            ("Travel_2026", "Travel_2026"),
            ("", ""),
            ("#", ""),
            ("가" * (MAX_TAG_LENGTH + 1), ""),
            ("태그!", ""),
            ("전시-후기", ""),
        ],
    )
    def test_it_normalizes_one_tag(self, value: str, expected: str) -> None:
        assert normalize_tag(value) == expected

    def test_it_keeps_a_tag_at_the_length_limit(self) -> None:
        assert normalize_tag("가" * MAX_TAG_LENGTH) == "가" * MAX_TAG_LENGTH

    def test_it_deduplicates_case_insensitively_and_keeps_order(self) -> None:
        tags = normalize_tags(["Travel", "travel", "전시", "#전시", "요리"])

        assert [tag.tag for tag in tags] == ["Travel", "전시", "요리"]
        assert [tag.ordinal for tag in tags] == [0, 1, 2]

    def test_it_drops_unusable_values(self) -> None:
        tags = normalize_tags(["전시", "", "태그!", 5, None])

        assert [tag.tag for tag in tags] == ["전시"]

    def test_it_stops_at_the_tag_limit(self) -> None:
        tags = normalize_tags([f"태그{index}" for index in range(MAX_TAGS + 10)])

        assert len(tags) == MAX_TAGS

    def test_it_records_the_source(self) -> None:
        tags = normalize_tags(["전시"], source=TagSource.USER)

        assert tags[0].source is TagSource.USER

    def test_it_rejects_a_non_list(self) -> None:
        with pytest.raises(DomainValidationError, match="tags must be a list"):
            normalize_tags("전시")

    def test_body_tags_uses_only_selected_tags_up_to_the_cap(self) -> None:
        tags = (
            DraftTag(tag="가", ordinal=0),
            DraftTag(tag="나", ordinal=1, selected=False),
            DraftTag(tag="다", ordinal=2),
        )

        assert body_tags(tags, cap=2) == ("가", "다")
        assert body_tags(tags, cap=1) == ("가",)
        assert body_tags(tags, cap=0) == ()

    def test_the_default_cap_is_documented(self) -> None:
        tags = tuple(DraftTag(tag=f"태그{index}", ordinal=index) for index in range(MAX_TAGS))

        assert len(body_tags(tags)) == DEFAULT_BODY_TAG_CAP

    def test_a_negative_cap_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="cap"):
            body_tags((), cap=-1)

    def test_an_unnormalized_tag_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="normalized"):
            DraftTag(tag="#전시", ordinal=0)


class TestDraftImage:
    def image(self, **overrides: Any) -> DraftImage:
        payload: dict[str, Any] = {
            "id": uuid4(),
            "draft_id": DRAFT_ID,
            "ordinal": 0,
            "stored_path": "drafts/x/1.jpg",
            "original_filename": "1.jpg",
            "byte_size": 1_024,
            "mime": "image/jpeg",
        }
        payload.update(overrides)
        return DraftImage(**payload)

    def test_it_accepts_an_allowed_type(self) -> None:
        assert self.image(mime="image/webp").mime == "image/webp"

    @pytest.mark.parametrize(
        "overrides",
        [
            {"mime": "image/svg+xml"},
            {"mime": "application/pdf"},
            {"byte_size": 0},
            {"byte_size": 10 * 1024 * 1024 + 1},
            {"ordinal": -1},
            {"stored_path": "   "},
            {"original_filename": "   "},
        ],
    )
    def test_it_rejects_an_unusable_image(self, overrides: dict[str, Any]) -> None:
        with pytest.raises(DomainValidationError):
            self.image(**overrides)


class TestPostDraft:
    def revision(self, *, round_no: int = 1, active: bool = False) -> DraftRevision:
        return DraftRevision(
            id=uuid4(),
            draft_id=DRAFT_ID,
            round_no=round_no,
            kind=RevisionKind.COMPOSED,
            title="합성 제목",
            blocks=(paragraph(),),
            is_active=active,
            created_at=datetime(2026, 7, 31, tzinfo=UTC),
        )

    def test_the_active_revision_wins_over_the_newest(self) -> None:
        first = self.revision(round_no=1, active=True)
        second = self.revision(round_no=2)
        draft = PostDraft(id=DRAFT_ID, title="제목", revisions=(first, second))

        assert draft.active_revision is first

    def test_the_newest_revision_is_used_without_a_selection(self) -> None:
        first = self.revision(round_no=1)
        second = self.revision(round_no=2)
        draft = PostDraft(id=DRAFT_ID, title="제목", revisions=(first, second))

        assert draft.active_revision is second
        assert draft.next_round == 3

    def test_a_draft_without_revisions_has_no_active_revision(self) -> None:
        draft = PostDraft(id=DRAFT_ID, title="제목")

        assert draft.active_revision is None
        assert draft.next_round == 1

    def test_two_active_revisions_are_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="one revision"):
            PostDraft(
                id=DRAFT_ID,
                title="제목",
                revisions=(self.revision(active=True), self.revision(round_no=2, active=True)),
            )

    def test_it_rejects_an_unusable_draft(self) -> None:
        with pytest.raises(DomainValidationError):
            PostDraft(id=DRAFT_ID, title="   ")
        with pytest.raises(DomainValidationError):
            PostDraft(id=DRAFT_ID, title="제목", category_no=-1)
        with pytest.raises(DomainValidationError):
            PostDraft(id=DRAFT_ID, title="제목", seed_text="가" * 20_001)

    def test_a_revision_requires_at_least_one_block(self) -> None:
        with pytest.raises(DomainValidationError, match="at least one block"):
            DraftRevision(
                id=uuid4(),
                draft_id=DRAFT_ID,
                round_no=1,
                kind=RevisionKind.SEED,
                title="제목",
                blocks=(),
            )

    def test_a_naive_timestamp_is_rejected(self) -> None:
        with pytest.raises(DomainValidationError, match="timezone-aware"):
            DraftRevision(
                id=uuid4(),
                draft_id=DRAFT_ID,
                round_no=1,
                kind=RevisionKind.SEED,
                title="제목",
                blocks=(paragraph(),),
                created_at=datetime(2026, 7, 31),  # noqa: DTZ001 - the point of the test
            )

    def test_the_documented_status_values_exist(self) -> None:
        assert {status.value for status in DraftStatus} == {
            "collecting",
            "composed",
            "refining",
            "tagged",
            "staging",
            "staged",
            "abandoned",
        }
