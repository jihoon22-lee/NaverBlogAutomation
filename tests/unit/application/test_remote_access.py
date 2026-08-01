"""Tests for one-time trusted-LAN pairing and redacted session lifecycle."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from naver_blog_assistant.application.remote_access import (
    MAX_PAIRING_ATTEMPTS_PER_CLIENT,
    PairingRejectedError,
    RemoteAccessService,
    RemoteDeviceSession,
)


class FakeStore:
    def __init__(self) -> None:
        self.sessions: dict[UUID, tuple[RemoteDeviceSession, str, str]] = {}

    def create(
        self,
        *,
        device_name: str,
        token_hash: str,
        csrf_hash: str,
        now: datetime,
        expires_at: datetime,
    ) -> RemoteDeviceSession:
        session = RemoteDeviceSession(
            id=uuid4(),
            device_name=device_name,
            created_at=now,
            last_seen_at=now,
            expires_at=expires_at,
            revoked_at=None,
        )
        self.sessions[session.id] = (session, token_hash, csrf_hash)
        return session

    def authenticate(self, *, token_hash: str, now: datetime) -> RemoteDeviceSession | None:
        for session, stored_token_hash, stored_csrf_hash in self.sessions.values():
            if (
                stored_token_hash == token_hash
                and session.revoked_at is None
                and session.expires_at > now
            ):
                updated = replace(session, last_seen_at=now)
                self.sessions[session.id] = (updated, stored_token_hash, stored_csrf_hash)
                return updated
        return None

    def csrf_matches(self, *, session_id: UUID, csrf_hash: str, now: datetime) -> bool:
        stored = self.sessions.get(session_id)
        if stored is None:
            return False
        session, _, stored_csrf_hash = stored
        return (
            session.revoked_at is None
            and session.expires_at > now
            and stored_csrf_hash == csrf_hash
        )

    def list_active(self, *, now: datetime) -> tuple[RemoteDeviceSession, ...]:
        return tuple(
            session
            for session, _, _ in self.sessions.values()
            if session.revoked_at is None and session.expires_at > now
        )

    def revoke(self, session_id: UUID, *, now: datetime) -> bool:
        stored = self.sessions.get(session_id)
        if stored is None:
            return False
        session, token_hash, csrf_hash = stored
        if session.revoked_at is not None:
            return False
        self.sessions[session_id] = (replace(session, revoked_at=now), token_hash, csrf_hash)
        return True


def test_pairing_consumes_the_code_and_keeps_plaintext_tokens_out_of_storage() -> None:
    store = FakeStore()
    service = RemoteAccessService(store)
    now = datetime(2026, 8, 1, tzinfo=UTC)
    code, expires_at = service.create_pairing_code(now=now)

    paired = service.pair(
        code=code,
        device_name="  Jihoon's iPad  ",
        client_id="192.168.0.20",
        now=now + timedelta(minutes=1),
    )

    assert paired.device.device_name == "Jihoon's iPad"
    assert expires_at == now + timedelta(minutes=5)
    stored = next(iter(store.sessions.values()))
    assert paired.session_token not in stored
    assert paired.csrf_token not in stored
    assert service.authenticate(session_token=paired.session_token, now=now) is not None
    assert service.csrf_matches(session=paired.device, csrf_token=paired.csrf_token, now=now)
    with pytest.raises(PairingRejectedError, match="pairing_code_invalid"):
        service.pair(code=code, device_name="iPad", client_id="192.168.0.20", now=now)


def test_pairing_rejects_expired_codes_and_rate_limits_one_client() -> None:
    service = RemoteAccessService(FakeStore())
    now = datetime(2026, 8, 1, tzinfo=UTC)
    code, _ = service.create_pairing_code(now=now)

    with pytest.raises(PairingRejectedError, match="pairing_code_invalid"):
        service.pair(
            code=code,
            device_name="Galaxy Tab",
            client_id="192.168.0.30",
            now=now + timedelta(minutes=5),
        )

    service.create_pairing_code(now=now)
    for _ in range(MAX_PAIRING_ATTEMPTS_PER_CLIENT):
        with pytest.raises(PairingRejectedError, match="pairing_code_invalid"):
            service.pair(
                code="wrong",
                device_name="Galaxy Tab",
                client_id="192.168.0.30",
                now=now,
            )
    with pytest.raises(PairingRejectedError, match="pairing_rate_limited"):
        service.pair(code="wrong", device_name="Galaxy Tab", client_id="192.168.0.30", now=now)


def test_local_device_management_lists_and_revokes_active_sessions() -> None:
    store = FakeStore()
    service = RemoteAccessService(store)
    now = datetime(2026, 8, 1, tzinfo=UTC)
    code, _ = service.create_pairing_code(now=now)
    paired = service.pair(code=code, device_name="Galaxy Tab", client_id="192.168.0.40", now=now)

    assert service.list_active(now=now) == (paired.device,)
    assert service.revoke(paired.device.id, now=now + timedelta(seconds=1))
    assert service.list_active(now=now + timedelta(seconds=1)) == ()
    assert (
        service.authenticate(session_token=paired.session_token, now=now + timedelta(seconds=1))
        is None
    )
