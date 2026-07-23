"""Smoke-test resources and migrations from an installed wheel."""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory

import yaml

from naver_blog_assistant.api import ApiSettings, create_app

EXTENSION_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
EXPECTED_MIGRATION_HEAD = "20260723_0005"
CHECKED_IN_CONTRACT = Path(__file__).resolve().parents[1] / "docs" / "api" / "openapi.yaml"


def main() -> None:
    """Create the packaged app, load OpenAPI, and apply packaged migrations."""
    with TemporaryDirectory() as directory:
        database_path = Path(directory) / "wheel-smoke.db"
        settings = ApiSettings(
            extension_origin=EXTENSION_ORIGIN,
            database_url=f"sqlite:///{database_path}",
            generator_mode="fake",
            app_environment="test",
        )
        app = create_app(settings)
        try:
            contract = app.openapi()
            checked_in_contract = yaml.safe_load(CHECKED_IN_CONTRACT.read_text(encoding="utf-8"))
            assert contract == checked_in_contract
            with closing(sqlite3.connect(database_path)) as connection:
                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
                migration_head = connection.execute(
                    "SELECT version_num FROM alembic_version"
                ).fetchone()
            assert {"recommendations", "comment_candidates", "idempotency_records"} <= tables
            assert migration_head == (EXPECTED_MIGRATION_HEAD,)
        finally:
            app.state.database_engine.dispose()


if __name__ == "__main__":
    main()
