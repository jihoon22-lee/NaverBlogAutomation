"""Add backward-compatible mood provenance to stored preference JSON.

Revision ID: 20260719_0004
Revises: 20260719_0003
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any, cast

import sqlalchemy as sa
from alembic import op

revision: str = "20260719_0004"
down_revision: str | None = "20260719_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LEGACY_KEYS = {"relationship", "speech", "length"}
_MOOD_KEYS = {*_LEGACY_KEYS, "mood"}


def upgrade() -> None:
    """Backfill the implicit historical mood without adding a database column."""
    connection = op.get_bind()
    for row in connection.execute(
        sa.text("SELECT id, generation_preferences_json FROM recommendations")
    ).mappings():
        preferences = _load_object(row["generation_preferences_json"], "generation preferences")
        connection.execute(
            sa.text(
                "UPDATE recommendations SET generation_preferences_json = :preferences "
                "WHERE id = :id"
            ),
            {"id": row["id"], "preferences": _dump(_with_default_mood(preferences))},
        )

    for row in connection.execute(
        sa.text(
            "SELECT key, response_snapshot FROM idempotency_records "
            "WHERE response_snapshot IS NOT NULL"
        )
    ).mappings():
        snapshot = _load_object(row["response_snapshot"], "response snapshot")
        if "generation_preferences" not in snapshot:
            continue
        preferences = _require_mapping(
            snapshot["generation_preferences"], "snapshot generation preferences"
        )
        snapshot["generation_preferences"] = _with_default_mood(preferences)
        connection.execute(
            sa.text(
                "UPDATE idempotency_records SET response_snapshot = :snapshot WHERE key = :key"
            ),
            {"key": row["key"], "snapshot": _dump(snapshot)},
        )


def downgrade() -> None:
    """Remove only the implicit warm mood so revision 0003 can read the data."""
    connection = op.get_bind()
    for row in connection.execute(
        sa.text("SELECT id, generation_preferences_json FROM recommendations")
    ).mappings():
        preferences = _load_object(row["generation_preferences_json"], "generation preferences")
        connection.execute(
            sa.text(
                "UPDATE recommendations SET generation_preferences_json = :preferences "
                "WHERE id = :id"
            ),
            {"id": row["id"], "preferences": _dump(_without_default_mood(preferences))},
        )

    for row in connection.execute(
        sa.text(
            "SELECT key, response_snapshot FROM idempotency_records "
            "WHERE response_snapshot IS NOT NULL"
        )
    ).mappings():
        snapshot = _load_object(row["response_snapshot"], "response snapshot")
        if "generation_preferences" not in snapshot:
            continue
        preferences = _require_mapping(
            snapshot["generation_preferences"], "snapshot generation preferences"
        )
        snapshot["generation_preferences"] = _without_default_mood(preferences)
        connection.execute(
            sa.text(
                "UPDATE idempotency_records SET response_snapshot = :snapshot WHERE key = :key"
            ),
            {"key": row["key"], "snapshot": _dump(snapshot)},
        )


def _with_default_mood(preferences: Mapping[str, Any]) -> dict[str, Any]:
    keys = set(preferences)
    if keys == _MOOD_KEYS:
        return dict(preferences)
    if keys != _LEGACY_KEYS:
        raise RuntimeError("stored generation preferences are invalid")
    return {**preferences, "mood": "warm"}


def _without_default_mood(preferences: Mapping[str, Any]) -> dict[str, Any]:
    keys = set(preferences)
    if keys == _LEGACY_KEYS:
        return dict(preferences)
    if keys != _MOOD_KEYS:
        raise RuntimeError("stored generation preferences are invalid")
    if preferences["mood"] != "warm":
        raise RuntimeError("cannot downgrade while non-default generation mood exists")
    return {key: value for key, value in preferences.items() if key != "mood"}


def _load_object(value: object, name: str) -> dict[str, Any]:
    if not isinstance(value, (str, bytes, bytearray)):
        raise RuntimeError(f"stored {name} is invalid")
    try:
        loaded: Any = json.loads(value)
    except (TypeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"stored {name} is invalid") from error
    return dict(_require_mapping(loaded, name))


def _require_mapping(value: object, name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise RuntimeError(f"stored {name} is invalid")
    return cast(dict[str, Any], value)


def _dump(value: Mapping[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
