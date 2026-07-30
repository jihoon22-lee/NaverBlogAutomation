"""SQLite persistence for versioned web app settings."""

from __future__ import annotations

import json
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.engine import Engine

from naver_blog_assistant.domain.settings import (
    SETTING_SCHEMA_VERSIONS,
    AppSetting,
    AppSettingKind,
)
from naver_blog_assistant.infrastructure.database.schema import app_settings


class SqliteAppSettingsRepository:
    """Read and replace one settings record per kind."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def get(self, kind: AppSettingKind) -> AppSetting | None:
        """Return the stored record for ``kind`` or None when it was never saved."""
        with self._engine.connect() as connection:
            row = connection.execute(
                select(
                    app_settings.c.schema_version,
                    app_settings.c.payload_json,
                    app_settings.c.updated_at,
                ).where(app_settings.c.kind == kind.value)
            ).one_or_none()
        if row is None:
            return None
        payload = json.loads(row.payload_json)
        if not isinstance(payload, dict):
            raise ValueError("stored settings payload must be an object")
        return AppSetting(
            kind=kind,
            schema_version=int(row.schema_version),
            payload=payload,
            updated_at=datetime.fromisoformat(row.updated_at),
        )

    def save(self, setting: AppSetting) -> AppSetting:
        """Replace the record for one kind in a single transaction."""
        updated_at = datetime.now(UTC)
        payload_json = json.dumps(setting.payload, ensure_ascii=False, sort_keys=True)
        with self._engine.begin() as connection:
            connection.execute(
                app_settings.delete().where(app_settings.c.kind == setting.kind.value)
            )
            connection.execute(
                app_settings.insert().values(
                    kind=setting.kind.value,
                    schema_version=SETTING_SCHEMA_VERSIONS[setting.kind],
                    payload_json=payload_json,
                    updated_at=updated_at.isoformat(),
                )
            )
        return AppSetting(
            kind=setting.kind,
            schema_version=SETTING_SCHEMA_VERSIONS[setting.kind],
            payload=setting.payload,
            updated_at=updated_at,
        )

    def clear(self, kind: AppSettingKind) -> bool:
        """Delete one record and report whether it existed."""
        with self._engine.begin() as connection:
            result = connection.execute(
                delete(app_settings).where(app_settings.c.kind == kind.value)
            )
        return result.rowcount > 0
