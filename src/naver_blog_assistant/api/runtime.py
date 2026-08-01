"""Fixed local transport contract shared by the launcher and setup tools."""

from __future__ import annotations

import os
import socket
from ipaddress import IPv4Address, ip_address
from typing import Final, Literal, cast

LOOPBACK_HOST: Final = "127.0.0.1"
LOOPBACK_PORT: Final = 8765
LAN_BIND_HOST: Final = "0.0.0.0"
WebAppAccessMode = Literal["local", "lan"]


def access_mode_from_environment() -> WebAppAccessMode:
    """Read the explicit web-app access boundary without silently enabling LAN mode."""
    mode = os.getenv("WEBAPP_ACCESS_MODE", "local").strip().lower()
    if mode not in {"local", "lan"}:
        raise ValueError("WEBAPP_ACCESS_MODE must be local or lan")
    return cast(WebAppAccessMode, mode)


def private_ipv4_addresses() -> frozenset[str]:
    """Return private IPv4 addresses currently assigned to this desktop, never public addresses."""
    candidates: set[str] = set()
    try:
        for result in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = result[4][0]
            if isinstance(address, str):
                candidates.add(address)
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))
            candidates.add(probe.getsockname()[0])
    except OSError:
        pass
    return frozenset(
        value
        for value in candidates
        if isinstance(ip_address(value), IPv4Address)
        and ip_address(value).is_private
        and not ip_address(value).is_loopback
    )


def bind_address_from_environment() -> tuple[str, int]:
    """Return the fixed local address or the explicit trusted-LAN listener address."""
    mode = access_mode_from_environment()
    expected_host = LOOPBACK_HOST if mode == "local" else LAN_BIND_HOST
    host = os.getenv("API_HOST", expected_host).strip()
    if host != expected_host:
        raise ValueError(f"API_HOST must be {expected_host} when WEBAPP_ACCESS_MODE={mode}")
    if mode == "lan" and not private_ipv4_addresses():
        raise ValueError("no private IPv4 address was found for WEBAPP_ACCESS_MODE=lan")

    raw_port = os.getenv("API_PORT", str(LOOPBACK_PORT)).strip()
    try:
        port = int(raw_port)
    except ValueError:
        raise ValueError("API_PORT must be the integer 8765") from None
    if port != LOOPBACK_PORT:
        raise ValueError("API_PORT must be 8765 for the web-app launcher")
    return host, port
