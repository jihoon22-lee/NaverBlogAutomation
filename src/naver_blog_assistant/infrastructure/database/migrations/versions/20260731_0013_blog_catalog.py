"""Cache the author's own category tree and post metadata.

Only metadata is stored. A reference body is read again at generation time and never persisted.

Revision ID: 20260731_0013
Revises: 20260731_0012
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260731_0013"
down_revision: str | None = "20260731_0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the own-blog catalog tables."""
    op.create_table(
        "blog_categories",
        sa.Column("category_no", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("post_count", sa.Integer(), nullable=True),
        sa.Column("synced_at", sa.String(length=32), nullable=False),
        sa.CheckConstraint("category_no >= 0", name="ck_blog_categories_no"),
        sa.CheckConstraint("length(name) > 0", name="ck_blog_categories_name"),
        sa.CheckConstraint(
            "post_count IS NULL OR post_count >= 0", name="ck_blog_categories_post_count"
        ),
    )
    op.create_table(
        "blog_reference_posts",
        sa.Column("source_url", sa.String(length=2048), primary_key=True),
        sa.Column("category_no", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("published_at", sa.String(length=10), nullable=True),
        sa.Column("synced_at", sa.String(length=32), nullable=False),
        sa.CheckConstraint("category_no >= 0", name="ck_blog_reference_category_no"),
        sa.CheckConstraint("length(title) > 0", name="ck_blog_reference_title"),
    )
    op.create_index(
        "ix_blog_reference_category", "blog_reference_posts", ["category_no", "published_at"]
    )


def downgrade() -> None:
    """Remove the cached catalog; nothing else depends on it."""
    op.drop_index("ix_blog_reference_category", table_name="blog_reference_posts")
    op.drop_table("blog_reference_posts")
    op.drop_table("blog_categories")
