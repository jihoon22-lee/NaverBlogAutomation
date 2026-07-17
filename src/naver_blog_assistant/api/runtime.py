"""Fixed local transport contract shared by the launcher and setup tools."""

from __future__ import annotations

import os
from typing import Final

LOOPBACK_HOST: Final = "127.0.0.1"
LOOPBACK_PORT: Final = 8765


def bind_address_from_environment() -> tuple[str, int]:
    """Return the fixed bind address and reject misleading or unsafe overrides."""
    host = os.getenv("API_HOST", LOOPBACK_HOST).strip()
    if host != LOOPBACK_HOST:
        raise ValueError("API_HOST must be 127.0.0.1; non-loopback binding is forbidden")

    raw_port = os.getenv("API_PORT", str(LOOPBACK_PORT)).strip()
    try:
        port = int(raw_port)
    except ValueError:
        raise ValueError("API_PORT must be the integer 8765") from None
    if port != LOOPBACK_PORT:
        raise ValueError("API_PORT must be 8765 because the extension permission is fixed")
    return host, port
