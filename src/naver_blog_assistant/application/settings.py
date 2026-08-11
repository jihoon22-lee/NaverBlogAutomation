"""Read and save versioned web-app settings."""

from __future__ import annotations

from typing import Any, Protocol

from naver_blog_assistant.domain.models import DomainValidationError
from naver_blog_assistant.domain.settings import (
    SETTING_SCHEMA_VERSIONS,
    AppSetting,
    AppSettingKind,
    default_setting,
    normalize_setting_payload,
)


class AppSettingsRepository(Protocol):
    """Persistence contract for versioned settings records."""

    def get(self, kind: AppSettingKind) -> AppSetting | None:
        """Return the stored record or None."""
        ...

    def save(self, setting: AppSetting) -> AppSetting:
        """Replace the record for one kind."""
        ...


class ReadAppSetting:
    """Return the stored record, falling back to the documented default."""

    def __init__(self, repository: AppSettingsRepository) -> None:
        self._repository = repository

    def execute(self, kind: AppSettingKind) -> AppSetting:
        """Return the effective record for ``kind``."""
        stored = self._repository.get(kind)
        return stored if stored is not None else default_setting(kind)


class SaveAppSetting:
    """Validate and replace one settings record."""

    def __init__(self, repository: AppSettingsRepository) -> None:
        self._repository = repository

    def execute(self, kind: AppSettingKind, payload: dict[str, Any]) -> AppSetting:
        """Normalize ``payload`` for ``kind`` and store it."""
        if not isinstance(payload, dict):
            raise DomainValidationError("settings payload must be an object")
        normalized = normalize_setting_payload(kind, payload)
        return self._repository.save(
            AppSetting(
                kind=kind,
                schema_version=SETTING_SCHEMA_VERSIONS[kind],
                payload=normalized,
            )
        )
