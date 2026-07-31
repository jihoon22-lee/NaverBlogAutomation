"""SQLite persistence for post drafts.

One draft is written and read as a whole: revisions, images, and tags always travel with it, so a
caller cannot observe a half-updated draft. Image bytes live in the runtime directory and only the
path is stored here.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.engine import Engine

from naver_blog_assistant.domain.writing import (
    BodyBlock,
    DraftImage,
    DraftRevision,
    DraftStatus,
    DraftTag,
    PostDraft,
    RevisionKind,
    TagSource,
    body_payload,
    parse_body,
)
from naver_blog_assistant.infrastructure.database.schema import (
    post_draft_images,
    post_draft_revisions,
    post_draft_tags,
    post_drafts,
)


class DraftNotFoundError(LookupError):
    """Raised when a draft id does not exist."""

    def __init__(self, draft_id: UUID) -> None:
        super().__init__(f"draft {draft_id} was not found")
        self.draft_id = draft_id


class SqlitePostDraftRepository:
    """Create, read, and update whole drafts."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def create(
        self,
        *,
        draft_id: UUID,
        title: str,
        seed_text: str,
        category_no: int | None,
        use_image_vision: bool,
    ) -> PostDraft:
        """Insert one draft with no revisions yet."""
        now = datetime.now(UTC)
        with self._engine.begin() as connection:
            connection.execute(
                post_drafts.insert().values(
                    id=str(draft_id),
                    title=title,
                    category_no=category_no,
                    status=DraftStatus.COLLECTING.value,
                    use_image_vision=use_image_vision,
                    seed_text=seed_text,
                    created_at=now.isoformat(),
                    updated_at=now.isoformat(),
                )
            )
        return self.get(draft_id)

    def get(self, draft_id: UUID) -> PostDraft:
        """Return one whole draft, raising when it does not exist."""
        with self._engine.connect() as connection:
            row = connection.execute(
                select(post_drafts).where(post_drafts.c.id == str(draft_id))
            ).one_or_none()
            if row is None:
                raise DraftNotFoundError(draft_id)
            revisions = connection.execute(
                select(post_draft_revisions)
                .where(post_draft_revisions.c.draft_id == str(draft_id))
                .order_by(post_draft_revisions.c.round_no, post_draft_revisions.c.created_at)
            ).all()
            images = connection.execute(
                select(post_draft_images)
                .where(post_draft_images.c.draft_id == str(draft_id))
                .order_by(post_draft_images.c.ordinal)
            ).all()
            tags = connection.execute(
                select(post_draft_tags)
                .where(post_draft_tags.c.draft_id == str(draft_id))
                .order_by(post_draft_tags.c.ordinal)
            ).all()
        return PostDraft(
            id=draft_id,
            title=row.title,
            category_no=None if row.category_no is None else int(row.category_no),
            status=DraftStatus(row.status),
            use_image_vision=bool(row.use_image_vision),
            seed_text=row.seed_text,
            revisions=tuple(_revision(entry) for entry in revisions),
            images=tuple(_image(entry) for entry in images),
            tags=tuple(_tag(entry) for entry in tags),
            created_at=datetime.fromisoformat(row.created_at),
            updated_at=datetime.fromisoformat(row.updated_at),
        )

    def list(self, *, limit: int = 50) -> tuple[PostDraft, ...]:
        """Return the newest drafts, newest first."""
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(post_drafts.c.id)
                .order_by(post_drafts.c.created_at.desc())
                .limit(max(1, limit))
            ).all()
        return tuple(self.get(UUID(row.id)) for row in rows)

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
    ) -> PostDraft:
        """Append one revision and optionally make it the active one."""
        now = datetime.now(UTC)
        with self._engine.begin() as connection:
            if (
                connection.execute(
                    select(post_drafts.c.id).where(post_drafts.c.id == str(draft_id))
                ).one_or_none()
                is None
            ):
                raise DraftNotFoundError(draft_id)
            if activate:
                connection.execute(
                    update(post_draft_revisions)
                    .where(post_draft_revisions.c.draft_id == str(draft_id))
                    .values(is_active=False)
                )
            connection.execute(
                post_draft_revisions.insert().values(
                    id=str(revision_id),
                    draft_id=str(draft_id),
                    round_no=round_no,
                    kind=kind.value,
                    provider=provider,
                    model=model,
                    title=title,
                    body_blocks_json=json.dumps(
                        body_payload(tuple(blocks)), ensure_ascii=False, sort_keys=True
                    ),
                    summary=summary,
                    is_active=activate,
                    created_at=now.isoformat(),
                )
            )
            values: dict[str, object] = {"updated_at": now.isoformat()}
            if status is not None:
                values["status"] = status.value
            connection.execute(
                update(post_drafts).where(post_drafts.c.id == str(draft_id)).values(**values)
            )
        return self.get(draft_id)

    def activate_revision(self, draft_id: UUID, revision_id: UUID) -> PostDraft:
        """Select one revision as the active body."""
        with self._engine.begin() as connection:
            owned = connection.execute(
                select(post_draft_revisions.c.id).where(
                    post_draft_revisions.c.id == str(revision_id),
                    post_draft_revisions.c.draft_id == str(draft_id),
                )
            ).one_or_none()
            if owned is None:
                raise DraftNotFoundError(revision_id)
            connection.execute(
                update(post_draft_revisions)
                .where(post_draft_revisions.c.draft_id == str(draft_id))
                .values(is_active=False)
            )
            connection.execute(
                update(post_draft_revisions)
                .where(post_draft_revisions.c.id == str(revision_id))
                .values(is_active=True)
            )
            connection.execute(
                update(post_drafts)
                .where(post_drafts.c.id == str(draft_id))
                .values(updated_at=datetime.now(UTC).isoformat())
            )
        return self.get(draft_id)

    def update_draft(
        self,
        draft_id: UUID,
        *,
        title: str | None = None,
        category_no: int | None = None,
        status: DraftStatus | None = None,
        use_image_vision: bool | None = None,
    ) -> PostDraft:
        """Change the stored draft fields the user may edit."""
        values: dict[str, object] = {"updated_at": datetime.now(UTC).isoformat()}
        if title is not None:
            values["title"] = title
        if category_no is not None:
            values["category_no"] = category_no
        if status is not None:
            values["status"] = status.value
        if use_image_vision is not None:
            values["use_image_vision"] = use_image_vision
        with self._engine.begin() as connection:
            result = connection.execute(
                update(post_drafts).where(post_drafts.c.id == str(draft_id)).values(**values)
            )
            if result.rowcount == 0:
                raise DraftNotFoundError(draft_id)
        return self.get(draft_id)

    def add_image(self, image: DraftImage) -> PostDraft:
        """Attach one uploaded image at the next free ordinal."""
        with self._engine.begin() as connection:
            if (
                connection.execute(
                    select(post_drafts.c.id).where(post_drafts.c.id == str(image.draft_id))
                ).one_or_none()
                is None
            ):
                raise DraftNotFoundError(image.draft_id)
            connection.execute(
                post_draft_images.insert().values(
                    id=str(image.id),
                    draft_id=str(image.draft_id),
                    ordinal=image.ordinal,
                    stored_path=image.stored_path,
                    original_filename=image.original_filename,
                    byte_size=image.byte_size,
                    mime=image.mime,
                    alt_text=image.alt_text,
                )
            )
        return self.get(image.draft_id)

    def remove_image(self, draft_id: UUID, image_id: UUID) -> tuple[PostDraft, str | None]:
        """Detach one image and report the stored path the caller must delete."""
        with self._engine.begin() as connection:
            row = connection.execute(
                select(post_draft_images.c.stored_path).where(
                    post_draft_images.c.id == str(image_id),
                    post_draft_images.c.draft_id == str(draft_id),
                )
            ).one_or_none()
            if row is None:
                raise DraftNotFoundError(image_id)
            connection.execute(
                delete(post_draft_images).where(post_draft_images.c.id == str(image_id))
            )
        return self.get(draft_id), row.stored_path

    def next_image_ordinal(self, draft_id: UUID) -> int:
        """Return the ordinal one past the last stored image."""
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(post_draft_images.c.ordinal).where(
                    post_draft_images.c.draft_id == str(draft_id)
                )
            ).all()
        return max((int(row.ordinal) for row in rows), default=-1) + 1

    def replace_tags(self, draft_id: UUID, tags: Sequence[DraftTag]) -> PostDraft:
        """Replace the whole tag list for one draft."""
        with self._engine.begin() as connection:
            if (
                connection.execute(
                    select(post_drafts.c.id).where(post_drafts.c.id == str(draft_id))
                ).one_or_none()
                is None
            ):
                raise DraftNotFoundError(draft_id)
            connection.execute(
                delete(post_draft_tags).where(post_draft_tags.c.draft_id == str(draft_id))
            )
            for tag in tags:
                connection.execute(
                    post_draft_tags.insert().values(
                        draft_id=str(draft_id),
                        tag=tag.tag,
                        ordinal=tag.ordinal,
                        source=tag.source.value,
                        selected=tag.selected,
                    )
                )
            connection.execute(
                update(post_drafts)
                .where(post_drafts.c.id == str(draft_id))
                .values(updated_at=datetime.now(UTC).isoformat())
            )
        return self.get(draft_id)

    def delete(self, draft_id: UUID) -> tuple[str, ...]:
        """Remove one draft and report the image paths the caller must delete."""
        with self._engine.begin() as connection:
            paths = tuple(
                row.stored_path
                for row in connection.execute(
                    select(post_draft_images.c.stored_path).where(
                        post_draft_images.c.draft_id == str(draft_id)
                    )
                ).all()
            )
            connection.execute(
                delete(post_draft_tags).where(post_draft_tags.c.draft_id == str(draft_id))
            )
            connection.execute(
                delete(post_draft_images).where(post_draft_images.c.draft_id == str(draft_id))
            )
            connection.execute(
                delete(post_draft_revisions).where(post_draft_revisions.c.draft_id == str(draft_id))
            )
            result = connection.execute(
                delete(post_drafts).where(post_drafts.c.id == str(draft_id))
            )
            if result.rowcount == 0:
                raise DraftNotFoundError(draft_id)
        return paths


def _revision(row: Any) -> DraftRevision:
    return DraftRevision(
        id=UUID(row.id),
        draft_id=UUID(row.draft_id),
        round_no=int(row.round_no),
        kind=RevisionKind(row.kind),
        title=row.title,
        blocks=parse_body(json.loads(row.body_blocks_json)),
        summary=row.summary,
        provider=row.provider,
        model=row.model,
        is_active=bool(row.is_active),
        created_at=datetime.fromisoformat(row.created_at),
    )


def _image(row: Any) -> DraftImage:
    return DraftImage(
        id=UUID(row.id),
        draft_id=UUID(row.draft_id),
        ordinal=int(row.ordinal),
        stored_path=row.stored_path,
        original_filename=row.original_filename,
        byte_size=int(row.byte_size),
        mime=row.mime,
        alt_text=row.alt_text,
    )


def _tag(row: Any) -> DraftTag:
    return DraftTag(
        tag=row.tag,
        ordinal=int(row.ordinal),
        source=TagSource(row.source),
        selected=bool(row.selected),
    )


__all__ = ["DraftNotFoundError", "SqlitePostDraftRepository"]
