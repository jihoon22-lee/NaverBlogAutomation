"""Record one provider attempt per fan-out request and allow the call budget setting.

Revision ID: 20260731_0012
Revises: 20260731_0011
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260731_0012"
down_revision: str | None = "20260731_0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PREVIOUS_KINDS = (
    "generation_profile",
    "closing_phrase",
    "neighbor_message",
    "automation_consent",
    "safety_policy",
    "schedule_policy",
    "browser_profile",
    "llm_providers",
)
ADDED_KINDS = ("llm_budget",)
STATUSES = ("succeeded", "failed", "indeterminate")


def upgrade() -> None:
    """Add the attempt ledger and widen the settings kind constraint."""
    statuses = ", ".join(f"'{status}'" for status in STATUSES)
    op.create_table(
        "llm_generation_attempts",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("model", sa.String(length=100), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("result_code", sa.String(length=64), nullable=True),
        sa.Column("recommendation_id", sa.String(length=36), nullable=True),
        sa.Column("retry_after", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.CheckConstraint("attempt >= 1", name="ck_llm_attempts_attempt"),
        sa.CheckConstraint(f"status IN ({statuses})", name="ck_llm_attempts_status"),
        sa.CheckConstraint("length(request_hash) = 64", name="ck_llm_attempts_request_hash"),
        sa.UniqueConstraint(
            "request_hash", "attempt", "provider", "model", name="uq_llm_attempts_selection"
        ),
    )
    op.create_index("ix_llm_attempts_created_at", "llm_generation_attempts", ["created_at"])
    _rebuild_settings((*PREVIOUS_KINDS, *ADDED_KINDS))


def downgrade() -> None:
    """Drop the attempt ledger and restore the narrower settings constraint."""
    removed = ", ".join(f"'{kind}'" for kind in ADDED_KINDS)
    op.execute(f"DELETE FROM app_settings WHERE kind IN ({removed})")  # noqa: S608 - fixed literals
    _rebuild_settings(PREVIOUS_KINDS)
    op.drop_index("ix_llm_attempts_created_at", table_name="llm_generation_attempts")
    op.drop_table("llm_generation_attempts")


def _rebuild_settings(kinds: Sequence[str]) -> None:
    allowed = ", ".join(f"'{kind}'" for kind in kinds)
    op.execute("ALTER TABLE app_settings RENAME TO app_settings_old")
    op.execute(
        "CREATE TABLE app_settings ("
        "kind VARCHAR(32) NOT NULL, "
        "schema_version INTEGER NOT NULL, "
        "payload_json TEXT NOT NULL, "
        "updated_at VARCHAR(32) NOT NULL, "
        "CONSTRAINT pk_app_settings PRIMARY KEY (kind), "
        f"CONSTRAINT ck_app_settings_kind CHECK (kind IN ({allowed})), "
        "CONSTRAINT ck_app_settings_schema_version CHECK (schema_version >= 1), "
        "CONSTRAINT ck_app_settings_payload CHECK (length(payload_json) > 0)"
        ")"
    )
    op.execute(
        "INSERT INTO app_settings (kind, schema_version, payload_json, updated_at) "
        "SELECT kind, schema_version, payload_json, updated_at FROM app_settings_old"
    )
    op.execute("DROP TABLE app_settings_old")
