"""Tests for the explicit local versus trusted-LAN socket boundary."""

import pytest

from naver_blog_assistant.api import runtime


def test_local_mode_keeps_the_fixed_loopback_listener(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WEBAPP_ACCESS_MODE", raising=False)
    monkeypatch.delenv("API_HOST", raising=False)
    monkeypatch.delenv("API_PORT", raising=False)

    assert runtime.bind_address_from_environment() == ("127.0.0.1", 8765)


def test_lan_mode_requires_a_private_address_and_the_wildcard_bind(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEBAPP_ACCESS_MODE", "lan")
    monkeypatch.setenv("API_HOST", "0.0.0.0")
    monkeypatch.setenv("API_PORT", "8765")
    monkeypatch.setattr(runtime, "private_ipv4_addresses", lambda: {"192.168.1.5"})

    assert runtime.bind_address_from_environment() == ("0.0.0.0", 8765)


def test_lan_mode_refuses_to_bind_without_a_private_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEBAPP_ACCESS_MODE", "lan")
    monkeypatch.setenv("API_HOST", "0.0.0.0")
    monkeypatch.setattr(runtime, "private_ipv4_addresses", frozenset)

    with pytest.raises(ValueError, match="no private IPv4"):
        runtime.bind_address_from_environment()


@pytest.mark.parametrize("mode", ["", "public", "remote"])
def test_unknown_access_mode_is_rejected(monkeypatch: pytest.MonkeyPatch, mode: str) -> None:
    monkeypatch.setenv("WEBAPP_ACCESS_MODE", mode)

    with pytest.raises(ValueError, match="WEBAPP_ACCESS_MODE"):
        runtime.access_mode_from_environment()
