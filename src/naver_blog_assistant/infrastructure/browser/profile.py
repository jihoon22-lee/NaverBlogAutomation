"""Dedicated browser profile location for the local automation session.

The profile is intentionally separate from the user's everyday browser profile so the automation
surface cannot read unrelated sessions, and it is persistent so a manual sign-in survives restarts.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

PROFILE_DIRECTORY_NAME = "browser-profile"
APPLICATION_DIRECTORY_NAME = "naver-blog-assistant"


def resolve_profile_dir(
    *,
    configured: str = "",
    platform: str,
    environment: Mapping[str, str],
    home: Path,
) -> Path:
    """Return the persistent profile directory for ``platform`` without creating it."""
    explicit = configured.strip()
    if explicit:
        return Path(explicit).expanduser()
    if platform == "win32":
        base = environment.get("LOCALAPPDATA", "").strip()
        root = Path(base) if base else home / "AppData" / "Local"
    elif platform == "darwin":
        root = home / "Library" / "Application Support"
    else:
        base = environment.get("XDG_DATA_HOME", "").strip()
        root = Path(base) if base else home / ".local" / "share"
    return root / APPLICATION_DIRECTORY_NAME / PROFILE_DIRECTORY_NAME
