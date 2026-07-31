"""Allow the writing profile settings kind.

SQLite cannot alter a CHECK constraint in place, so the table is rebuilt with the wider list.

Revision ID: 20260731_0015
Revises: 20260731_0014
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260731_0015"
down_revision: str | None = "20260731_0014"
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
    "llm_budget",
)
ADDED_KINDS = ("writing_profile",)


def upgrade() -> None:
    """Widen the settings kind constraint so a writing profile can be stored."""
    _rebuild((*PREVIOUS_KINDS, *ADDED_KINDS))


def downgrade() -> None:
    """Restore the narrower constraint after dropping any newly added record."""
    removed = ", ".join(f"'{kind}'" for kind in ADDED_KINDS)
    op.execute(f"DELETE FROM app_settings WHERE kind IN ({removed})")  # noqa: S608 - fixed literals
    _rebuild(PREVIOUS_KINDS)


def _rebuild(kinds: Sequence[str]) -> None:
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
