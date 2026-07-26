"""Add opt-in automated public discovery settings.

Revision ID: 20260727_0007
Revises: 20260726_0006
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260727_0007"
down_revision: str | None = "20260726_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the singleton schedule and date idempotency ledger."""
    op.create_table(
        "automatic_discovery_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("own_blog_id", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("timezone", sa.String(length=64), nullable=False, server_default="Asia/Seoul"),
        sa.Column("hour", sa.Integer(), nullable=False, server_default="9"),
        sa.Column("minute", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_synced_at", sa.String(length=32), nullable=True),
        sa.Column("last_status", sa.String(length=16), nullable=False, server_default="never"),
        sa.Column("last_detail", sa.String(length=300), nullable=False, server_default=""),
        sa.CheckConstraint("id = 1", name="ck_automatic_discovery_settings_singleton"),
        sa.CheckConstraint("hour BETWEEN 0 AND 23", name="ck_automatic_discovery_hour"),
        sa.CheckConstraint("minute BETWEEN 0 AND 59", name="ck_automatic_discovery_minute"),
        sa.CheckConstraint(
            "last_status IN ('never', 'success', 'partial', 'failed')",
            name="ck_automatic_discovery_status",
        ),
    )
    op.create_table(
        "automatic_discovery_runs",
        sa.Column("local_date", sa.String(length=10), primary_key=True),
        sa.Column("created_at", sa.String(length=32), nullable=False),
    )


def downgrade() -> None:
    """Drop only automated-discovery metadata."""
    op.drop_table("automatic_discovery_runs")
    op.drop_table("automatic_discovery_settings")
