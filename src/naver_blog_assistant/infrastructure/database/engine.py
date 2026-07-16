"""SQLite engine construction with safe local concurrency defaults."""

from __future__ import annotations

from pathlib import Path
from sqlite3 import Connection as SQLiteConnection

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.engine import make_url


def create_sqlite_engine(database_url: str) -> Engine:
    """Create a SQLite engine with foreign keys, WAL, and a bounded lock wait."""
    url = make_url(database_url)
    if not url.drivername.startswith("sqlite"):
        raise ValueError("the local persistence adapter requires a sqlite:/// URL")
    if (
        url.database is not None
        and url.database != ":memory:"
        and not url.database.startswith("file:")
    ):
        Path(url.database).expanduser().parent.mkdir(parents=True, exist_ok=True)

    engine = create_engine(url, future=True, hide_parameters=True)

    @event.listens_for(engine, "connect")
    def configure_sqlite(connection: SQLiteConnection, _: object) -> None:
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys = ON")
        cursor.execute("PRAGMA busy_timeout = 5000")
        cursor.execute("PRAGMA journal_mode = WAL")
        cursor.close()

    return engine
