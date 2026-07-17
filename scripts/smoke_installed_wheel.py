"""Smoke-test resources and migrations from an installed wheel."""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory

from naver_blog_assistant.api import ApiSettings, create_app

EXTENSION_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


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
            assert contract["openapi"] == "3.1.0"
            assert "/api/v1/recommendations" in contract["paths"]
            with closing(sqlite3.connect(database_path)) as connection:
                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
            assert {"recommendations", "comment_candidates", "idempotency_records"} <= tables
        finally:
            app.state.database_engine.dispose()


if __name__ == "__main__":
    main()
