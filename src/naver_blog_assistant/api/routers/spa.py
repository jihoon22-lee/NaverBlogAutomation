"""Serve the local web app from the same origin as the API.

The installed wheel owns a copy of the built assets. Editable source checkouts fall back to
``client/dist`` so frontend development remains straightforward.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

APP_MOUNT_PATH: Final = "/app"
APP_DIST_RELATIVE: Final = Path("client") / "dist"
PACKAGED_APP_DIRECTORY: Final = Path("static_app")


def resolve_app_directory(root: Path | None = None) -> Path | None:
    """Return packaged assets first, then the editable source build when available."""
    if root is not None:
        candidate = root / APP_DIST_RELATIVE
        return candidate if (candidate / "index.html").is_file() else None
    packaged = Path(__file__).resolve().parents[1] / PACKAGED_APP_DIRECTORY
    if (packaged / "index.html").is_file():
        return packaged
    candidate = Path(__file__).resolve().parents[4] / APP_DIST_RELATIVE
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
