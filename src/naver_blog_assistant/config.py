"""Application configuration loaded from process environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_DATABASE_URL = "sqlite:///data/naver_blog_assistant.db"


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime settings containing no hard-coded credentials."""

    openai_api_key: str
    database_url: str = DEFAULT_DATABASE_URL

    @classmethod
    def from_environment(cls) -> Settings:
        """Create settings from environment variables or fail with a safe message."""
        api_key = os.getenv("OPENAI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY is not configured")

        return cls(
            openai_api_key=api_key,
            database_url=os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL),
        )
