"""Desktop data export/reset is path-confined and recoverable."""

from __future__ import annotations

import zipfile
from io import BytesIO
from pathlib import Path

import pytest

from naver_blog_assistant.application.runtime_data import (
    RESET_CONFIRMATION,
    RuntimeDataError,
    RuntimeDataManager,
)


def manager(tmp_path: Path, disposed: list[bool]) -> RuntimeDataManager:
    return RuntimeDataManager(
        database_path=tmp_path / "app.sqlite3",
        media_root=tmp_path / "media",
        dispose_engine=lambda: disposed.append(True),
    )


def seed(tmp_path: Path) -> None:
    (tmp_path / "app.sqlite3").write_bytes(b"SQLite format 3\x00")
    media = tmp_path / "media" / "drafts" / "one"
    media.mkdir(parents=True)
    (media / "image.png").write_bytes(b"PNG")
    (tmp_path / ".env.local").write_text("OPENAI_API_KEY=private", encoding="utf-8")
    (tmp_path / "browser-profile").mkdir()


def test_export_includes_only_database_and_media(tmp_path: Path) -> None:
    seed(tmp_path)
    disposed: list[bool] = []

    archive = manager(tmp_path, disposed).export()

    with zipfile.ZipFile(BytesIO(archive)) as exported:
        assert sorted(exported.namelist()) == ["database.sqlite3", "media/drafts/one/image.png"]
        assert b"private" not in archive
    assert disposed == []


def test_snapshot_distinguishes_sqlite_files_from_draft_media(tmp_path: Path) -> None:
    seed(tmp_path)
    (tmp_path / "app.sqlite3-wal").write_bytes(b"wal")

    snapshot = manager(tmp_path, []).snapshot(reset_available=True)

    assert snapshot.database_file_count == 2
    assert snapshot.media_file_count == 1
    assert snapshot.file_count == 3


def test_reset_requires_typed_confirmation_and_moves_data_to_a_backup(tmp_path: Path) -> None:
    seed(tmp_path)
    disposed: list[bool] = []
    data = manager(tmp_path, disposed)

    with pytest.raises(RuntimeDataError, match="confirmation"):
        data.reset(confirmation="reset")

    result = data.reset(confirmation=RESET_CONFIRMATION)

    backup = Path(result.backup_location)
    assert result.restart_required is True
    assert disposed == [True]
    assert (backup / "database.sqlite3").is_file()
    assert (backup / "media" / "drafts" / "one" / "image.png").is_file()
    assert not (tmp_path / "app.sqlite3").exists()
    assert not (tmp_path / "media").exists()
    assert (tmp_path / ".env.local").is_file()
    assert (tmp_path / "browser-profile").is_dir()


def test_export_refuses_a_symlink_inside_media(tmp_path: Path) -> None:
    seed(tmp_path)
    target = tmp_path / "outside.txt"
    target.write_text("outside", encoding="utf-8")
    link = tmp_path / "media" / "linked.txt"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlinks are not available in this environment")

    with pytest.raises(RuntimeDataError, match="symlink"):
        manager(tmp_path, []).export()


def test_export_refuses_a_symlinked_database_parent(tmp_path: Path) -> None:
    actual = tmp_path / "actual"
    actual.mkdir()
    linked = tmp_path / "linked"
    try:
        linked.symlink_to(actual, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks are not available in this environment")
    database = linked / "app.sqlite3"
    database.write_bytes(b"SQLite format 3\x00")
    media = tmp_path / "media"
    media.mkdir()

    data = RuntimeDataManager(
        database_path=database,
        media_root=media,
        dispose_engine=lambda: None,
    )
    with pytest.raises(RuntimeDataError, match="symlink"):
        data.export()
