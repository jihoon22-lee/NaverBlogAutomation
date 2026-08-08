"""Composition, refinement, and tagging of one draft."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest

from naver_blog_assistant.application.writing import (
    ComposePost,
    ReferenceBody,
    WritingOptions,
    WritingRefusedError,
)
from naver_blog_assistant.domain.writing import (
    BlockKind,
    BodyBlock,
    DraftImage,
    DraftRevision,
    DraftStatus,
    DraftTag,
    PostDraft,
    RevisionKind,
    TagSource,
)
from naver_blog_assistant.infrastructure.llm import FakeStructuredClient

DRAFT_ID = UUID("11111111-1111-4111-8111-111111111111")
IMAGE_ID = UUID("22222222-2222-4222-8222-222222222222")


def image() -> DraftImage:
    return DraftImage(
        id=IMAGE_ID,
        draft_id=DRAFT_ID,
        ordinal=0,
        stored_path=f"drafts/{DRAFT_ID}/{IMAGE_ID}.png",
        original_filename="a.png",
        byte_size=100,
        mime="image/png",
        alt_text="전시장 입구",
    )


def revision(*, active: bool = True) -> DraftRevision:
    return DraftRevision(
        id=uuid4(),
        draft_id=DRAFT_ID,
        round_no=1,
        kind=RevisionKind.COMPOSED,
        title="이전 제목",
        blocks=(BodyBlock(kind=BlockKind.PARAGRAPH, text="이전 문단"),),
        is_active=active,
        created_at=datetime(2026, 7, 31, tzinfo=UTC),
    )


class _Store:
    """In-memory draft store that records what the use case wrote."""

    def __init__(self, draft: PostDraft) -> None:
        self.draft = draft
        self.revisions: list[dict[str, Any]] = []
        self.tags: list[tuple[DraftTag, ...]] = []

    def get(self, draft_id: UUID) -> PostDraft:
        assert draft_id == self.draft.id
        return self.draft

    def add_revision(self, **kwargs: Any) -> PostDraft:
        self.revisions.append(kwargs)
        return self.draft

    def replace_tags(self, draft_id: UUID, tags: Any) -> PostDraft:
        assert draft_id == self.draft.id
        self.tags.append(tuple(tags))
        return self.draft


def draft(**overrides: Any) -> PostDraft:
    payload: dict[str, Any] = {
        "id": DRAFT_ID,
        "title": "합성 초안",
        "seed_text": "전시에서 본 작품을 메모했습니다.",
        "images": (image(),),
        "revisions": (),
        "tags": (),
    }
    payload.update(overrides)
    return PostDraft(**payload)


def composed(blocks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "title": "생성된 제목",
        "summary": "생성된 요약",
        "blocks": blocks
        or [
            {"type": "heading", "text": "첫 구역"},
            {"type": "paragraph", "text": "생성된 문단입니다."},
            {"type": "image", "image_id": str(IMAGE_ID), "caption": "전시장"},
        ],
    }


def run(coroutine: Any) -> Any:
    async def bounded() -> Any:
        async with asyncio.timeout(10):
            return await coroutine

    return asyncio.run(bounded())


class TestCompose:
    def test_it_stores_one_revision_with_the_generated_body(self) -> None:
        store = _Store(draft())
        client = FakeStructuredClient(payloads=[composed()], model="gpt-test")

        run(ComposePost(store).compose(draft_id=DRAFT_ID, client=client))

        recorded = store.revisions[0]
        assert recorded["kind"] is RevisionKind.COMPOSED
        assert recorded["title"] == "생성된 제목"
        assert recorded["status"] is DraftStatus.COMPOSED
        assert recorded["provider"] == "openai"
        assert recorded["model"] == "gpt-test"
        assert [block.kind for block in recorded["blocks"]] == [
            BlockKind.HEADING,
            BlockKind.PARAGRAPH,
            BlockKind.IMAGE,
        ]

    def test_it_preserves_every_supported_canonical_block_kind(self) -> None:
        store = _Store(draft())
        client = FakeStructuredClient(
            payloads=[
                composed(
                    [
                        {"type": "heading", "text": "소제목"},
                        {"type": "quote", "text": "인용"},
                        {"type": "ordered_list", "items": ["첫째", "둘째"]},
                        {"type": "unordered_list", "items": ["하나", "둘"]},
                        {"type": "divider"},
                    ]
                )
            ]
        )

        run(ComposePost(store).compose(draft_id=DRAFT_ID, client=client))

        recorded = store.revisions[0]
        assert [block.kind for block in recorded["blocks"]] == [
            BlockKind.HEADING,
            BlockKind.QUOTE,
            BlockKind.ORDERED_LIST,
            BlockKind.UNORDERED_LIST,
            BlockKind.DIVIDER,
        ]
        assert recorded["blocks"][2].items == ("첫째", "둘째")

    def test_it_sends_the_seed_and_references_as_untrusted_data(self) -> None:
        store = _Store(draft())
        client = FakeStructuredClient(payloads=[composed()])

        run(
            ComposePost(store).compose(
                draft_id=DRAFT_ID,
                client=client,
                references=(ReferenceBody(title="이전 전시 후기", body="본문" * 5),),
                options=WritingOptions(length="long", tone="calm", structure="story"),
            )
        )

        instructions, input_text, _timeout, _tokens = client.calls[0]
        assert "<SEED_TEXT>" in input_text
        assert "이전 전시 후기" in input_text
        assert str(IMAGE_ID) in input_text
        assert "신뢰할 수 없는" in instructions
        assert "문단 11~16개" in instructions
        assert "차분하고" in instructions

    def test_it_truncates_a_long_reference_body(self) -> None:
        store = _Store(draft())
        client = FakeStructuredClient(payloads=[composed()])

        run(
            ComposePost(store).compose(
                draft_id=DRAFT_ID,
                client=client,
                references=(ReferenceBody(title="긴 글", body="가" * 9_000),),
            )
        )

        assert "가" * 4_001 not in client.calls[0][1]

    def test_a_missing_seed_is_refused_before_any_call(self) -> None:
        store = _Store(draft(seed_text="   "))
        client = FakeStructuredClient(payloads=[composed()])

        with pytest.raises(WritingRefusedError) as error:
            run(ComposePost(store).compose(draft_id=DRAFT_ID, client=client))
        assert error.value.code == "seed_text_missing"
        assert client.calls == []

    def test_an_unknown_image_reference_is_refused(self) -> None:
        store = _Store(draft())
        client = FakeStructuredClient(
            payloads=[composed([{"type": "image", "image_id": str(uuid4()), "caption": "x"}])]
        )

        with pytest.raises(WritingRefusedError) as error:
            run(ComposePost(store).compose(draft_id=DRAFT_ID, client=client))
        assert error.value.code == "unknown_image_reference"
        assert store.revisions == []

    def test_a_repeated_image_reference_is_refused(self) -> None:
        store = _Store(draft())
        client = FakeStructuredClient(
            payloads=[
                composed(
                    [
                        {"type": "image", "image_id": str(IMAGE_ID), "caption": "a"},
                        {"type": "image", "image_id": str(IMAGE_ID), "caption": "b"},
                    ]
                )
            ]
        )

        with pytest.raises(WritingRefusedError) as error:
            run(ComposePost(store).compose(draft_id=DRAFT_ID, client=client))
        assert error.value.code == "duplicate_image_reference"

    def test_it_rejects_unusable_limits(self) -> None:
        with pytest.raises(ValueError, match="positive"):
            ComposePost(_Store(draft()), timeout_seconds=0)
        with pytest.raises(ValueError, match="positive"):
            ComposePost(_Store(draft()), max_output_tokens=0)

    def test_an_unknown_refusal_code_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="not a known writing refusal code"):
            WritingRefusedError("unknown")


class TestRefine:
    def test_it_stores_a_refined_revision_from_the_active_body(self) -> None:
        store = _Store(draft(revisions=(revision(),)))
        client = FakeStructuredClient(payloads=[composed()])

        run(ComposePost(store).refine(draft_id=DRAFT_ID, client=client, request="더 짧게"))

        recorded = store.revisions[0]
        assert recorded["kind"] is RevisionKind.REFINED
        assert recorded["status"] is DraftStatus.REFINING
        assert recorded["activate"] is True
        assert "이전 문단" in client.calls[0][1]
        assert "더 짧게" in client.calls[0][1]

    def test_refining_without_a_body_is_refused(self) -> None:
        store = _Store(draft())
        client = FakeStructuredClient(payloads=[composed()])

        with pytest.raises(WritingRefusedError) as error:
            run(ComposePost(store).refine(draft_id=DRAFT_ID, client=client))
        assert error.value.code == "no_active_revision"

    def test_a_whitespace_title_falls_back_to_the_previous_one(self) -> None:
        store = _Store(draft(revisions=(revision(),)))
        payload = composed()
        payload["title"] = "   제목 주변 공백   "
        client = FakeStructuredClient(payloads=[payload])

        run(ComposePost(store).refine(draft_id=DRAFT_ID, client=client))

        assert store.revisions[0]["title"] == "제목 주변 공백"


class TestTags:
    def test_it_stores_normalized_tags(self) -> None:
        store = _Store(draft(revisions=(revision(),)))
        client = FakeStructuredClient(payloads=[{"tags": ["#전시", "전시", "전시 후기", "요리!"]}])

        run(ComposePost(store).generate_tags(draft_id=DRAFT_ID, client=client))

        assert [tag.tag for tag in store.tags[0]] == ["전시", "전시후기"]

    def test_it_keeps_an_earlier_selection_state(self) -> None:
        store = _Store(
            draft(
                revisions=(revision(),),
                tags=(DraftTag(tag="전시", ordinal=0, selected=False),),
            )
        )
        client = FakeStructuredClient(payloads=[{"tags": ["전시", "기록"]}])

        run(ComposePost(store).generate_tags(draft_id=DRAFT_ID, client=client))

        stored = {tag.tag: tag.selected for tag in store.tags[0]}
        assert stored == {"전시": False, "기록": True}

    def test_it_keeps_tags_the_user_typed(self) -> None:
        store = _Store(
            draft(
                revisions=(revision(),),
                tags=(DraftTag(tag="내태그", ordinal=0, source=TagSource.USER),),
            )
        )
        client = FakeStructuredClient(payloads=[{"tags": ["전시"]}])

        run(ComposePost(store).generate_tags(draft_id=DRAFT_ID, client=client))

        assert [tag.tag for tag in store.tags[0]] == ["전시", "내태그"]
        assert store.tags[0][1].source is TagSource.USER

    def test_a_proposal_without_usable_tags_is_refused(self) -> None:
        store = _Store(draft(revisions=(revision(),)))
        client = FakeStructuredClient(payloads=[{"tags": ["!!!", "   "]}])

        with pytest.raises(WritingRefusedError) as error:
            run(ComposePost(store).generate_tags(draft_id=DRAFT_ID, client=client))
        assert error.value.code == "no_usable_tags"

    def test_tagging_without_a_body_is_refused(self) -> None:
        store = _Store(draft())
        client = FakeStructuredClient(payloads=[{"tags": ["전시"]}])

        with pytest.raises(WritingRefusedError) as error:
            run(ComposePost(store).generate_tags(draft_id=DRAFT_ID, client=client))
        assert error.value.code == "no_active_revision"
