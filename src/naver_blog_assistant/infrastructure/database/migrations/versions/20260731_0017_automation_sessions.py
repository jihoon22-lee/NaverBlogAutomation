"""Add session-scoped batches and mark existing runs as manual.

One approval can cover several queued posts. Existing rows keep working because `session_id` is
nullable and `trigger` is backfilled to `manual`.

Revision ID: 20260731_0017
Revises: 20260731_0016
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260731_0017"
down_revision: str | None = "20260731_0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TRIGGERS = ("manual", "session", "schedule")
SESSION_STATES = ("pending", "running", "completed", "aborted", "cancelled")


def upgrade() -> None:
    """Create the session table and link runs to it."""
    triggers = _allowed("trigger", TRIGGERS)
    op.create_table(
        "automation_sessions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("trigger", sa.String(length=16), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("approved_steps_json", sa.Text(), nullable=False),
        sa.Column("max_posts", sa.Integer(), nullable=False),
        sa.Column("source_filter_json", sa.Text(), nullable=False),
        sa.Column("processed_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("started_at", sa.String(length=32), nullable=True),
        sa.Column("finished_at", sa.String(length=32), nullable=True),
        sa.Column("abort_reason", sa.String(length=64), nullable=True),
        sa.CheckConstraint(triggers, name="ck_automation_sessions_trigger"),
        sa.CheckConstraint(_allowed("state", SESSION_STATES), name="ck_automation_sessions_state"),
        sa.CheckConstraint("max_posts >= 1", name="ck_automation_sessions_max_posts"),
        sa.CheckConstraint("processed_count >= 0", name="ck_automation_sessions_processed"),
    )
    with op.batch_alter_table("engagement_runs") as batch:
        batch.add_column(sa.Column("session_id", sa.String(length=36), nullable=True))
        batch.add_column(
            sa.Column("trigger", sa.String(length=16), nullable=False, server_default="manual")
        )
    op.execute("UPDATE engagement_runs SET trigger = 'manual' WHERE trigger IS NULL")
    op.create_index("ix_engagement_runs_session", "engagement_runs", ["session_id"])


def downgrade() -> None:
    """Unlink runs from sessions and drop the session table."""
    op.drop_index("ix_engagement_runs_session", table_name="engagement_runs")
    with op.batch_alter_table("engagement_runs") as batch:
        batch.drop_column("trigger")
        batch.drop_column("session_id")
    op.drop_table("automation_sessions")


def _allowed(column: str, values: Sequence[str]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"
