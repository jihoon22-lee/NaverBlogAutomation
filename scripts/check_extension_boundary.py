"""Fail when the web app or the Python service reaches into the frozen extension.

`extension/` is frozen at v0.5.6. Its DOM logic was copied into `client/src/page/` on purpose rather
than shared, so a refactor of the web app can never regress the extension. This check keeps that
boundary mechanical: as long as it passes, `client/` and `src/` can be split into their own
repository with `git subtree split` without untangling imports first.
"""

from __future__ import annotations

import re
import sys
from collections.abc import Iterator
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WATCHED = ("client/src", "client/tests", "src", "tests", "scripts")
SUFFIXES = (".ts", ".tsx", ".js", ".mjs", ".py")

# `from "../../extension/..."`, `require("extension/...")`, `import extension.foo`
TS_PATTERN = re.compile(r"""(?:from|import|require)\s*\(?\s*['"]([^'"]*\bextension/[^'"]*)['"]""")
PY_PATTERN = re.compile(r"^\s*(?:from|import)\s+extension\b", re.MULTILINE)


def watched_files() -> Iterator[Path]:
    """Yield every source file that must stay independent of the extension."""
    for relative in WATCHED:
        base = ROOT / relative
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if path.is_file() and path.suffix in SUFFIXES:
                yield path


def violations(path: Path) -> list[str]:
    """Report every import in ``path`` that crosses into the extension."""
    text = path.read_text(encoding="utf-8")
    found: list[str] = []
    if path.suffix == ".py":
        found.extend(match.group(0).strip() for match in PY_PATTERN.finditer(text))
        return found
    for match in TS_PATTERN.finditer(text):
        target = match.group(1)
        relative = target.startswith("./extension/") or "/extension/" in target
        if relative or target.startswith("extension/"):
            found.append(target)
    return found


def main() -> int:
    """Print every boundary violation and fail when at least one exists."""
    failures: list[tuple[Path, str]] = []
    for path in watched_files():
        for found in violations(path):
            failures.append((path.relative_to(ROOT), found))
    if not failures:
        print(f"no extension imports found in {', '.join(WATCHED)}")
        return 0
    print("the frozen extension must not be imported:")
    for path, found in failures:
        print(f"  {path}: {found}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
