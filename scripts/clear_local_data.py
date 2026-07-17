"""Safely remove only the configured repo-local SQLite runtime files."""

from __future__ import annotations

import argparse
import os
from collections.abc import Callable, Sequence
from pathlib import Path

from scripts._local_runtime import (
    REPOSITORY_ROOT,
    LocalRuntimeError,
    loopback_api_is_running,
    repo_database_path,
    sqlite_runtime_files,
)

DEFAULT_DATABASE_URL = "sqlite:///data/naver_blog_assistant.db"


def clear_local_data(
    database_url: str,
    *,
    root: Path = REPOSITORY_ROOT,
    confirmed: bool,
    api_is_running: Callable[[], bool] = loopback_api_is_running,
) -> tuple[Path, ...]:
    """Return planned files in dry-run mode or remove them after all safety checks."""
    database = repo_database_path(database_url, root=root)
    targets = sqlite_runtime_files(database)
    for target in targets:
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise LocalRuntimeError("refusing to manage a non-regular SQLite runtime path")
    existing = tuple(target for target in targets if target.exists())
    if not confirmed:
        return existing
    if api_is_running():
        raise LocalRuntimeError("stop the local API on 127.0.0.1:8765 before clearing data")
    for target in existing:
        target.unlink()
    return existing


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="delete the listed database, WAL, and SHM files; default is dry-run",
    )
    return parser


def main(arguments: Sequence[str] | None = None) -> None:
    """Plan or perform cleanup for DATABASE_URL from the explicit process environment."""
    options = _parser().parse_args(arguments)
    try:
        affected = clear_local_data(
            os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL),
            confirmed=options.confirm,
        )
    except (LocalRuntimeError, OSError) as error:
        raise SystemExit(f"Local data cleanup refused: {error}") from None
    action = "Removed" if options.confirm else "Would remove"
    if not affected:
        print("No repo-local SQLite runtime files were found.")
        return
    for path in affected:
        print(f"{action}: {path.relative_to(REPOSITORY_ROOT)}")
    if not options.confirm:
        print("Run again with --confirm after stopping the local API.")


if __name__ == "__main__":
    main()
