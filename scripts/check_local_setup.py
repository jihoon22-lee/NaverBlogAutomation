"""Diagnose the local runtime without retaining or printing credential values."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from naver_blog_assistant.api import ApiSettings
from naver_blog_assistant.api.runtime import (
    LOOPBACK_HOST,
    LOOPBACK_PORT,
    bind_address_from_environment,
)
from scripts._local_runtime import (
    REPOSITORY_ROOT,
    LocalRuntimeError,
    repo_database_path,
)

PLACEHOLDER_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
EXPECTED_HOST_PERMISSION = "http://127.0.0.1:8765/*"


@dataclass(frozen=True, slots=True)
class CheckResult:
    """One redacted setup check suitable for terminal output."""

    name: str
    ok: bool
    detail: str


def _tool_version(command: str, expected_major: int | None) -> CheckResult:
    path = shutil.which(command)
    if path is None:
        return CheckResult(command, False, f"not found; install {command} before continuing")
    try:
        completed = subprocess.run(
            [path, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except OSError, subprocess.SubprocessError:
        return CheckResult(command, False, "version command failed")
    match = re.search(r"(?:^|\D)(\d+)(?:\.|$)", completed.stdout or completed.stderr)
    if completed.returncode != 0 or match is None:
        return CheckResult(command, False, "version could not be determined")
    major = int(match.group(1))
    if expected_major is None:
        return CheckResult(command, True, "version command succeeded")
    return CheckResult(
        command,
        major == expected_major,
        f"major version {major}; expected {expected_major}",
    )


def _python_check() -> CheckResult:
    actual = f"{sys.version_info.major}.{sys.version_info.minor}"
    return CheckResult("Python", sys.version_info[:2] == (3, 14), f"{actual}; expected 3.14")


def _environment_file_check(path: Path, *, require_private_parent: bool = False) -> CheckResult:
    if path.is_symlink():
        return CheckResult(".env.local", False, "symbolic links are not accepted")
    if not path.is_file():
        return CheckResult(
            ".env.local",
            False,
            "missing; initialize it securely before passing it to `uv run --env-file`",
        )
    if os.name != "posix":
        return CheckResult(".env.local", True, "exists; POSIX permission check is not applicable")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode != 0o600:
        return CheckResult(".env.local", False, f"mode {mode:04o}; expected 0600")
    if require_private_parent:
        if path.parent.is_symlink():
            return CheckResult(".env.local", False, "config parent must not be a symbolic link")
        parent_mode = stat.S_IMODE(path.parent.stat().st_mode)
        if parent_mode != 0o700:
            return CheckResult(
                ".env.local",
                False,
                f"parent mode {parent_mode:04o}; expected 0700",
            )
    return CheckResult(".env.local", True, "private file permissions are enforced")


def _configuration_check() -> CheckResult:
    try:
        bind_address_from_environment()
        ApiSettings.validate_environment_without_secrets()
    except ValueError as error:
        return CheckResult("Runtime config", False, str(error))
    return CheckResult("Runtime config", True, "non-secret settings satisfy the local contract")


def _origin_check() -> CheckResult:
    origin = os.getenv("CHROME_EXTENSION_ORIGIN", "").strip()
    if origin == PLACEHOLDER_ORIGIN:
        return CheckResult(
            "Extension origin", False, "replace the placeholder with the unpacked ID"
        )
    if not re.fullmatch(r"chrome-extension://[a-p]{32}", origin):
        return CheckResult("Extension origin", False, "expected one exact Chrome extension ID")
    return CheckResult("Extension origin", True, "configured without displaying the ID")


def _api_key_check() -> CheckResult:
    mode = os.getenv("COMMENT_GENERATOR_MODE", "openai").strip().lower()
    if mode != "openai":
        return CheckResult("OpenAI credential", True, "not required in deterministic fake mode")
    configured = bool(os.getenv("OPENAI_API_KEY", "").strip())
    detail = (
        "non-empty environment variable is configured; value was not retained"
        if configured
        else "missing or empty"
    )
    return CheckResult("OpenAI credential presence", configured, detail)


def _database_check(root: Path) -> CheckResult:
    try:
        path = repo_database_path(
            os.getenv("DATABASE_URL", "sqlite:///data/naver_blog_assistant.db"),
            root=root,
        )
    except LocalRuntimeError as error:
        return CheckResult("SQLite path", False, str(error))
    return CheckResult("SQLite path", True, f"repo-local target data/{path.name}")


def _extension_build_check(root: Path) -> CheckResult:
    manifest_path = root / "extension" / "dist" / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return CheckResult("Extension build", False, "missing; run the extension build first")
    except OSError, json.JSONDecodeError:
        return CheckResult("Extension build", False, "manifest.json is not readable JSON")
    permissions = manifest.get("host_permissions") if isinstance(manifest, dict) else None
    if permissions != [EXPECTED_HOST_PERMISSION]:
        return CheckResult("Extension build", False, "loopback host permission does not match")
    return CheckResult("Extension build", True, "built manifest uses the fixed loopback permission")


def _health_check() -> CheckResult:
    origin = os.getenv("CHROME_EXTENSION_ORIGIN", "")
    request = urllib.request.Request(
        f"http://{LOOPBACK_HOST}:{LOOPBACK_PORT}/health",
        headers={"Origin": origin},
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            payload = json.load(response)
            allowed_origin = response.headers.get("Access-Control-Allow-Origin")
            ok = response.status == 200 and payload == {"status": "ok"} and allowed_origin == origin
    except OSError, ValueError, urllib.error.URLError:
        return CheckResult(
            "API health/CORS", False, "API is not reachable with the configured origin"
        )
    return CheckResult(
        "API health/CORS",
        ok,
        "health and exact-origin CORS succeeded" if ok else "health or CORS response did not match",
    )


def collect_checks(
    *,
    root: Path = REPOSITORY_ROOT,
    environment_file: Path | None = None,
    require_api: bool = False,
) -> list[CheckResult]:
    """Collect redacted, side-effect-free checks for a fresh local setup."""
    default_environment = root / ".env.local"
    selected_environment = default_environment if environment_file is None else environment_file
    checks = [
        _python_check(),
        _tool_version("uv", None),
        _tool_version("node", 24),
        _tool_version("npm", 11),
        _environment_file_check(
            selected_environment.expanduser(),
            require_private_parent=environment_file is not None
            and selected_environment.resolve(strict=False)
            != default_environment.resolve(strict=False),
        ),
        _configuration_check(),
        _origin_check(),
        _api_key_check(),
        _database_check(root),
        _extension_build_check(root),
    ]
    if require_api:
        checks.append(_health_check())
    return checks


def main(arguments: Sequence[str] | None = None) -> None:
    """Print a redacted setup report and fail when any required check fails."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--require-api", action="store_true", help="also require live health and CORS"
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        help="environment file passed separately to `uv run --env-file`",
    )
    options = parser.parse_args(arguments)
    checks = collect_checks(
        environment_file=options.env_file,
        require_api=options.require_api,
    )
    for result in checks:
        marker = "OK" if result.ok else "ERROR"
        print(f"[{marker}] {result.name}: {result.detail}")
    failures = sum(not result.ok for result in checks)
    if failures:
        raise SystemExit(f"Setup check failed: {failures} issue(s) require attention.")
    print("Setup check passed without retaining or printing credential values.")


if __name__ == "__main__":
    main()
