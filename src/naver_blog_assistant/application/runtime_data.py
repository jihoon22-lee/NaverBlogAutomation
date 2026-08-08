"""Desktop-owned export and recoverable reset for application data.

The browser never supplies a path.  The service derives both targets from its already-open SQLite
database and draft media root, rejects links, and never includes the private runtime dotenv or a
browser profile in an archive.
"""

from __future__ import annotations

import io
import os
import shutil
import stat
import zipfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4


class RuntimeDataError(ValueError):
    """Raised when desktop data cannot be safely inspected, exported, or reset."""


RESET_CONFIRMATION = "RESET LOCAL DATA"


@dataclass(frozen=True, slots=True)
class RuntimeDataSnapshot:
    """Non-secret metadata that is safe to display to the loopback desktop client."""

    database_location: str
    database_file_count: int
    media_location: str
    media_file_count: int
    file_count: int
    size_bytes: int
    reset_available: bool


@dataclass(frozen=True, slots=True)
class RuntimeDataReset:
    """The recoverable backup created before the supervisor restarts a clean service."""

    backup_location: str
    restart_required: bool = True


class RuntimeDataManager:
    """Own app data paths with a narrow, symlink-safe export/reset surface."""

    def __init__(
        self,
        *,
        database_path: Path | None,
        media_root: Path,
        dispose_engine: Callable[[], None],
    ) -> None:
        self._database_path = None if database_path is None else database_path.expanduser()
        self._media_root = media_root.expanduser()
        self._dispose_engine = dispose_engine

    def snapshot(self, *, reset_available: bool) -> RuntimeDataSnapshot:
        """Return safe locations and the exact amount of data covered by an export."""
        files = tuple(self._files())
        database_file_count = sum(1 for path in files if self._is_database_file(path))
        return RuntimeDataSnapshot(
            database_location=self._display_path(self._database_path),
            database_file_count=database_file_count,
            media_location=self._display_path(self._media_root),
            media_file_count=len(files) - database_file_count,
            file_count=len(files),
            size_bytes=sum(path.stat().st_size for path in files),
            reset_available=reset_available and self._reset_root() is not None,
        )

    def export(self) -> bytes:
        """Create an in-memory archive of only the database and draft media files."""
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in self._files():
                archive.write(path, self._archive_name(path))
        return buffer.getvalue()

    def reset(self, *, confirmation: str) -> RuntimeDataReset:
        """Move exact data targets to a private timestamped backup without deleting them."""
        if confirmation != RESET_CONFIRMATION:
            raise RuntimeDataError("reset_confirmation_invalid")
        root = self._reset_root()
        if root is None:
            raise RuntimeDataError("runtime_data_reset_unavailable")
        self._assert_root(root)
        backups = root / ".nba-data-backups"
        if backups.exists() and backups.is_symlink():
            raise RuntimeDataError("runtime_data_backup_directory_unsafe")
        backups.mkdir(mode=0o700, parents=True, exist_ok=True)
        backup = backups / f"{datetime.now(UTC):%Y%m%dT%H%M%SZ}-{uuid4().hex[:8]}"
        backup.mkdir(mode=0o700)

        # Do not move an open SQLite file before pools release their handles.  The caller has
        # already ensured browser, batches, and staging are idle; the supervisor ends this process
        # immediately after the marker is written, so no new operation can observe the moved paths.
        self._dispose_engine()
        moved = False
        try:
            for label, path in self._targets():
                if not path.exists():
                    continue
                self._assert_target(path, directory=label == "media")
                destination = backup / label
                os.replace(path, destination)
                moved = True
        except OSError as error:
            raise RuntimeDataError("runtime_data_backup_failed") from error
        if not moved:
            shutil.rmtree(backup)
            raise RuntimeDataError("runtime_data_empty")
        return RuntimeDataReset(backup_location=str(backup))

    def _files(self) -> Iterable[Path]:
        for label, target in self._targets():
            if not target.exists():
                continue
            self._assert_target(target, directory=label == "media")
            if target.is_file():
                yield target
                continue
            for candidate in target.rglob("*"):
                if candidate.is_symlink():
                    raise RuntimeDataError("runtime_data_contains_symlink")
                if candidate.is_file():
                    yield candidate

    def _targets(self) -> tuple[tuple[str, Path], ...]:
        database = self._database_path
        files: list[tuple[str, Path]] = []
        if database is not None:
            files.append(("database.sqlite3", database))
            for suffix in ("-wal", "-shm"):
                files.append((f"database.sqlite3{suffix}", Path(f"{database}{suffix}")))
        files.append(("media", self._media_root))
        return tuple(files)

    def _archive_name(self, path: Path) -> str:
        database = self._database_path
        if database is not None and path == database:
            return "database.sqlite3"
        if database is not None and str(path).startswith(f"{database}-"):
            return f"database.sqlite3{str(path)[len(str(database)) :]}"
        try:
            return str(Path("media") / path.relative_to(self._media_root))
        except ValueError as error:
            raise RuntimeDataError("runtime_data_path_escape") from error

    def _is_database_file(self, path: Path) -> bool:
        database = self._database_path
        return database is not None and (path == database or str(path).startswith(f"{database}-"))

    def _reset_root(self) -> Path | None:
        database = self._database_path
        if database is None:
            return None
        try:
            common = Path(
                os.path.commonpath((database.parent.resolve(), self._media_root.resolve()))
            )
        except ValueError:
            return None
        # Never create a backup directly under a filesystem root; disjoint custom locations are not
        # a safe single reset unit.
        return None if str(common) == common.anchor else common

    @staticmethod
    def _display_path(path: Path | None) -> str:
        return "사용할 수 없음" if path is None else str(path.resolve())

    @staticmethod
    def _assert_root(root: Path) -> None:
        if root.is_symlink() or (root.exists() and not root.is_dir()):
            raise RuntimeDataError("runtime_data_root_unsafe")

    @staticmethod
    def _assert_target(path: Path, *, directory: bool) -> None:
        if path.is_symlink():
            raise RuntimeDataError("runtime_data_target_symlink")
        if directory:
            if not path.is_dir():
                raise RuntimeDataError("runtime_data_media_not_directory")
        elif not path.is_file():
            raise RuntimeDataError("runtime_data_database_not_file")
        mode = path.stat().st_mode
        if not stat.S_ISDIR(mode) and not stat.S_ISREG(mode):
            raise RuntimeDataError("runtime_data_target_unsafe")


__all__ = [
    "RESET_CONFIRMATION",
    "RuntimeDataError",
    "RuntimeDataManager",
    "RuntimeDataReset",
    "RuntimeDataSnapshot",
]
