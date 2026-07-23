"""Check that a pushed tag matches all product-version metadata."""

from __future__ import annotations

import argparse
import tomllib
from collections.abc import Sequence

from scripts.release_metadata import ReleaseMetadataError, verify_release_metadata


def main(arguments: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    options = parser.parse_args(arguments)
    try:
        version = verify_release_metadata(options.tag)
    except (OSError, ReleaseMetadataError, ValueError, tomllib.TOMLDecodeError) as error:
        raise SystemExit(f"Release metadata check failed: {error}") from None
    print(f"Release metadata verified for v{version}.")


if __name__ == "__main__":
    main()
