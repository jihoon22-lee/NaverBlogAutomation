"""Tests for the explicit local versus trusted-LAN socket boundary."""

import pytest

from naver_blog_assistant.api import runtime


def test_local_mode_keeps_the_fixed_loopback_listener(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WEBAPP_ACCESS_MODE", raising=False)
    monkeypatch.delenv("API_HOST", raising=False)
    monkeypatch.delenv("API_PORT", raising=False)

    assert runtime.bind_address_from_environment() == ("127.0.0.1", 8765)


def test_access_mode_is_case_insensitive_and_whitespace_tolerant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEBAPP_ACCESS_MODE", "  LAN ")

    assert runtime.access_mode_from_environment() == "lan"


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


@pytest.mark.parametrize(
    ("mode", "host", "message"),
    [
        ("local", "0.0.0.0", "API_HOST must be 127.0.0.1"),
        ("lan", "127.0.0.1", "API_HOST must be 0.0.0.0"),
    ],
)
def test_bind_address_rejects_a_host_that_weakens_the_selected_boundary(
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    host: str,
    message: str,
) -> None:
    monkeypatch.setenv("WEBAPP_ACCESS_MODE", mode)
    monkeypatch.setenv("API_HOST", host)
    if mode == "lan":
        monkeypatch.setattr(runtime, "private_ipv4_addresses", lambda: {"192.168.1.5"})

    with pytest.raises(ValueError, match=message):
        runtime.bind_address_from_environment()


@pytest.mark.parametrize("raw_port", ["not-a-port", "8764", "8766"])
def test_bind_address_requires_the_fixed_launcher_port(
    monkeypatch: pytest.MonkeyPatch,
    raw_port: str,
) -> None:
    monkeypatch.setenv("API_PORT", raw_port)

    with pytest.raises(ValueError, match="API_PORT"):
        runtime.bind_address_from_environment()


def test_private_ipv4_addresses_filter_public_loopback_and_duplicate_addresses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        runtime.socket,
        "getaddrinfo",
        lambda *_args: [
            (None, None, None, None, ("192.168.1.5", 0)),
            (None, None, None, None, ("8.8.8.8", 0)),
            (None, None, None, None, ("127.0.0.1", 0)),
            (None, None, None, None, ("192.168.1.5", 0)),
        ],
    )

    class ProbeSocket:
        def __enter__(self) -> ProbeSocket:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def connect(self, _address: tuple[str, int]) -> None:
            return None

        def getsockname(self) -> tuple[str, int]:
            return "10.0.0.7", 0

    monkeypatch.setattr(runtime.socket, "socket", lambda *_args: ProbeSocket())

    assert runtime.private_ipv4_addresses() == frozenset({"192.168.1.5", "10.0.0.7"})


def test_private_ipv4_addresses_stays_empty_when_network_discovery_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_getaddrinfo(*_args: object) -> None:
        raise OSError("resolver unavailable")

    class FailingProbe:
        def __enter__(self) -> FailingProbe:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def connect(self, _address: tuple[str, int]) -> None:
            raise OSError("network unavailable")

    monkeypatch.setattr(runtime.socket, "getaddrinfo", fail_getaddrinfo)
    monkeypatch.setattr(runtime.socket, "socket", lambda *_args: FailingProbe())

    assert runtime.private_ipv4_addresses() == frozenset()


@pytest.mark.parametrize("mode", ["", "public", "remote"])
def test_unknown_access_mode_is_rejected(monkeypatch: pytest.MonkeyPatch, mode: str) -> None:
    monkeypatch.setenv("WEBAPP_ACCESS_MODE", mode)

    with pytest.raises(ValueError, match="WEBAPP_ACCESS_MODE"):
        runtime.access_mode_from_environment()
