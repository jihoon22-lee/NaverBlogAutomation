"""Pair trusted LAN devices without ever persisting bearer or CSRF token plaintext."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol
from uuid import UUID

PAIRING_CODE_LIFETIME = timedelta(minutes=5)
REMOTE_SESSION_LIFETIME = timedelta(days=30)
MAX_PAIRING_ATTEMPTS_PER_CLIENT = 5


class PairingRejectedError(ValueError):
    """Raised when a LAN pairing code is expired, invalid, or rate limited."""


@dataclass(frozen=True, slots=True)
class RemoteDeviceSession:
    """Redacted metadata for one paired tablet or other LAN browser."""

    id: UUID
    device_name: str
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    revoked_at: datetime | None


@dataclass(frozen=True, slots=True)
class PairedRemoteDevice:
    """One newly issued bearer token pair, held only until the HTTP response writes cookies."""

    device: RemoteDeviceSession
    csrf_token: str
    session_token: str


class RemoteDeviceSessionStore(Protocol):
    """Persist only token digests and audited device metadata."""

    def create(
        self,
        *,
        device_name: str,
        token_hash: str,
        csrf_hash: str,
        now: datetime,
        expires_at: datetime,
    ) -> RemoteDeviceSession:
        """Store one device session and return its redacted metadata."""
        ...

    def authenticate(self, *, token_hash: str, now: datetime) -> RemoteDeviceSession | None:
        """Return one active session and record its recent use."""
        ...

    def csrf_matches(self, *, session_id: UUID, csrf_hash: str, now: datetime) -> bool:
        """Return whether one active session owns the supplied CSRF digest."""
        ...

    def list_active(self, *, now: datetime) -> tuple[RemoteDeviceSession, ...]:
        """Return active paired devices without bearer material."""
        ...

    def revoke(self, session_id: UUID, *, now: datetime) -> bool:
        """Revoke one paired device and report whether it existed."""
        ...


class RemoteAccessService:
    """Own one memory-only pairing code and durable hashed device sessions."""

    def __init__(self, store: RemoteDeviceSessionStore) -> None:
        self._store = store
        self._pairing_code_hash: str | None = None
        self._pairing_expires_at: datetime | None = None
        self._pairing_attempts: dict[str, int] = {}

    def create_pairing_code(self, *, now: datetime) -> tuple[str, datetime]:
        """Issue a five-minute code and invalidate any preceding code immediately."""
        code = secrets.token_urlsafe(18)
        expires_at = now + PAIRING_CODE_LIFETIME
        self._pairing_code_hash = _digest(code)
        self._pairing_expires_at = expires_at
        self._pairing_attempts.clear()
        return code, expires_at

    def pair(
        self,
        *,
        code: str,
        device_name: str,
        client_id: str,
        now: datetime,
    ) -> PairedRemoteDevice:
        """Consume a pairing code once and return cookies for the newly trusted device."""
        normalized_name = " ".join(device_name.split())
        if not 1 <= len(normalized_name) <= 80:
            raise PairingRejectedError("device_name_invalid")
        attempts = self._pairing_attempts.get(client_id, 0)
        if attempts >= MAX_PAIRING_ATTEMPTS_PER_CLIENT:
            raise PairingRejectedError("pairing_rate_limited")
        expected = self._pairing_code_hash
        expires_at = self._pairing_expires_at
        if (
            expected is None
            or expires_at is None
            or now >= expires_at
            or not hmac.compare_digest(expected, _digest(code))
        ):
            self._pairing_attempts[client_id] = attempts + 1
            raise PairingRejectedError("pairing_code_invalid")
        self._pairing_code_hash = None
        self._pairing_expires_at = None
        self._pairing_attempts.clear()
        session_token = secrets.token_urlsafe(32)
        csrf_token = secrets.token_urlsafe(32)
        device = self._store.create(
            device_name=normalized_name,
            token_hash=_digest(session_token),
            csrf_hash=_digest(csrf_token),
            now=now,
            expires_at=now + REMOTE_SESSION_LIFETIME,
        )
        return PairedRemoteDevice(
            device=device,
            csrf_token=csrf_token,
            session_token=session_token,
        )

    def authenticate(self, *, session_token: str, now: datetime) -> RemoteDeviceSession | None:
        """Return the active device represented by an opaque bearer token."""
        return self._store.authenticate(token_hash=_digest(session_token), now=now)

    def csrf_matches(
        self,
        *,
        session: RemoteDeviceSession,
        csrf_token: str,
        now: datetime,
    ) -> bool:
        """Check a double-submit CSRF token against a paired device session."""
        return self._store.csrf_matches(
            session_id=session.id,
            csrf_hash=_digest(csrf_token),
            now=now,
        )

    def list_active(self, *, now: datetime) -> tuple[RemoteDeviceSession, ...]:
        """List non-revoked, non-expired devices for local management."""
        return self._store.list_active(now=now)

    def revoke(self, session_id: UUID, *, now: datetime) -> bool:
        """Revoke one device from a local desktop request."""
        return self._store.revoke(session_id, now=now)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
