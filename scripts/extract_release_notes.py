"""Write one checked-in CHANGELOG section for use as GitHub Release notes."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

from scripts.release_metadata import ReleaseMetadataError, extract_changelog_section


def main(arguments: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args(arguments)
    try:
        notes = extract_changelog_section(options.version)
        options.output.write_text(notes + "\n", encoding="utf-8")
    except (OSError, ReleaseMetadataError) as error:
        raise SystemExit(f"Release note extraction failed: {error}") from None


if __name__ == "__main__":
    main()
