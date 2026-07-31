"""Compose, refine, and tag one post draft.

Every provider call goes through the same structured completion port, so a draft can be written by
any configured provider. Generated bodies are validated against the draft's own images: a block may
only reference an image that was actually uploaded.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID, uuid4

from naver_blog_assistant.application.errors import ApplicationError
from naver_blog_assistant.domain.writing import (
    MAX_TAGS,
    BlockKind,
    BodyBlock,
    DraftRevision,
    DraftStatus,
    DraftTag,
    PostDraft,
    RevisionKind,
    TagSource,
    body_payload,
    normalize_tags,
)
from naver_blog_assistant.infrastructure.generators.writing_prompt import (
    REFINE_INSTRUCTIONS,
    TAG_INSTRUCTIONS,
    ComposedPost,
    GeneratedTags,
    compose_input,
    compose_instructions,
    refine_input,
    tag_input,
)
from naver_blog_assistant.ports.llm import StructuredCompletion

DEFAULT_TIMEOUT_SECONDS = 90.0
DEFAULT_MAX_OUTPUT_TOKENS = 8_000
MAX_REFERENCE_BODY_LENGTH = 4_000


class WritingRefusedError(ApplicationError):
    """Raised with a stable code when a draft cannot be composed or refined."""

    CODES = frozenset(
        {
            "seed_text_missing",
            "no_active_revision",
            "unknown_image_reference",
            "duplicate_image_reference",
            "no_usable_tags",
        }
    )

    def __init__(self, code: str) -> None:
        if code not in self.CODES:
            raise ValueError(f"{code} is not a known writing refusal code")
        super().__init__(code)
        self.code = code


class DraftStore(Protocol):
    """The subset of the draft repository these use cases need."""

    def get(self, draft_id: UUID) -> PostDraft: ...

    def add_revision(
        self,
        *,
        draft_id: UUID,
        revision_id: UUID,
        round_no: int,
        kind: RevisionKind,
        title: str,
        blocks: Sequence[BodyBlock],
        summary: str = "",
        provider: str | None = None,
        model: str | None = None,
        activate: bool = False,
        status: DraftStatus | None = None,
    ) -> PostDraft: ...

    def replace_tags(self, draft_id: UUID, tags: Sequence[DraftTag]) -> PostDraft: ...


@dataclass(frozen=True, slots=True)
class ReferenceBody:
    """One of the author's own posts used as a style reference."""

    title: str
    body: str

    def to_payload(self) -> dict[str, str]:
        """Return the truncated form sent to the provider."""
        return {"body": self.body[:MAX_REFERENCE_BODY_LENGTH], "title": self.title}


@dataclass(frozen=True, slots=True)
class WritingOptions:
    """Validated generation options for one composition."""

    length: str = "medium"
    tone: str = "warm"
    structure: str = "sectioned"


class ComposePost:
    """Write one draft body from its seed text and the author's own style."""

    def __init__(
        self,
        store: DraftStore,
        *,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
    ) -> None:
        if timeout_seconds <= 0 or max_output_tokens < 1:
            raise ValueError("writing timeout and output token limit must be positive")
        self._store = store
        self._timeout_seconds = timeout_seconds
        self._max_output_tokens = max_output_tokens

    async def compose(
        self,
        *,
        draft_id: UUID,
        client: StructuredCompletion,
        references: Sequence[ReferenceBody] = (),
        options: WritingOptions | None = None,
        round_no: int | None = None,
        activate: bool = True,
    ) -> PostDraft:
        """Generate one body for the draft and store it as a new revision."""
        draft = self._store.get(draft_id)
        if not draft.seed_text.strip():
            raise WritingRefusedError("seed_text_missing")
        resolved = options or WritingOptions()
        parsed = await self._call(
            client,
            instructions=compose_instructions(
                length=resolved.length, tone=resolved.tone, structure=resolved.structure
            ),
            input_text=compose_input(
                seed_text=draft.seed_text,
                references=tuple(reference.to_payload() for reference in references),
                images=tuple(
                    {"alt_text": image.alt_text, "image_id": str(image.id)}
                    for image in draft.images
                ),
            ),
            schema=ComposedPost,
        )
        blocks = _blocks_for(draft, parsed)
        return self._store.add_revision(
            draft_id=draft_id,
            revision_id=uuid4(),
            round_no=round_no if round_no is not None else draft.next_round,
            kind=RevisionKind.COMPOSED,
            title=parsed.title.strip(),
            blocks=blocks,
            summary=parsed.summary.strip(),
            provider=client.provider.value,
            model=client.model,
            activate=activate,
            status=DraftStatus.COMPOSED,
        )

    async def refine(
        self,
        *,
        draft_id: UUID,
        client: StructuredCompletion,
        request: str = "",
    ) -> PostDraft:
        """Refine the active body and store the result as a new revision."""
        draft = self._store.get(draft_id)
        active = draft.active_revision
        if active is None:
            raise WritingRefusedError("no_active_revision")
        parsed = await self._call(
            client,
            instructions=REFINE_INSTRUCTIONS,
            input_text=refine_input(
                blocks=body_payload(active.blocks), request=request.strip()[:2_000]
            ),
            schema=ComposedPost,
        )
        blocks = _blocks_for(draft, parsed)
        return self._store.add_revision(
            draft_id=draft_id,
            revision_id=uuid4(),
            round_no=draft.next_round,
            kind=RevisionKind.REFINED,
            title=parsed.title.strip() or active.title,
            blocks=blocks,
            summary=parsed.summary.strip(),
            provider=client.provider.value,
            model=client.model,
            activate=True,
            status=DraftStatus.REFINING,
        )

    async def generate_tags(self, *, draft_id: UUID, client: StructuredCompletion) -> PostDraft:
        """Propose tags for the active body, keeping the user's earlier selection."""
        draft = self._store.get(draft_id)
        active = draft.active_revision
        if active is None:
            raise WritingRefusedError("no_active_revision")
        parsed = await self._call(
            client,
            instructions=TAG_INSTRUCTIONS,
            input_text=tag_input(title=active.title, blocks=body_payload(active.blocks)),
            schema=GeneratedTags,
        )
        proposed = normalize_tags(list(parsed.tags))
        if not proposed:
            raise WritingRefusedError("no_usable_tags")
        return self._store.replace_tags(
            draft_id, _merge_tags(previous=draft.tags, proposed=proposed)
        )

    async def _call(
        self,
        client: StructuredCompletion,
        *,
        instructions: str,
        input_text: str,
        schema: type[Any],
    ) -> Any:
        return await asyncio.to_thread(
            client.structured,
            instructions=instructions,
            input_text=input_text,
            schema=schema,
            timeout_seconds=self._timeout_seconds,
            max_output_tokens=self._max_output_tokens,
        )


def _blocks_for(draft: PostDraft, parsed: ComposedPost) -> tuple[BodyBlock, ...]:
    """Validate generated blocks against the draft's own images."""
    known = {str(image.id) for image in draft.images}
    used: set[str] = set()
    blocks: list[BodyBlock] = []
    for block in parsed.blocks:
        if block.type != "image":
            blocks.append(BodyBlock(kind=BlockKind(block.type), text=block.text.strip()))
            continue
        if block.image_id not in known:
            raise WritingRefusedError("unknown_image_reference")
        if block.image_id in used:
            raise WritingRefusedError("duplicate_image_reference")
        used.add(block.image_id)
        blocks.append(
            BodyBlock(
                kind=BlockKind.IMAGE,
                image_id=UUID(block.image_id),
                caption=block.caption.strip(),
            )
        )
    return tuple(blocks)


def _merge_tags(
    *, previous: tuple[DraftTag, ...], proposed: tuple[DraftTag, ...]
) -> tuple[DraftTag, ...]:
    """Keep the user's selection state and any tag the user typed."""
    chosen = {tag.tag.casefold(): tag for tag in previous}
    merged: list[DraftTag] = []
    for tag in proposed:
        earlier = chosen.get(tag.tag.casefold())
        merged.append(
            DraftTag(
                tag=tag.tag,
                ordinal=len(merged),
                source=tag.source,
                selected=True if earlier is None else earlier.selected,
            )
        )
    for tag in previous:
        if tag.source is not TagSource.USER or len(merged) >= MAX_TAGS:
            continue
        if any(existing.tag.casefold() == tag.tag.casefold() for existing in merged):
            continue
        merged.append(
            DraftTag(tag=tag.tag, ordinal=len(merged), source=TagSource.USER, selected=tag.selected)
        )
    return tuple(merged)


def revision_payload(revision: DraftRevision) -> list[dict[str, Any]]:
    """Return the storable body of one revision."""
    return body_payload(revision.blocks)
