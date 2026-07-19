"""Persist generation preferences with recommendations.

Revision ID: 20260719_0003
Revises: 20260717_0002
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "20260719_0003"
down_revision: str | None = "20260717_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_DEFAULT_PREFERENCES = {
    "relationship": "friendly",
    "speech": "honorific",
    "length": "medium",
}
_DEFAULT_PREFERENCES_JSON = json.dumps(
    _DEFAULT_PREFERENCES,
    ensure_ascii=False,
    separators=(",", ":"),
    sort_keys=True,
)


def upgrade() -> None:
    """Add and backfill one canonical preference provenance column."""
    op.add_column(
        "recommendations",
        sa.Column(
            "generation_preferences_json",
            sa.Text(),
            nullable=False,
            server_default=_DEFAULT_PREFERENCES_JSON,
        ),
    )


def downgrade() -> None:
    """Remove preference provenance only when doing so cannot lose meaning."""
    connection = op.get_bind()
    rows = connection.execute(
        sa.text(
            "SELECT generation_preferences_json, response_snapshot "
            "FROM recommendations LEFT JOIN idempotency_records "
            "ON idempotency_records.recommendation_id = recommendations.id"
        )
    ).mappings()
    if any(_row_contains_non_default_preferences(row) for row in rows):
        raise RuntimeError("cannot downgrade while non-default generation preferences exist")

    # SQLite supports direct DROP COLUMN. Avoid batch recreation because recommendations
    # participates in both incoming and circular foreign-key relationships.
    op.execute("ALTER TABLE recommendations DROP COLUMN generation_preferences_json")


def _row_contains_non_default_preferences(row: Any) -> bool:
    try:
        stored = json.loads(row["generation_preferences_json"])
    except TypeError, json.JSONDecodeError:
        return True
    if stored != _DEFAULT_PREFERENCES:
        return True

    snapshot_json = row["response_snapshot"]
    if snapshot_json is None:
        return False
    try:
        snapshot = json.loads(snapshot_json)
    except TypeError, json.JSONDecodeError:
        return True
    if not isinstance(snapshot, dict):
        return True
    snapshot_preferences = snapshot.get("generation_preferences", _DEFAULT_PREFERENCES)
    return snapshot_preferences != _DEFAULT_PREFERENCES
