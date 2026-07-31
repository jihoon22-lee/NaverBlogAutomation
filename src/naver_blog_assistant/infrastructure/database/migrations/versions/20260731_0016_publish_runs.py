"""Track one staging run per draft with the same step state machine as engagements.

Revision ID: 20260731_0016
Revises: 20260731_0015
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260731_0016"
down_revision: str | None = "20260731_0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RUN_STATES = ("running", "succeeded", "failed", "unconfirmed")
STEP_NAMES = ("title", "body", "images", "tags", "save")
STEP_STATES = ("pending", "running", "succeeded", "skipped", "failed", "unconfirmed")


def upgrade() -> None:
    """Add the staging run tables."""
    op.create_table(
        "publish_runs",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("draft_id", sa.String(length=36), nullable=False),
        sa.Column("revision_id", sa.String(length=36), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("result_code", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.String(length=32), nullable=False),
        sa.CheckConstraint(_allowed("state", RUN_STATES), name="ck_publish_runs_state"),
        sa.UniqueConstraint("draft_id", "revision_id", name="uq_publish_runs_revision"),
    )
    op.create_table(
        "publish_run_steps",
        sa.Column(
            "run_id",
            sa.String(length=36),
            sa.ForeignKey("publish_runs.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("name", sa.String(length=16), primary_key=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("result_code", sa.String(length=64), nullable=True),
        sa.Column("updated_at", sa.String(length=32), nullable=False),
        sa.CheckConstraint(_allowed("name", STEP_NAMES), name="ck_publish_run_steps_name"),
        sa.CheckConstraint(_allowed("state", STEP_STATES), name="ck_publish_run_steps_state"),
        sa.CheckConstraint("position >= 0 AND position <= 4", name="ck_publish_run_steps_position"),
        sa.UniqueConstraint("run_id", "position", name="uq_publish_run_steps_position"),
    )


def downgrade() -> None:
    """Remove the staging run tables."""
    op.drop_table("publish_run_steps")
    op.drop_table("publish_runs")


def _allowed(column: str, values: Sequence[str]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"
