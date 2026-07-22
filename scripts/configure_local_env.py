"""Safely update the non-secret Chrome origin in a local environment file."""

from __future__ import annotations

import argparse
import os
import re
import stat
from collections.abc import Sequence
from pathlib import Path
from uuid import uuid4

from scripts._local_runtime import LocalRuntimeError
from scripts.init_local_env import select_environment_target

EXTENSION_ID_PATTERN = re.compile(r"[a-p]{32}")
ORIGIN_KEY = "CHROME_EXTENSION_ORIGIN"


def validate_extension_id(extension_id: str) -> str:
    """Return one normalized Chrome extension ID or reject it."""
    normalized = extension_id.strip().lower()
    if EXTENSION_ID_PATTERN.fullmatch(normalized) is None:
        raise LocalRuntimeError("extension ID must contain exactly 32 letters from a through p")
    return normalized


def configure_extension_origin(*, target: Path, extension_id: str) -> bool:
    """Atomically replace only the extension origin, preserving secret values."""
    if target.is_symlink() or not target.is_file():
        raise LocalRuntimeError("environment target must be an existing regular file")

    origin = f"chrome-extension://{validate_extension_id(extension_id)}"
    with target.open("r", encoding="utf-8", newline="") as stream:
        lines = stream.readlines()
    matches = [index for index, line in enumerate(lines) if line.startswith(f"{ORIGIN_KEY}=")]
    if len(matches) != 1:
        raise LocalRuntimeError(
            "environment file must contain exactly one extension origin setting"
        )

    index = matches[0]
    newline = "\r\n" if lines[index].endswith("\r\n") else "\n"
    replacement = f"{ORIGIN_KEY}={origin}{newline}"
    if lines[index] == replacement:
        return False
    lines[index] = replacement

    temporary = target.parent / f".{target.name}.{uuid4().hex}.tmp"
    mode = stat.S_IMODE(target.stat().st_mode)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.writelines(lines)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-id", required=True)
    parser.add_argument("--target", type=Path)
    return parser


def main(arguments: Sequence[str] | None = None) -> None:
    """Update one selected environment file without displaying its contents."""
    options = _parser().parse_args(arguments)
    try:
        target, _ = select_environment_target(options.target)
        changed = configure_extension_origin(target=target, extension_id=options.extension_id)
    except (LocalRuntimeError, OSError, UnicodeError) as error:
        raise SystemExit(f"Environment configuration failed: {error}") from None
    result = "updated" if changed else "already configured"
    print(f"Extension origin is {result}; no credential values were displayed.")


if __name__ == "__main__":
    main()
