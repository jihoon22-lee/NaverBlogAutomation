"""Remove superseded browser and LLM-provider SQLite settings.

Revision ID: 20260808_0022
Revises: 20260808_0021
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260808_0022"
down_revision: str | None = "20260808_0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KINDS = (
    "generation_profile",
    "closing_phrase",
    "neighbor_message",
    "automation_consent",
    "safety_policy",
    "schedule_policy",
    "llm_budget",
    "writing_profile",
)


def upgrade() -> None:
    """Make runtime env configuration the only browser/provider configuration source."""
    connection = op.get_bind()
    connection.exec_driver_sql(
        "DELETE FROM app_settings WHERE kind IN ('browser_profile', 'llm_providers')"
    )
    with op.batch_alter_table("app_settings") as batch:
        batch.drop_constraint("ck_app_settings_kind", type_="check")
        batch.create_check_constraint(
            "ck_app_settings_kind",
            "kind IN (" + ", ".join(f"'{kind}'" for kind in _KINDS) + ")",
        )


def downgrade() -> None:
    """Restore only legacy acceptance; removed stale values are intentionally not recreated."""
    with op.batch_alter_table("app_settings") as batch:
        batch.drop_constraint("ck_app_settings_kind", type_="check")
        batch.create_check_constraint(
            "ck_app_settings_kind",
            "kind IN ("
            "'generation_profile', 'closing_phrase', 'neighbor_message', "
            "'automation_consent', 'safety_policy', 'schedule_policy', "
            "'browser_profile', 'llm_providers', 'llm_budget', 'writing_profile'"
            ")",
        )
