"""SQLite storage for hashed trusted-LAN device sessions."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select, update
from sqlalchemy.engine import Engine

from naver_blog_assistant.application.remote_access import RemoteDeviceSession
from naver_blog_assistant.infrastructure.database.schema import remote_device_sessions


class SqliteRemoteDeviceSessionStore:
    """Persist redacted device details while token material remains browser-only."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def create(
        self,
        *,
        device_name: str,
        token_hash: str,
        csrf_hash: str,
        now: datetime,
        expires_at: datetime,
    ) -> RemoteDeviceSession:
        """Store a new active device session."""
        session_id = uuid4()
        with self._engine.begin() as connection:
            connection.execute(
                remote_device_sessions.insert().values(
                    id=str(session_id),
                    device_name=device_name,
                    token_hash=token_hash,
                    csrf_hash=csrf_hash,
                    created_at=now.isoformat(),
                    last_seen_at=now.isoformat(),
                    expires_at=expires_at.isoformat(),
                    revoked_at=None,
                )
            )
        return self._get(session_id)

    def authenticate(self, *, token_hash: str, now: datetime) -> RemoteDeviceSession | None:
        """Find a live token digest and persist the latest successful use."""
        with self._engine.begin() as connection:
            row = connection.execute(
                select(remote_device_sessions).where(
                    remote_device_sessions.c.token_hash == token_hash,
                    remote_device_sessions.c.revoked_at.is_(None),
                    remote_device_sessions.c.expires_at > now.isoformat(),
                )
            ).one_or_none()
            if row is None:
                return None
            connection.execute(
                update(remote_device_sessions)
                .where(remote_device_sessions.c.id == row.id)
                .values(last_seen_at=now.isoformat())
            )
        return self._get(UUID(row.id))

    def csrf_matches(self, *, session_id: UUID, csrf_hash: str, now: datetime) -> bool:
        """Check a current, unrecalled session's CSRF digest."""
        with self._engine.connect() as connection:
            row = connection.execute(
                select(remote_device_sessions.c.id).where(
                    remote_device_sessions.c.id == str(session_id),
                    remote_device_sessions.c.csrf_hash == csrf_hash,
                    remote_device_sessions.c.revoked_at.is_(None),
                    remote_device_sessions.c.expires_at > now.isoformat(),
                )
            ).one_or_none()
        return row is not None

    def list_active(self, *, now: datetime) -> tuple[RemoteDeviceSession, ...]:
        """Return active sessions newest first without their secret hashes."""
        with self._engine.connect() as connection:
            rows = connection.execute(
                select(remote_device_sessions)
                .where(
                    remote_device_sessions.c.revoked_at.is_(None),
                    remote_device_sessions.c.expires_at > now.isoformat(),
                )
                .order_by(remote_device_sessions.c.last_seen_at.desc())
            ).all()
        return tuple(_session(row) for row in rows)

    def revoke(self, session_id: UUID, *, now: datetime) -> bool:
        """Mark one device unavailable for future bearer-token authentication."""
        with self._engine.begin() as connection:
            result = connection.execute(
                update(remote_device_sessions)
                .where(
                    remote_device_sessions.c.id == str(session_id),
                    remote_device_sessions.c.revoked_at.is_(None),
                )
                .values(revoked_at=now.isoformat())
            )
        return result.rowcount == 1

    def _get(self, session_id: UUID) -> RemoteDeviceSession:
        with self._engine.connect() as connection:
            row = connection.execute(
                select(remote_device_sessions).where(remote_device_sessions.c.id == str(session_id))
            ).one()
        return _session(row)


def _session(row: Any) -> RemoteDeviceSession:
    return RemoteDeviceSession(
        id=UUID(row.id),
        device_name=str(row.device_name),
        created_at=datetime.fromisoformat(row.created_at),
        last_seen_at=datetime.fromisoformat(row.last_seen_at),
        expires_at=datetime.fromisoformat(row.expires_at),
        revoked_at=(None if row.revoked_at is None else datetime.fromisoformat(row.revoked_at)),
    )
