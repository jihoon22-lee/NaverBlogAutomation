"""Create the local environment file without overwriting or exposing credentials."""

from __future__ import annotations

import argparse
import os
import stat
from collections.abc import Sequence
from contextlib import suppress
from pathlib import Path
from uuid import uuid4

from scripts._local_runtime import REPOSITORY_ROOT, LocalRuntimeError


def ensure_private_directory(directory: Path) -> None:
    """Create the requested config directory and enforce mode 0700 on its final path."""
    directory = directory.expanduser()
    missing: list[Path] = []
    cursor = directory
    while not cursor.exists():
        missing.append(cursor)
        if cursor.parent == cursor:
            break
        cursor = cursor.parent
    created: list[Path] = []
    try:
        for path in reversed(missing):
            path.mkdir(mode=0o700)
            created.append(path)
        if directory.is_symlink() or not directory.is_dir():
            raise LocalRuntimeError("environment-file parent must be a real directory")
        if missing:
            os.chmod(directory, 0o700)
        if os.name == "posix" and stat.S_IMODE(directory.stat().st_mode) != 0o700:
            raise LocalRuntimeError(
                "the config directory must have mode 0700; choose a private app directory"
            )
    except Exception:
        for path in reversed(created):
            with suppress(OSError):
                path.rmdir()
        raise


def initialize_local_environment(*, template: Path, target: Path) -> None:
    """Atomically publish a mode-0600 copy of the public environment template."""
    if target.exists() or target.is_symlink():
        raise LocalRuntimeError(".env.local already exists; refusing to overwrite it")
    contents = template.read_bytes()
    temporary = target.parent / f".{target.name}.{uuid4().hex}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    linked = False
    published = False
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        try:
            os.link(temporary, target)
        except FileExistsError:
            raise LocalRuntimeError(
                ".env.local appeared during setup; nothing was overwritten"
            ) from None
        linked = True
        os.chmod(target, 0o600)
        if os.name == "posix" and stat.S_IMODE(target.stat().st_mode) != 0o600:
            raise LocalRuntimeError(
                "the filesystem could not enforce mode 0600; retry with --target on a "
                "POSIX-permission filesystem or use the process environment"
            )
        published = True
    finally:
        temporary.unlink(missing_ok=True)
        if linked and not published:
            target.unlink(missing_ok=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target",
        type=Path,
        help="explicit private env path, for example ~/.config/naver-blog-assistant/env",
    )
    return parser


def select_environment_target(
    requested: Path | None, *, repository_root: Path = REPOSITORY_ROOT
) -> tuple[Path, bool]:
    """Select the default target or validate one explicit path outside the repository."""
    default_target = (repository_root / ".env.local").resolve(strict=False)
    if requested is None:
        return default_target, False
    target = requested.expanduser().resolve(strict=False)
    repository = repository_root.resolve()
    if target.is_relative_to(repository) and target != default_target:
        raise LocalRuntimeError("explicit targets inside the repository are forbidden")
    return target, target != default_target


def main(arguments: Sequence[str] | None = None) -> None:
    """Create the repository's one supported local environment file."""
    options = _parser().parse_args(arguments)
    try:
        target, prepare_parent = select_environment_target(options.target)
        if prepare_parent:
            ensure_private_directory(target.parent)
        initialize_local_environment(
            template=REPOSITORY_ROOT / ".env.example",
            target=target,
        )
    except (LocalRuntimeError, OSError) as error:
        raise SystemExit(f"Environment setup failed: {error}") from None
    print("Created a restricted local environment file; replace the extension ID before use.")


if __name__ == "__main__":
    main()
