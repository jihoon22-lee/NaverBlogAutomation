"""Tests for the loopback-only process launcher."""

import pytest

from naver_blog_assistant.api import __main__ as launcher


def test_launcher_rejects_non_loopback_binding(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_HOST", "0.0.0.0")

    with pytest.raises(RuntimeError, match="127.0.0.1"):
        launcher.main()
