"""Safety helpers shared by local setup scripts."""

from __future__ import annotations

import os
import socket
from pathlib import Path
from typing import Final

from sqlalchemy.engine import make_url

from naver_blog_assistant.api.runtime import LOOPBACK_HOST, LOOPBACK_PORT

REPOSITORY_ROOT: Final = Path(__file__).resolve().parents[1]
SUPPORTED_DATABASE_SUFFIXES: Final = frozenset({".db", ".sqlite", ".sqlite3"})


class LocalRuntimeError(RuntimeError):
    """Raised when a maintenance operation would leave its safe local boundary."""


def repo_database_path(database_url: str, *, root: Path = REPOSITORY_ROOT) -> Path:
    """Resolve a plain SQLite file strictly below the repository data directory."""
    try:
        url = make_url(database_url)
    except Exception:
        raise LocalRuntimeError("DATABASE_URL must be a valid repo-local SQLite URL") from None
    if (
        url.get_backend_name() != "sqlite"
        or url.database in {None, "", ":memory:"}
        or url.host is not None
        or bool(url.query)
        or str(url.database).startswith("file:")
    ):
        raise LocalRuntimeError("DATABASE_URL must be a plain repo-local SQLite file URL")

    repository = root.resolve()
    configured_data_directory = repository / "data"
    if configured_data_directory.is_symlink():
        raise LocalRuntimeError("refusing to manage a symbolic-link data directory")
    data_directory = configured_data_directory.resolve()
    configured = Path(str(url.database)).expanduser()
    candidate = configured if configured.is_absolute() else repository / configured
    candidate = Path(os.path.abspath(candidate))
    try:
        parent = candidate.parent.resolve(strict=False)
    except OSError:
        raise LocalRuntimeError("DATABASE_URL parent directory cannot be resolved safely") from None
    if (
        not parent.is_relative_to(data_directory)
        or candidate.suffix not in SUPPORTED_DATABASE_SUFFIXES
    ):
        raise LocalRuntimeError("DATABASE_URL must point to a .db or .sqlite file below data/")
    if candidate.is_symlink():
        raise LocalRuntimeError("refusing to manage a symbolic-link database")
    return candidate


def sqlite_runtime_files(database_path: Path) -> tuple[Path, Path, Path]:
    """Return the exact database, WAL, and shared-memory paths."""
    return (
        database_path,
        Path(f"{database_path}-wal"),
        Path(f"{database_path}-shm"),
    )


def loopback_api_is_running(*, timeout_seconds: float = 0.2) -> bool:
    """Return whether something currently accepts the fixed local API address."""
    try:
        with socket.create_connection((LOOPBACK_HOST, LOOPBACK_PORT), timeout=timeout_seconds):
            return True
    except OSError:
        return False
