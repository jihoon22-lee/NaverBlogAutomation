"""Persist completed-comment personalization provenance and eligibility.

Revision ID: 20260723_0005
Revises: 20260719_0004
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any, cast

import sqlalchemy as sa
from alembic import op

revision: str = "20260723_0005"
down_revision: str | None = "20260719_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_DEFAULTS = {
    "personalization_mode": "off",
    "personalization_sample_count": 0,
    "personalization_eligible": True,
}


def upgrade() -> None:
    """Add bounded personalization metadata without deleting existing history."""
    # SQLite rebuilds a table for named CHECK constraints. This table has intentional
    # incoming and circular foreign keys, so enforcement must be disabled for that DDL.
    op.execute("PRAGMA foreign_keys=OFF")
    with op.batch_alter_table("recommendations") as batch:
        batch.add_column(
            sa.Column(
                "personalization_mode",
                sa.String(length=32),
                nullable=False,
                server_default="off",
            )
        )
        batch.add_column(
            sa.Column(
                "personalization_sample_count",
                sa.Integer(),
                nullable=False,
                server_default="0",
            )
        )
        batch.add_column(
            sa.Column(
                "personalization_eligible",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            )
        )
        batch.create_check_constraint(
            "ck_recommendations_personalization_mode",
            "personalization_mode IN ('off', 'completed_examples')",
        )
        batch.create_check_constraint(
            "ck_recommendations_personalization_sample_count",
            "personalization_sample_count BETWEEN 0 AND 5",
        )

    connection = op.get_bind()
    for row in connection.execute(
        sa.text(
            "SELECT key, response_snapshot FROM idempotency_records "
            "WHERE response_snapshot IS NOT NULL"
        )
    ).mappings():
        snapshot = _load_object(row["response_snapshot"])
        connection.execute(
            sa.text(
                "UPDATE idempotency_records SET response_snapshot = :snapshot WHERE key = :key"
            ),
            {"key": row["key"], "snapshot": _dump({**_DEFAULTS, **snapshot})},
        )
    op.execute("PRAGMA foreign_keys=ON")


def downgrade() -> None:
    """Remove personalization metadata for the previous schema."""
    op.execute("PRAGMA foreign_keys=OFF")
    connection = op.get_bind()
    for row in connection.execute(
        sa.text(
            "SELECT key, response_snapshot FROM idempotency_records "
            "WHERE response_snapshot IS NOT NULL"
        )
    ).mappings():
        snapshot = _load_object(row["response_snapshot"])
        for key in _DEFAULTS:
            snapshot.pop(key, None)
        connection.execute(
            sa.text(
                "UPDATE idempotency_records SET response_snapshot = :snapshot WHERE key = :key"
            ),
            {"key": row["key"], "snapshot": _dump(snapshot)},
        )

    with op.batch_alter_table("recommendations") as batch:
        batch.drop_constraint("ck_recommendations_personalization_sample_count", type_="check")
        batch.drop_constraint("ck_recommendations_personalization_mode", type_="check")
        batch.drop_column("personalization_eligible")
        batch.drop_column("personalization_sample_count")
        batch.drop_column("personalization_mode")
    op.execute("PRAGMA foreign_keys=ON")


def _load_object(value: object) -> dict[str, Any]:
    if not isinstance(value, (str, bytes, bytearray)):
        raise RuntimeError("response snapshot is invalid")
    try:
        loaded: Any = json.loads(value)
    except (TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("response snapshot is invalid") from error
    if not isinstance(loaded, dict) or not all(isinstance(key, str) for key in loaded):
        raise RuntimeError("response snapshot is invalid")
    return cast(dict[str, Any], loaded)


def _dump(value: Mapping[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
