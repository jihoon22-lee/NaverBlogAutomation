"""Persist one approved engagement run and its ordered browser-action states.

Revision ID: 20260728_0009
Revises: 20260728_0008
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260728_0009"
down_revision: str | None = "20260728_0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add source-linked runs without storing URLs, comments, or application messages."""
    op.create_table(
        "engagement_runs",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("approval_id", sa.String(length=36), nullable=False, unique=True),
        sa.Column(
            "discovery_post_id",
            sa.String(length=36),
            sa.ForeignKey("discovered_posts.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "recommendation_id",
            sa.String(length=36),
            sa.ForeignKey("recommendations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.String(length=32), nullable=False),
        sa.CheckConstraint("source IN ('neighbor', 'search')", name="ck_engagement_runs_source"),
        sa.CheckConstraint(
            "state IN ('running', 'succeeded', 'failed', 'unconfirmed')",
            name="ck_engagement_runs_state",
        ),
    )
    op.create_table(
        "engagement_steps",
        sa.Column(
            "run_id",
            sa.String(length=36),
            sa.ForeignKey("engagement_runs.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("name", sa.String(length=32), primary_key=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("result_code", sa.String(length=64)),
        sa.Column("updated_at", sa.String(length=32), nullable=False),
        sa.UniqueConstraint("run_id", "position", name="uq_engagement_steps_position"),
        sa.CheckConstraint(
            "name IN ('like', 'comment', 'mutual_neighbor')",
            name="ck_engagement_steps_name",
        ),
        sa.CheckConstraint("position BETWEEN 0 AND 2", name="ck_engagement_steps_position"),
        sa.CheckConstraint(
            "state IN ('pending', 'running', 'succeeded', 'skipped', 'failed', 'unconfirmed')",
            name="ck_engagement_steps_state",
        ),
        sa.CheckConstraint(
            "(state IN ('pending', 'running') AND result_code IS NULL) OR "
            "(state IN ('succeeded', 'skipped', 'failed', 'unconfirmed') "
            "AND result_code IS NOT NULL)",
            name="ck_engagement_steps_result",
        ),
    )


def downgrade() -> None:
    """Remove engagement state before its source records."""
    op.drop_table("engagement_steps")
    op.drop_table("engagement_runs")
