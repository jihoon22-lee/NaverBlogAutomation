"""Serve the local web app from the same loopback origin as the API.

Same-origin hosting removes the extension's CORS coupling entirely. The built assets come from
`client/dist`; when they are missing the mount is skipped so the API still starts.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

APP_MOUNT_PATH: Final = "/app"
APP_DIST_RELATIVE: Final = Path("client") / "dist"


def resolve_app_directory(root: Path | None = None) -> Path | None:
    """Return the built web app directory when it exists."""
    base = root if root is not None else Path(__file__).resolve().parents[4]
    candidate = base / APP_DIST_RELATIVE
    return candidate if (candidate / "index.html").is_file() else None


def register_app_mount(app: FastAPI, *, directory: Path | None = None) -> bool:
    """Mount the built web app at ``/app`` and report whether it was mounted."""
    target = directory if directory is not None else resolve_app_directory()
    if target is None:
        return False
    app.mount(
        APP_MOUNT_PATH,
        StaticFiles(directory=target, html=True),
        name="webapp",
    )
    return True
