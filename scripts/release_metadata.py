"""Validate product-version metadata and extract user-facing release notes."""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path
from typing import Final

TAG_PATTERN: Final = re.compile(r"^v(?P<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$")
CHANGELOG_HEADING: Final = re.compile(r"^## \[(?P<version>[^\]]+)\](?:\s|$)")
REPOSITORY_ROOT: Final = Path(__file__).resolve().parents[1]
PACKAGE_LOCK_ROOT_VERSION: Final = 'client/package-lock.json#packages[""].version'


class ReleaseMetadataError(RuntimeError):
    """Raised when a tag cannot safely describe the checked-in release metadata."""


def version_from_tag(tag: str) -> str:
    """Return a stable semantic version encoded by a v-prefixed tag."""
    match = TAG_PATTERN.fullmatch(tag)
    if match is None:
        raise ReleaseMetadataError("release tag must use the stable vX.Y.Z format")
    return match.group("version")


def checked_in_versions(*, root: Path = REPOSITORY_ROOT) -> dict[str, str]:
    """Read each public product-version surface without modifying repository files."""
    pyproject = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    package = json.loads((root / "client/package.json").read_text(encoding="utf-8"))
    package_lock = json.loads((root / "client/package-lock.json").read_text(encoding="utf-8"))
    lockfile = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))
    locked_project = next(
        (
            package
            for package in lockfile.get("package", [])
            if isinstance(package, dict) and package.get("name") == "naver-blog-assistant"
        ),
        None,
    )
    if not isinstance(locked_project, dict) or not isinstance(locked_project.get("version"), str):
        raise ReleaseMetadataError(
            "uv.lock does not contain the local naver-blog-assistant package"
        )
    package_lock_packages = package_lock.get("packages")
    package_lock_root = (
        package_lock_packages.get("") if isinstance(package_lock_packages, dict) else None
    )
    if not isinstance(package_lock_root, dict) or not isinstance(
        package_lock_root.get("version"), str
    ):
        raise ReleaseMetadataError(f"{PACKAGE_LOCK_ROOT_VERSION} is missing or not a string")
    versions = {
        "pyproject.toml": str(pyproject["project"]["version"]),
        "uv.lock": locked_project["version"],
        "client/package.json": str(package["version"]),
        "client/package-lock.json": str(package_lock["version"]),
        PACKAGE_LOCK_ROOT_VERSION: package_lock_root["version"],
    }
    return versions


def extract_changelog_section(version: str, *, root: Path = REPOSITORY_ROOT) -> str:
    """Return one non-empty version section from CHANGELOG.md."""
    lines = (root / "CHANGELOG.md").read_text(encoding="utf-8").splitlines()
    start: int | None = None
    for index, line in enumerate(lines):
        match = CHANGELOG_HEADING.match(line)
        if match is not None and match.group("version") == version:
            start = index + 1
            break
    if start is None:
        raise ReleaseMetadataError(f"CHANGELOG.md does not contain a [{version}] section")
    section: list[str] = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        section.append(line)
    result = "\n".join(section).strip()
    if not result:
        raise ReleaseMetadataError(f"CHANGELOG.md [{version}] must contain user-facing changes")
    return result


def verify_release_metadata(tag: str, *, root: Path = REPOSITORY_ROOT) -> str:
    """Reject a release tag that diverges from the versioned product metadata."""
    version = version_from_tag(tag)
    mismatches = {
        path: value for path, value in checked_in_versions(root=root).items() if value != version
    }
    if mismatches:
        details = ", ".join(f"{path}={value}" for path, value in mismatches.items())
        raise ReleaseMetadataError(
            f"release tag v{version} does not match checked-in versions: {details}"
        )
    extract_changelog_section(version, root=root)
    return version
