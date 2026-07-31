"""Count external actions per day so a daily cap can be enforced.

The ledger holds one row per (date, action) with a count, mirroring the date ledger that discovery
already uses for idempotent daily syncs.

Revision ID: 20260801_0018
Revises: 20260731_0017
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260801_0018"
down_revision: str | None = "20260731_0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ACTIONS = ("like", "comment", "mutual_neighbor")


def upgrade() -> None:
    """Add the activity ledger."""
    actions = ", ".join(f"'{action}'" for action in ACTIONS)
    op.create_table(
        "automation_activity_ledger",
        sa.Column("date", sa.String(length=10), primary_key=True),
        sa.Column("action", sa.String(length=16), primary_key=True),
        sa.Column("count", sa.Integer(), nullable=False),
        sa.CheckConstraint(f"action IN ({actions})", name="ck_activity_ledger_action"),
        sa.CheckConstraint("count >= 0", name="ck_activity_ledger_count"),
        sa.CheckConstraint("length(date) = 10", name="ck_activity_ledger_date"),
    )


def downgrade() -> None:
    """Remove the activity ledger."""
    op.drop_table("automation_activity_ledger")
