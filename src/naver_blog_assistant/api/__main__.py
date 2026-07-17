"""Loopback-only Uvicorn launcher."""

from __future__ import annotations

import os

import uvicorn

from naver_blog_assistant.api import ApiSettings, create_app


def main() -> None:
    """Start the API on the fixed loopback interface and reject unsafe overrides."""
    host = os.getenv("API_HOST", "127.0.0.1").strip()
    if host != "127.0.0.1":
        raise RuntimeError("API_HOST must be 127.0.0.1; non-loopback binding is forbidden")
    port = int(os.getenv("API_PORT", "8765"))
    uvicorn.run(create_app(ApiSettings.from_environment()), host=host, port=port)


if __name__ == "__main__":
    main()
