"""Store versioned web app settings that the unattended scheduler can read.

Revision ID: 20260731_0010
Revises: 20260728_0009
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260731_0010"
down_revision: str | None = "20260728_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SETTING_KINDS = (
    "generation_profile",
    "closing_phrase",
    "neighbor_message",
    "automation_consent",
    "safety_policy",
    "schedule_policy",
    "browser_profile",
)


def upgrade() -> None:
    """Add one versioned record per settings kind."""
    kinds = ", ".join(f"'{kind}'" for kind in SETTING_KINDS)
    op.create_table(
        "app_settings",
        sa.Column("kind", sa.String(length=32), primary_key=True),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.String(length=32), nullable=False),
        sa.CheckConstraint(f"kind IN ({kinds})", name="ck_app_settings_kind"),
        sa.CheckConstraint("schema_version >= 1", name="ck_app_settings_schema_version"),
        sa.CheckConstraint("length(payload_json) > 0", name="ck_app_settings_payload"),
    )


def downgrade() -> None:
    """Remove web-app settings."""
    op.drop_table("app_settings")
