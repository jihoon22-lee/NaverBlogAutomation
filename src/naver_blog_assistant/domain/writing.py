"""Post drafts, their revisions, and the block body they carry.

The body is a block array rather than HTML. The editor is driven block by block, a refinement diff
stays readable, and the same content can move to another editor later. Tags are normalized here so
a stored draft never holds a duplicate or an unusable tag.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from naver_blog_assistant.domain.models import DomainValidationError

MAX_DRAFT_TITLE_LENGTH = 300
MAX_BLOCK_TEXT_LENGTH = 4_000
MAX_BLOCKS = 200
MAX_SEED_LENGTH = 20_000
MAX_TAG_LENGTH = 30
MAX_TAGS = 50
MAX_IMAGES = 20
MAX_IMAGE_BYTES = 10 * 1024 * 1024
DEFAULT_BODY_TAG_CAP = 20
ALLOWED_IMAGE_MIMES = frozenset({"image/jpeg", "image/png", "image/webp", "image/gif"})
_TAG_ALLOWED = re.compile(r"^[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ_]+$")


class DraftStatus(StrEnum):
    """Lifecycle of one draft, forward-only except for an explicit abandon."""

    COLLECTING = "collecting"
    COMPOSED = "composed"
    REFINING = "refining"
    TAGGED = "tagged"
    STAGING = "staging"
    STAGED = "staged"
    ABANDONED = "abandoned"


class RevisionKind(StrEnum):
    """Where one revision came from."""

    SEED = "seed"
    COMPOSED = "composed"
    REFINED = "refined"
    USER_EDITED = "user_edited"


class BlockKind(StrEnum):
    """Block types the editor can reproduce."""

    HEADING = "heading"
    PARAGRAPH = "paragraph"
    QUOTE = "quote"
    IMAGE = "image"


class TagSource(StrEnum):
    """Whether a tag was generated or typed by the user."""

    GENERATED = "generated"
    USER = "user"


@dataclass(frozen=True, slots=True)
class BodyBlock:
    """One block of a draft body."""

    kind: BlockKind
    text: str = ""
    image_id: UUID | None = None
    caption: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.kind, BlockKind):
            raise DomainValidationError("kind must be a BlockKind")
        if self.kind is BlockKind.IMAGE:
            if self.image_id is None:
                raise DomainValidationError("an image block requires an image_id")
            if self.text:
                raise DomainValidationError("an image block carries a caption, not text")
            _bounded("caption", self.caption, MAX_BLOCK_TEXT_LENGTH, allow_empty=True)
            return
        if self.image_id is not None:
            raise DomainValidationError("only an image block may reference an image")
        if self.caption:
            raise DomainValidationError("only an image block may carry a caption")
        _bounded("text", self.text, MAX_BLOCK_TEXT_LENGTH)

    def to_payload(self) -> dict[str, Any]:
        """Return the storable form of this block."""
        if self.kind is BlockKind.IMAGE:
            return {
                "type": self.kind.value,
                "image_id": str(self.image_id),
                "caption": self.caption,
            }
        return {"type": self.kind.value, "text": self.text}

    @classmethod
    def from_payload(cls, payload: Any) -> BodyBlock:
        """Rebuild one block from stored or provider data, rejecting anything unusable."""
        if not isinstance(payload, dict):
            raise DomainValidationError("a block must be an object")
        raw_kind = payload.get("type")
        try:
            kind = BlockKind(raw_kind)
        except (TypeError, ValueError) as error:
            raise DomainValidationError(f"{raw_kind} is not a known block type") from error
        if kind is BlockKind.IMAGE:
            raw_id = payload.get("image_id")
            try:
                image_id = UUID(str(raw_id))
            except (TypeError, ValueError) as error:
                raise DomainValidationError("image_id must be a UUID") from error
            caption = payload.get("caption") or ""
            if not isinstance(caption, str):
                raise DomainValidationError("caption must be a string")
            return cls(kind=kind, image_id=image_id, caption=caption.strip())
        text = payload.get("text")
        if not isinstance(text, str):
            raise DomainValidationError("text must be a string")
        return cls(kind=kind, text=text.strip())


def parse_body(payload: Any) -> tuple[BodyBlock, ...]:
    """Validate a whole body, enforcing the block count limit."""
    if not isinstance(payload, list) or not payload:
        raise DomainValidationError("a body must be a non-empty array of blocks")
    if len(payload) > MAX_BLOCKS:
        raise DomainValidationError(f"a body must not exceed {MAX_BLOCKS} blocks")
    return tuple(BodyBlock.from_payload(entry) for entry in payload)


def body_payload(blocks: tuple[BodyBlock, ...]) -> list[dict[str, Any]]:
    """Return the storable form of a whole body."""
    return [block.to_payload() for block in blocks]


@dataclass(frozen=True, slots=True)
class DraftImage:
    """One uploaded image, stored on disk and referenced by path."""

    id: UUID
    draft_id: UUID
    ordinal: int
    stored_path: str
    original_filename: str
    byte_size: int
    mime: str
    alt_text: str = ""

    def __post_init__(self) -> None:
        if self.ordinal < 0:
            raise DomainValidationError("ordinal must not be negative")
        if self.mime not in ALLOWED_IMAGE_MIMES:
            raise DomainValidationError(f"{self.mime} is not an allowed image type")
        if not 0 < self.byte_size <= MAX_IMAGE_BYTES:
            raise DomainValidationError("image size must be between 1 byte and 10 MiB")
        if not self.stored_path.strip():
            raise DomainValidationError("stored_path must not be empty")
        _bounded("original_filename", self.original_filename, 255)
        _bounded("alt_text", self.alt_text, 300, allow_empty=True)


@dataclass(frozen=True, slots=True)
class DraftTag:
    """One tag attached to a draft."""

    tag: str
    ordinal: int
    source: TagSource = TagSource.GENERATED
    selected: bool = True

    def __post_init__(self) -> None:
        if self.ordinal < 0:
            raise DomainValidationError("ordinal must not be negative")
        if not isinstance(self.source, TagSource):
            raise DomainValidationError("source must be a TagSource")
        if normalize_tag(self.tag) != self.tag:
            raise DomainValidationError("tag must be normalized before use")


def normalize_tag(value: str) -> str:
    """Return the storable form of one tag, or an empty string when unusable."""
    if not isinstance(value, str):
        return ""
    folded = unicodedata.normalize("NFC", value).strip().lstrip("#")
    collapsed = re.sub(r"\s+", "", folded)
    if not collapsed or len(collapsed) > MAX_TAG_LENGTH:
        return ""
    return collapsed if _TAG_ALLOWED.match(collapsed) else ""


def normalize_tags(values: Any, *, source: TagSource = TagSource.GENERATED) -> tuple[DraftTag, ...]:
    """Normalize, deduplicate, and bound a whole tag list, keeping the first occurrence."""
    if not isinstance(values, list | tuple):
        raise DomainValidationError("tags must be a list")
    seen: set[str] = set()
    tags: list[DraftTag] = []
    for value in values:
        normalized = normalize_tag(value if isinstance(value, str) else "")
        if not normalized or normalized.casefold() in seen:
            continue
        seen.add(normalized.casefold())
        tags.append(DraftTag(tag=normalized, ordinal=len(tags), source=source))
        if len(tags) == MAX_TAGS:
            break
    return tuple(tags)


def body_tags(tags: tuple[DraftTag, ...], *, cap: int = DEFAULT_BODY_TAG_CAP) -> tuple[str, ...]:
    """Return the selected tags to append to the body, bounded by the configured cap."""
    if cap < 0:
        raise DomainValidationError("cap must not be negative")
    return tuple(tag.tag for tag in tags if tag.selected)[:cap]


@dataclass(frozen=True, slots=True)
class DraftRevision:
    """One version of a draft body."""

    id: UUID
    draft_id: UUID
    round_no: int
    kind: RevisionKind
    title: str
    blocks: tuple[BodyBlock, ...]
    summary: str = ""
    provider: str | None = None
    model: str | None = None
    is_active: bool = False
    created_at: datetime | None = None

    def __post_init__(self) -> None:
        if self.round_no < 0:
            raise DomainValidationError("round_no must not be negative")
        if not isinstance(self.kind, RevisionKind):
            raise DomainValidationError("kind must be a RevisionKind")
        _bounded("title", self.title, MAX_DRAFT_TITLE_LENGTH)
        if not self.blocks:
            raise DomainValidationError("a revision must contain at least one block")
        if len(self.blocks) > MAX_BLOCKS:
            raise DomainValidationError(f"a revision must not exceed {MAX_BLOCKS} blocks")
        _bounded("summary", self.summary, 800, allow_empty=True)
        if self.created_at is not None and self.created_at.tzinfo is None:
            raise DomainValidationError("created_at must be timezone-aware")


@dataclass(frozen=True, slots=True)
class PostDraft:
    """One post being written, with its revisions, images, and tags."""

    id: UUID
    title: str
    category_no: int | None = None
    status: DraftStatus = DraftStatus.COLLECTING
    use_image_vision: bool = False
    seed_text: str = ""
    revisions: tuple[DraftRevision, ...] = ()
    images: tuple[DraftImage, ...] = ()
    tags: tuple[DraftTag, ...] = field(default_factory=tuple)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    published_at: date | None = None

    def __post_init__(self) -> None:
        _bounded("title", self.title, MAX_DRAFT_TITLE_LENGTH)
        if self.category_no is not None and self.category_no < 0:
            raise DomainValidationError("category_no must not be negative")
        if not isinstance(self.status, DraftStatus):
            raise DomainValidationError("status must be a DraftStatus")
        if len(self.seed_text) > MAX_SEED_LENGTH:
            raise DomainValidationError(f"seed text must not exceed {MAX_SEED_LENGTH} characters")
        if len(self.images) > MAX_IMAGES:
            raise DomainValidationError(f"a draft must not exceed {MAX_IMAGES} images")
        if len(self.tags) > MAX_TAGS:
            raise DomainValidationError(f"a draft must not exceed {MAX_TAGS} tags")
        active = [revision for revision in self.revisions if revision.is_active]
        if len(active) > 1:
            raise DomainValidationError("only one revision may be active")

    @property
    def active_revision(self) -> DraftRevision | None:
        """Return the revision the user selected, or the newest one."""
        for revision in self.revisions:
            if revision.is_active:
                return revision
        return self.revisions[-1] if self.revisions else None

    @property
    def next_round(self) -> int:
        """Return the round number a new generation should use."""
        return max((revision.round_no for revision in self.revisions), default=0) + 1


def _bounded(field_name: str, value: str, maximum: int, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise DomainValidationError(f"{field_name} must be a string")
    normalized = value.strip()
    if not allow_empty and not normalized:
        raise DomainValidationError(f"{field_name} must not be empty")
    if len(normalized) > maximum:
        raise DomainValidationError(f"{field_name} must not exceed {maximum} characters")
    return normalized
