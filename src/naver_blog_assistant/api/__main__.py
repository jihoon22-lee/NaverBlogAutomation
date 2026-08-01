"""Uvicorn launcher for the default loopback or explicit trusted-LAN web app."""

from __future__ import annotations

import uvicorn

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.api.runtime import bind_address_from_environment


def main() -> None:
    """Start the API on the fixed loopback interface and reject unsafe overrides."""
    try:
        host, port = bind_address_from_environment()
        settings = ApiSettings.from_environment()
        app = create_app(settings)
    except ValueError as error:
        raise RuntimeError(f"Local API configuration is invalid: {error}") from None
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
