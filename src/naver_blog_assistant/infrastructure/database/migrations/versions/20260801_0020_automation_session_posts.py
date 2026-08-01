"""Persist the exact discovery-post order approved for each batch.

Revision ID: 20260801_0020
Revises: 20260801_0019
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260801_0020"
down_revision: str | None = "20260801_0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Store one immutable, ordered queue snapshot for every new session."""
    op.create_table(
        "automation_session_posts",
        sa.Column(
            "session_id",
            sa.String(length=36),
            sa.ForeignKey("automation_sessions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "post_id",
            sa.String(length=36),
            sa.ForeignKey("discovered_posts.id", ondelete="CASCADE"),
            nullable=False,
            primary_key=True,
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.UniqueConstraint("session_id", "position", name="uq_automation_session_posts_position"),
        sa.CheckConstraint(
            "position BETWEEN 0 AND 49", name="ck_automation_session_posts_position"
        ),
    )


def downgrade() -> None:
    """Drop the per-session snapshot table."""
    op.drop_table("automation_session_posts")
