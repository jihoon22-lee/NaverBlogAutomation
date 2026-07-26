"""Add local discovery queue, saved searches, and digest settings.

Revision ID: 20260726_0006
Revises: 20260723_0005
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260726_0006"
down_revision: str | None = "20260723_0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create bounded metadata-only discovery tables."""
    op.create_table(
        "neighbor_blogs",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("blog_url", sa.Text(), nullable=False, unique=True),
        sa.Column("blog_id", sa.String(length=100), nullable=False, unique=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("feed_status", sa.String(length=16), nullable=False, server_default="unknown"),
        sa.Column("last_checked_at", sa.String(length=32), nullable=True),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.CheckConstraint(
            "feed_status IN ('ready', 'unavailable', 'unknown')", name="ck_neighbor_feed_status"
        ),
    )
    op.create_table(
        "saved_searches",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("query", sa.String(length=120), nullable=False, unique=True),
        sa.Column("excluded_terms_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("freshness_days", sa.Integer(), nullable=False, server_default="14"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.CheckConstraint(
            "freshness_days BETWEEN 1 AND 90", name="ck_saved_search_freshness_days"
        ),
    )
    op.create_table(
        "discovered_posts",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False, server_default="queued"),
        sa.Column("source_url", sa.Text(), nullable=False, unique=True),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("publisher_name", sa.String(length=120), nullable=True),
        sa.Column("published_at", sa.String(length=32), nullable=True),
        sa.Column(
            "neighbor_id",
            sa.String(length=36),
            sa.ForeignKey("neighbor_blogs.id", ondelete="SET NULL"),
        ),
        sa.Column(
            "search_id",
            sa.String(length=36),
            sa.ForeignKey("saved_searches.id", ondelete="SET NULL"),
        ),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.String(length=32), nullable=False),
        sa.CheckConstraint("source IN ('neighbor', 'search')", name="ck_discovered_posts_source"),
        sa.CheckConstraint(
            "state IN ('queued', 'opened', 'completed', 'skipped', 'unavailable')",
            name="ck_discovered_posts_state",
        ),
    )
    op.create_table(
        "digest_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("timezone", sa.String(length=64), nullable=False, server_default="Asia/Seoul"),
        sa.Column("hour", sa.Integer(), nullable=False, server_default="9"),
        sa.Column("minute", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("email_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.CheckConstraint("id = 1", name="ck_digest_settings_singleton"),
        sa.CheckConstraint("hour BETWEEN 0 AND 23", name="ck_digest_hour"),
        sa.CheckConstraint("minute BETWEEN 0 AND 59", name="ck_digest_minute"),
    )
    op.create_table(
        "digest_runs",
        sa.Column("local_date", sa.String(length=10), primary_key=True),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("neighbor_post_count", sa.Integer(), nullable=False),
        sa.Column("email_sent", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    """Drop discovery metadata only; recommendation history is unaffected."""
    op.drop_table("digest_runs")
    op.drop_table("digest_settings")
    op.drop_table("discovered_posts")
    op.drop_table("saved_searches")
    op.drop_table("neighbor_blogs")
