"""Tests for safe local environment and SQLite maintenance utilities."""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest
from scripts._local_runtime import LocalRuntimeError, repo_database_path, sqlite_runtime_files
from scripts.clear_local_data import clear_local_data
from scripts.init_local_env import (
    ensure_private_directory,
    initialize_local_environment,
    select_environment_target,
)


def test_environment_initialization_is_private_atomic_and_non_overwriting(tmp_path: Path) -> None:
    template = tmp_path / ".env.example"
    target = tmp_path / ".env.local"
    template.write_text("APP_ENV=development\n", encoding="utf-8")

    initialize_local_environment(template=template, target=target)

    assert target.read_text(encoding="utf-8") == "APP_ENV=development\n"
    if os.name == "posix":
        assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert not list(tmp_path.glob(".*.tmp"))

    with pytest.raises(LocalRuntimeError, match="refusing to overwrite"):
        initialize_local_environment(template=template, target=target)
    assert target.read_text(encoding="utf-8") == "APP_ENV=development\n"


def test_explicit_environment_parent_is_created_with_private_mode(tmp_path: Path) -> None:
    parent = tmp_path / "config" / "naver-blog-assistant"

    ensure_private_directory(parent)

    assert parent.is_dir()
    if os.name == "posix":
        assert stat.S_IMODE(parent.stat().st_mode) == 0o700


def test_private_environment_parent_rejects_a_symlink(tmp_path: Path) -> None:
    actual = tmp_path / "actual"
    actual.mkdir(mode=0o700)
    linked = tmp_path / "linked"
    linked.symlink_to(actual, target_is_directory=True)

    with pytest.raises(LocalRuntimeError, match="real directory"):
        ensure_private_directory(linked)


def test_private_environment_parent_does_not_chmod_existing_directory(tmp_path: Path) -> None:
    parent = tmp_path / "shared"
    parent.mkdir(mode=0o755)
    parent.chmod(0o755)

    with pytest.raises(LocalRuntimeError, match="mode 0700"):
        ensure_private_directory(parent)

    if os.name == "posix":
        assert stat.S_IMODE(parent.stat().st_mode) == 0o755


def test_explicit_environment_target_must_stay_outside_repository(tmp_path: Path) -> None:
    with pytest.raises(LocalRuntimeError, match="inside the repository"):
        select_environment_target(tmp_path / "config" / "env", repository_root=tmp_path)

    target, prepare_parent = select_environment_target(
        tmp_path.parent / "private-config" / "env",
        repository_root=tmp_path,
    )
    assert target == (tmp_path.parent / "private-config" / "env").resolve()
    assert prepare_parent


@pytest.mark.parametrize(
    "database_url",
    [
        "postgresql://localhost/app",
        "sqlite:///:memory:",
        "sqlite:///outside.db",
        "sqlite:///data/database.txt",
        "sqlite:///data/app.db?mode=ro",
    ],
)
def test_database_path_rejects_nonlocal_or_ambiguous_targets(
    tmp_path: Path, database_url: str
) -> None:
    with pytest.raises(LocalRuntimeError):
        repo_database_path(database_url, root=tmp_path)


def test_database_path_rejects_symlinks(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    outside = tmp_path / "outside.db"
    outside.write_bytes(b"outside")
    (data / "app.db").symlink_to(outside)

    with pytest.raises(LocalRuntimeError, match="symbolic-link"):
        repo_database_path("sqlite:///data/app.db", root=tmp_path)


def test_database_path_rejects_a_symlinked_data_directory(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / "data").symlink_to(outside, target_is_directory=True)

    with pytest.raises(LocalRuntimeError, match="symbolic-link data"):
        repo_database_path("sqlite:///data/app.db", root=tmp_path)


def test_cleanup_dry_run_and_confirm_touch_only_exact_runtime_files(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    database = data / "app.db"
    targets = sqlite_runtime_files(database)
    for target in targets:
        target.write_bytes(b"synthetic")
    unrelated = data / "app.db-backup"
    unrelated.write_bytes(b"keep")

    planned = clear_local_data(
        "sqlite:///data/app.db",
        root=tmp_path,
        confirmed=False,
        api_is_running=lambda: False,
    )
    assert planned == targets
    assert all(target.exists() for target in targets)

    removed = clear_local_data(
        "sqlite:///data/app.db",
        root=tmp_path,
        confirmed=True,
        api_is_running=lambda: False,
    )
    assert removed == targets
    assert not any(target.exists() for target in targets)
    assert unrelated.read_bytes() == b"keep"


def test_cleanup_refuses_while_api_is_running(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    database = data / "app.db"
    database.write_bytes(b"synthetic")

    with pytest.raises(LocalRuntimeError, match="stop the local API"):
        clear_local_data(
            "sqlite:///data/app.db",
            root=tmp_path,
            confirmed=True,
            api_is_running=lambda: True,
        )

    assert database.exists()
