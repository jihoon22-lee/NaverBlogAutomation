"""Tests for the dedicated automation profile location."""

from __future__ import annotations

from pathlib import Path

import pytest

from naver_blog_assistant.infrastructure.browser import resolve_profile_dir


def test_linux_profile_defaults_under_local_share() -> None:
    resolved = resolve_profile_dir(platform="linux", environment={}, home=Path("/home/tester"))

    assert resolved == Path("/home/tester/.local/share/naver-blog-assistant/browser-profile")


def test_linux_profile_honors_xdg_data_home() -> None:
    resolved = resolve_profile_dir(
        platform="linux",
        environment={"XDG_DATA_HOME": "/data/xdg"},
        home=Path("/home/tester"),
    )

    assert resolved == Path("/data/xdg/naver-blog-assistant/browser-profile")


def test_blank_xdg_data_home_falls_back_to_home() -> None:
    resolved = resolve_profile_dir(
        platform="linux",
        environment={"XDG_DATA_HOME": "   "},
        home=Path("/home/tester"),
    )

    assert resolved == Path("/home/tester/.local/share/naver-blog-assistant/browser-profile")


def test_macos_profile_uses_application_support() -> None:
    resolved = resolve_profile_dir(platform="darwin", environment={}, home=Path("/Users/tester"))

    assert resolved == Path(
        "/Users/tester/Library/Application Support/naver-blog-assistant/browser-profile"
    )


def test_windows_profile_uses_local_appdata() -> None:
    resolved = resolve_profile_dir(
        platform="win32",
        environment={"LOCALAPPDATA": "C:\\Users\\tester\\AppData\\Local"},
        home=Path("C:/Users/tester"),
    )

    assert resolved.parts[-2:] == ("naver-blog-assistant", "browser-profile")
    assert "AppData" in str(resolved)


def test_windows_profile_falls_back_when_local_appdata_missing() -> None:
    resolved = resolve_profile_dir(platform="win32", environment={}, home=Path("/home/tester"))

    assert resolved == Path("/home/tester/AppData/Local/naver-blog-assistant/browser-profile")


@pytest.mark.parametrize("platform", ["linux", "darwin", "win32", "freebsd"])
def test_explicit_configuration_wins_on_every_platform(platform: str) -> None:
    resolved = resolve_profile_dir(
        configured="  /explicit/profile  ",
        platform=platform,
        environment={"XDG_DATA_HOME": "/ignored", "LOCALAPPDATA": "/ignored"},
        home=Path("/home/tester"),
    )

    assert resolved == Path("/explicit/profile")


def test_explicit_configuration_expands_user_home() -> None:
    resolved = resolve_profile_dir(
        configured="~/automation-profile",
        platform="linux",
        environment={},
        home=Path("/home/tester"),
    )

    assert not str(resolved).startswith("~")


def test_unknown_platform_uses_the_linux_layout() -> None:
    resolved = resolve_profile_dir(platform="freebsd", environment={}, home=Path("/home/tester"))

    assert resolved == Path("/home/tester/.local/share/naver-blog-assistant/browser-profile")
