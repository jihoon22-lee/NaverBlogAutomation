"""Persistence and migration behavior for versioned web app settings."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy.engine import Engine

from naver_blog_assistant.domain import (
    AppSetting,
    AppSettingKind,
    default_setting,
    normalize_setting_payload,
)
from naver_blog_assistant.infrastructure.database import create_sqlite_engine
from naver_blog_assistant.infrastructure.database.app_settings_repository import (
    SqliteAppSettingsRepository,
)

ROOT = Path(__file__).parents[3]
HEAD = "20260731_0011"


def alembic_config(database_url: str) -> Config:
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option(
        "script_location", str(ROOT / "src/naver_blog_assistant/infrastructure/database/migrations")
    )
    config.set_main_option("sqlalchemy.url", database_url)
    return config


@pytest.fixture
def database_url(tmp_path: Path) -> str:
    return f"sqlite:///{tmp_path / 'settings.db'}"


@pytest.fixture
def engine(database_url: str) -> Iterator[Engine]:
    command.upgrade(alembic_config(database_url), "head")
    created = create_sqlite_engine(database_url)
    try:
        yield created
    finally:
        created.dispose()


@pytest.fixture
def repository(engine: Engine) -> SqliteAppSettingsRepository:
    return SqliteAppSettingsRepository(engine)


def test_the_migration_head_creates_app_settings(database_url: str, tmp_path: Path) -> None:
    command.upgrade(alembic_config(database_url), "head")

    with closing(sqlite3.connect(tmp_path / "settings.db")) as connection:
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        head = connection.execute("SELECT version_num FROM alembic_version").fetchone()

    assert "app_settings" in tables
    assert head == (HEAD,)


def test_downgrade_removes_only_app_settings(database_url: str, tmp_path: Path) -> None:
    config = alembic_config(database_url)
    command.upgrade(config, "head")

    command.downgrade(config, "20260728_0009")

    with closing(sqlite3.connect(tmp_path / "settings.db")) as connection:
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }

    assert "app_settings" not in tables
    assert {"recommendations", "engagement_runs", "discovered_posts"} <= tables


def test_the_kind_check_constraint_rejects_unknown_kinds(database_url: str, tmp_path: Path) -> None:
    command.upgrade(alembic_config(database_url), "head")

    with (
        closing(sqlite3.connect(tmp_path / "settings.db")) as connection,
        pytest.raises(sqlite3.IntegrityError),
    ):
        connection.execute(
            "INSERT INTO app_settings (kind, schema_version, payload_json, updated_at)"
            " VALUES ('unknown_kind', 1, '{}', '2026-07-31T00:00:00+00:00')"
        )


def test_the_payload_check_constraint_rejects_empty_payloads(
    database_url: str, tmp_path: Path
) -> None:
    command.upgrade(alembic_config(database_url), "head")

    with (
        closing(sqlite3.connect(tmp_path / "settings.db")) as connection,
        pytest.raises(sqlite3.IntegrityError),
    ):
        connection.execute(
            "INSERT INTO app_settings (kind, schema_version, payload_json, updated_at)"
            " VALUES ('closing_phrase', 1, '', '2026-07-31T00:00:00+00:00')"
        )


def test_an_unsaved_kind_reads_as_none(repository: SqliteAppSettingsRepository) -> None:
    assert repository.get(AppSettingKind.CLOSING_PHRASE) is None


def test_saving_returns_the_stored_record(repository: SqliteAppSettingsRepository) -> None:
    saved = repository.save(default_setting(AppSettingKind.GENERATION_PROFILE))

    assert saved.updated_at is not None
    assert saved.payload["speech_style"] == "honorific"


def test_a_saved_record_round_trips(repository: SqliteAppSettingsRepository) -> None:
    payload = normalize_setting_payload(AppSettingKind.CLOSING_PHRASE, {"phrase": "감사합니다 🙂"})
    repository.save(
        AppSetting(kind=AppSettingKind.CLOSING_PHRASE, schema_version=1, payload=payload)
    )

    stored = repository.get(AppSettingKind.CLOSING_PHRASE)

    assert stored is not None
    assert stored.payload == payload
    assert stored.updated_at is not None


def test_saving_twice_replaces_the_record(repository: SqliteAppSettingsRepository) -> None:
    repository.save(
        AppSetting(kind=AppSettingKind.CLOSING_PHRASE, schema_version=1, payload={"phrase": "첫"})
    )
    repository.save(
        AppSetting(kind=AppSettingKind.CLOSING_PHRASE, schema_version=1, payload={"phrase": "둘"})
    )

    stored = repository.get(AppSettingKind.CLOSING_PHRASE)

    assert stored is not None
    assert stored.payload == {"phrase": "둘"}


def test_kinds_are_stored_independently(repository: SqliteAppSettingsRepository) -> None:
    repository.save(default_setting(AppSettingKind.CLOSING_PHRASE))
    repository.save(default_setting(AppSettingKind.NEIGHBOR_MESSAGE))

    assert repository.get(AppSettingKind.CLOSING_PHRASE) is not None
    assert repository.get(AppSettingKind.NEIGHBOR_MESSAGE) is not None
    assert repository.get(AppSettingKind.SAFETY_POLICY) is None


def test_clearing_reports_whether_the_record_existed(
    repository: SqliteAppSettingsRepository,
) -> None:
    repository.save(default_setting(AppSettingKind.CLOSING_PHRASE))

    assert repository.clear(AppSettingKind.CLOSING_PHRASE) is True
    assert repository.clear(AppSettingKind.CLOSING_PHRASE) is False


def test_a_non_object_payload_is_rejected_on_read(
    repository: SqliteAppSettingsRepository, tmp_path: Path
) -> None:
    with closing(sqlite3.connect(tmp_path / "settings.db")) as connection:
        connection.execute(
            "INSERT INTO app_settings (kind, schema_version, payload_json, updated_at)"
            " VALUES ('closing_phrase', 1, '[]', '2026-07-31T00:00:00+00:00')"
        )
        connection.commit()

    with pytest.raises(ValueError, match="must be an object"):
        repository.get(AppSettingKind.CLOSING_PHRASE)


def test_every_kind_can_be_saved_and_read(repository: SqliteAppSettingsRepository) -> None:
    for kind in AppSettingKind:
        repository.save(default_setting(kind))

    for kind in AppSettingKind:
        stored = repository.get(kind)
        assert stored is not None
        assert stored.kind is kind
