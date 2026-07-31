"""Store post drafts, their revisions, uploaded images, and tags.

Image bytes stay on disk in the runtime directory; only the path is stored here.

Revision ID: 20260731_0014
Revises: 20260731_0013
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260731_0014"
down_revision: str | None = "20260731_0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUSES = (
    "collecting",
    "composed",
    "refining",
    "tagged",
    "staging",
    "staged",
    "abandoned",
)
REVISION_KINDS = ("seed", "composed", "refined", "user_edited")
TAG_SOURCES = ("generated", "user")


def upgrade() -> None:
    """Add the draft tables."""
    op.create_table(
        "post_drafts",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("category_no", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("use_image_vision", sa.Boolean(), nullable=False),
        sa.Column("seed_text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.String(length=32), nullable=False),
        sa.CheckConstraint(_allowed("status", STATUSES), name="ck_post_drafts_status"),
        sa.CheckConstraint("length(title) > 0", name="ck_post_drafts_title"),
        sa.CheckConstraint(
            "category_no IS NULL OR category_no >= 0", name="ck_post_drafts_category_no"
        ),
    )
    op.create_table(
        "post_draft_revisions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "draft_id",
            sa.String(length=36),
            sa.ForeignKey("post_drafts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("round_no", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=True),
        sa.Column("model", sa.String(length=100), nullable=True),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("body_blocks_json", sa.Text(), nullable=False),
        sa.Column("summary", sa.String(length=800), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.CheckConstraint("round_no >= 0", name="ck_post_draft_revisions_round"),
        sa.CheckConstraint(_allowed("kind", REVISION_KINDS), name="ck_post_draft_revisions_kind"),
        sa.CheckConstraint("length(body_blocks_json) > 0", name="ck_post_draft_revisions_body"),
        sa.UniqueConstraint(
            "draft_id", "round_no", "provider", "model", name="uq_post_draft_revision_round"
        ),
    )
    op.create_index(
        "ix_post_draft_revisions_draft", "post_draft_revisions", ["draft_id", "round_no"]
    )
    op.create_table(
        "post_draft_images",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "draft_id",
            sa.String(length=36),
            sa.ForeignKey("post_drafts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("stored_path", sa.String(length=1024), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("mime", sa.String(length=64), nullable=False),
        sa.Column("alt_text", sa.String(length=300), nullable=False),
        sa.CheckConstraint("ordinal >= 0", name="ck_post_draft_images_ordinal"),
        sa.CheckConstraint("byte_size > 0", name="ck_post_draft_images_size"),
        sa.UniqueConstraint("draft_id", "ordinal", name="uq_post_draft_images_ordinal"),
    )
    op.create_table(
        "post_draft_tags",
        sa.Column(
            "draft_id",
            sa.String(length=36),
            sa.ForeignKey("post_drafts.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("tag", sa.String(length=30), primary_key=True),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("selected", sa.Boolean(), nullable=False),
        sa.CheckConstraint("ordinal >= 0", name="ck_post_draft_tags_ordinal"),
        sa.CheckConstraint("length(tag) > 0", name="ck_post_draft_tags_tag"),
        sa.CheckConstraint(_allowed("source", TAG_SOURCES), name="ck_post_draft_tags_source"),
    )


def downgrade() -> None:
    """Remove the draft tables; stored image files are cleaned up separately."""
    op.drop_table("post_draft_tags")
    op.drop_table("post_draft_images")
    op.drop_index("ix_post_draft_revisions_draft", table_name="post_draft_revisions")
    op.drop_table("post_draft_revisions")
    op.drop_table("post_drafts")


def _allowed(column: str, values: Sequence[str]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"
