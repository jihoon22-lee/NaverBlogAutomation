"""Tests for tag-to-version and curated-release-note validation."""

import json
from pathlib import Path

import pytest
from scripts.release_metadata import (
    ReleaseMetadataError,
    extract_changelog_section,
    verify_release_metadata,
    version_from_tag,
)


def write_release_files(root: Path, *, version: str = "0.2.0") -> None:
    (root / "client").mkdir()
    (root / "pyproject.toml").write_text(
        f"[project]\nname = 'naver-blog-assistant'\nversion = '{version}'\n",
        encoding="utf-8",
    )
    (root / "uv.lock").write_text(
        f'[[package]]\nname = "naver-blog-assistant"\nversion = "{version}"\n',
        encoding="utf-8",
    )
    (root / "client/package.json").write_text('{"version": "' + version + '"}\n', encoding="utf-8")
    (root / "client/package-lock.json").write_text(
        json.dumps(
            {"version": version, "packages": {"": {"version": version}}},
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    (root / "CHANGELOG.md").write_text(
        "# Changelog\n\n## [Unreleased]\n\n## [0.2.0]\n\n### 추가\n\n- 테스트 변경\n"
        "\n## [0.1.0]\n\n- 이전 변경\n",
        encoding="utf-8",
    )


def test_verify_release_metadata_accepts_matching_stable_tag(tmp_path: Path) -> None:
    write_release_files(tmp_path)

    assert verify_release_metadata("v0.2.0", root=tmp_path) == "0.2.0"


def test_verify_release_metadata_rejects_mismatched_version(tmp_path: Path) -> None:
    write_release_files(tmp_path)
    package = tmp_path / "client/package.json"
    package.write_text('{"version": "0.1.0"}\n', encoding="utf-8")

    with pytest.raises(ReleaseMetadataError, match="client/package.json=0.1.0"):
        verify_release_metadata("v0.2.0", root=tmp_path)


def test_verify_release_metadata_rejects_mismatched_package_lock_root_version(
    tmp_path: Path,
) -> None:
    write_release_files(tmp_path)
    package_lock = tmp_path / "client/package-lock.json"
    package_lock.write_text(
        '{"version": "0.2.0", "packages": {"": {"version": "0.1.0"}}}\n',
        encoding="utf-8",
    )

    with pytest.raises(
        ReleaseMetadataError,
        match=r'client/package-lock\.json#packages\[""\]\.version=0\.1\.0',
    ):
        verify_release_metadata("v0.2.0", root=tmp_path)


@pytest.mark.parametrize(
    "package_lock",
    [
        {"version": "0.2.0"},
        {"version": "0.2.0", "packages": {}},
        {"version": "0.2.0", "packages": {"": {}}},
        {"version": "0.2.0", "packages": {"": {"version": 200}}},
    ],
)
def test_verify_release_metadata_rejects_missing_package_lock_root_version(
    tmp_path: Path,
    package_lock: dict[str, object],
) -> None:
    write_release_files(tmp_path)
    (tmp_path / "client/package-lock.json").write_text(
        json.dumps(package_lock) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(
        ReleaseMetadataError,
        match=r'client/package-lock\.json#packages\[""\]\.version is missing or not a string',
    ):
        verify_release_metadata("v0.2.0", root=tmp_path)


@pytest.mark.parametrize("tag", ["0.2.0", "v0.2", "v0.2.0-rc.1", "v00.2.0"])
def test_version_from_tag_rejects_non_stable_semver(tag: str) -> None:
    with pytest.raises(ReleaseMetadataError, match="stable vX.Y.Z"):
        version_from_tag(tag)


def test_extract_changelog_section_stops_before_the_next_version(tmp_path: Path) -> None:
    write_release_files(tmp_path)

    notes = extract_changelog_section("0.2.0", root=tmp_path)

    assert "테스트 변경" in notes
    assert "이전 변경" not in notes
