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


def _naver_search_api_check() -> CheckResult:
    """Report optional Search API readiness without retaining either credential."""
    client_id = bool(os.getenv("NAVER_SEARCH_CLIENT_ID", "").strip())
    client_secret = bool(os.getenv("NAVER_SEARCH_CLIENT_SECRET", "").strip())
    if client_id and client_secret:
        return CheckResult(
            "Naver Search API", True, "both required environment variables are configured"
        )
    if client_id or client_secret:
        return CheckResult(
            "Naver Search API", False, "configure NAVER_SEARCH_CLIENT_ID and SECRET together"
        )
    return CheckResult(
        "Naver Search API", True, "optional; configure both variables to use 신규 이웃 검색"
    )


def _database_check(root: Path) -> CheckResult:
    try:
        path = repo_database_path(
            os.getenv("DATABASE_URL", "sqlite:///data/naver_blog_assistant.db"),
            root=root,
        )
    except LocalRuntimeError as error:
        return CheckResult("SQLite path", False, str(error))
    return CheckResult("SQLite path", True, f"repo-local target data/{path.name}")


def _web_app_build_check(root: Path) -> CheckResult:
    directory = root / "client" / "dist"
    required = (directory / "index.html", directory / "app.js", directory / "app.css")
    if not all(path.is_file() for path in required):
        return CheckResult("Web app build", False, "missing; run `npm --prefix client run build`")
    return CheckResult("Web app build", True, "built assets are ready for /app")


def _health_check() -> CheckResult:
    request = urllib.request.Request(f"http://{LOOPBACK_HOST}:{LOOPBACK_PORT}/health")
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            payload = json.load(response)
            ok = response.status == 200 and payload == {"status": "ok"}
    except OSError, ValueError, urllib.error.URLError:
        return CheckResult("API health", False, "API is not reachable on the local web-app address")
    return CheckResult(
        "API health",
        ok,
        "health check succeeded" if ok else "health response did not match",
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
        _api_key_check(),
        _naver_search_api_check(),
        _database_check(root),
        _web_app_build_check(root),
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
