"""Store only hashes for trusted-LAN device sessions.

Revision ID: 20260801_0019
Revises: 20260801_0018
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260801_0019"
down_revision: str | None = "20260801_0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add auditable, revocable remote-device session metadata."""
    op.create_table(
        "remote_device_sessions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("device_name", sa.String(length=80), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False, unique=True),
        sa.Column("csrf_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("last_seen_at", sa.String(length=32), nullable=False),
        sa.Column("expires_at", sa.String(length=32), nullable=False),
        sa.Column("revoked_at", sa.String(length=32), nullable=True),
        sa.CheckConstraint("length(device_name) BETWEEN 1 AND 80", name="ck_remote_device_name"),
        sa.CheckConstraint("length(token_hash) = 64", name="ck_remote_device_token_hash"),
        sa.CheckConstraint("length(csrf_hash) = 64", name="ck_remote_device_csrf_hash"),
    )


def downgrade() -> None:
    """Remove remote-device session metadata."""
    op.drop_table("remote_device_sessions")
