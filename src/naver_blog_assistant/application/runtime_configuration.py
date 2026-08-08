"""Private, write-only runtime configuration for the desktop-owned service."""

from __future__ import annotations

import os
import stat
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path


class RuntimeConfigurationError(ValueError):
    """Raised before touching an unsafe or malformed private environment file."""


_KNOWN_KEYS = frozenset(
    {
        "COMMENT_GENERATOR_MODE",
        "OPENAI_API_KEY",
        "OPENAI_MODEL",
        "GEMINI_API_KEY",
        "GEMINI_MODEL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
        "NAVER_SEARCH_CLIENT_ID",
        "NAVER_SEARCH_CLIENT_SECRET",
        "DIGEST_SMTP_HOST",
        "DIGEST_SMTP_PORT",
        "DIGEST_SMTP_SECURITY",
        "DIGEST_SMTP_USERNAME",
        "DIGEST_SMTP_PASSWORD",
        "DIGEST_EMAIL_FROM",
        "DIGEST_EMAIL_TO",
        "AUTOMATION_DRIVER",
        "AUTOMATION_HEADLESS",
        "AUTOMATION_BROWSER_CHANNEL",
        "WEBAPP_ACCESS_MODE",
        "API_HOST",
        "API_PORT",
    }
)


@dataclass(frozen=True, slots=True)
class RuntimeConfigurationSnapshot:
    """The redacted configuration representation safe to return to the web app."""

    active_provider: str
    providers: tuple[tuple[str, bool, str], ...]
    naver_search_configured: bool
    smtp_configured: bool
    smtp_host: str
    smtp_port: int
    smtp_security: str
    browser_driver: str
    browser_headless: bool
    browser_channel: str
    access_mode: str
    restart_required: bool
    launcher_restart_available: bool


class RuntimeConfiguration:
    """Own one protected dotenv file while preserving comments and unknown user keys."""

    def __init__(
        self,
        path: Path | None,
        *,
        environment: Mapping[str, str] | None = None,
        launcher_restart_available: bool = False,
    ) -> None:
        self._path = path
        self._environment = dict(os.environ if environment is None else environment)
        self._launcher_restart_available = launcher_restart_available
        self._restart_required = False

    @property
    def launcher_restart_available(self) -> bool:
        return self._launcher_restart_available

    def snapshot(self) -> RuntimeConfigurationSnapshot:
        """Return non-secret settings and configured flags only."""
        values = self._environment
        provider_rows = tuple(
            (
                provider,
                bool(values.get(key, "").strip()),
                values.get(model_key, default),
            )
            for provider, key, model_key, default in (
                ("openai", "OPENAI_API_KEY", "OPENAI_MODEL", "gpt-5.6-terra"),
                ("gemini", "GEMINI_API_KEY", "GEMINI_MODEL", "gemini-3.6-flash"),
                ("anthropic", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "claude-sonnet-5-20260514"),
            )
        )
        smtp_keys = (
            "DIGEST_SMTP_HOST",
            "DIGEST_SMTP_USERNAME",
            "DIGEST_SMTP_PASSWORD",
            "DIGEST_EMAIL_FROM",
            "DIGEST_EMAIL_TO",
        )
        return RuntimeConfigurationSnapshot(
            active_provider=values.get("COMMENT_GENERATOR_MODE", "openai"),
            providers=provider_rows,
            naver_search_configured=bool(values.get("NAVER_SEARCH_CLIENT_ID", "").strip())
            and bool(values.get("NAVER_SEARCH_CLIENT_SECRET", "").strip()),
            smtp_configured=all(bool(values.get(key, "").strip()) for key in smtp_keys),
            smtp_host=values.get("DIGEST_SMTP_HOST", ""),
            smtp_port=_port(values.get("DIGEST_SMTP_PORT", "587")),
            smtp_security=values.get("DIGEST_SMTP_SECURITY", "starttls"),
            browser_driver=values.get("AUTOMATION_DRIVER", "patchright"),
            browser_headless=values.get("AUTOMATION_HEADLESS", "false").lower() == "true",
            browser_channel=values.get("AUTOMATION_BROWSER_CHANNEL", ""),
            access_mode=values.get("WEBAPP_ACCESS_MODE", "local"),
            restart_required=self._restart_required,
            launcher_restart_available=self._launcher_restart_available,
        )

    def update(self, changes: Mapping[str, str | None]) -> RuntimeConfigurationSnapshot:
        """Validate known values then atomically merge them into the private dotenv file."""
        unknown = set(changes) - _KNOWN_KEYS
        if unknown:
            raise RuntimeConfigurationError("unsupported runtime configuration key")
        if self._path is None:
            raise RuntimeConfigurationError("launcher_restart_unavailable")
        candidate = {**self._environment, **{key: value or "" for key, value in changes.items()}}
        _validate(candidate)
        if "COMMENT_GENERATOR_MODE" in changes:
            _validate_selected_provider(candidate)
        lines = self._read_lines()
        self._atomic_write(_merge_lines(lines, changes))
        self._environment.update({key: value or "" for key, value in changes.items()})
        self._restart_required = True
        return self.snapshot()

    def clear_restart_required(self) -> None:
        """Mark a supervisor-approved restart request as consumed."""
        self._restart_required = False

    def _read_lines(self) -> list[str]:
        path = self._require_safe_path(create=True)
        return path.read_text(encoding="utf-8").splitlines() if path.exists() else []

    def _atomic_write(self, lines: list[str]) -> None:
        path = self._require_safe_path(create=True)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.parent.is_symlink():
            raise RuntimeConfigurationError("private configuration directory cannot be a symlink")
        content = "\n".join(lines) + "\n"
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{path.name}.", dir=path.parent, text=True
        )
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _require_safe_path(self, *, create: bool) -> Path:
        path = self._path
        if path is None:
            raise RuntimeConfigurationError("launcher_restart_unavailable")
        path = path.expanduser()
        _assert_no_symlink_directory(path.parent)
        if path.is_symlink():
            raise RuntimeConfigurationError("private configuration file cannot be a symlink")
        if path.exists():
            details = path.stat()
            if not stat.S_ISREG(details.st_mode):
                raise RuntimeConfigurationError("private configuration path is not a regular file")
            if hasattr(os, "getuid") and details.st_uid != os.getuid():
                raise RuntimeConfigurationError(
                    "private configuration file is not owned by this user"
                )
            if stat.S_IMODE(details.st_mode) & 0o077:
                raise RuntimeConfigurationError(
                    "private configuration file permissions must be 0600"
                )
        elif not create:
            raise RuntimeConfigurationError("private configuration file does not exist")
        return path


def _merge_lines(lines: list[str], changes: Mapping[str, str | None]) -> list[str]:
    """Replace each known key once, keep user comments/unknown keys, reject duplicates."""
    output: list[str] = []
    seen: set[str] = set()
    for line in lines:
        key = _line_key(line)
        if key is None or key not in _KNOWN_KEYS:
            output.append(line)
            continue
        if key in seen:
            raise RuntimeConfigurationError("private configuration contains duplicate known keys")
        seen.add(key)
        if key in changes:
            value = changes[key]
            if value is not None and value != "":
                output.append(f"{key}={value}")
        else:
            output.append(line)
    for key, value in changes.items():
        if key not in seen and value is not None and value != "":
            output.append(f"{key}={value}")
    return output


def _line_key(line: str) -> str | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key, _ = stripped.split("=", 1)
    return key.strip() or None


def _port(value: str) -> int:
    try:
        return int(value)
    except ValueError:
        return 587


def _validate(values: Mapping[str, str]) -> None:
    if any(
        any(character in values.get(key, "") for character in ("\n", "\r", "\x00"))
        for key in _KNOWN_KEYS
    ):
        raise RuntimeConfigurationError("runtime configuration values must be single-line")
    if values.get("COMMENT_GENERATOR_MODE", "openai") not in {
        "openai",
        "gemini",
        "anthropic",
        "fake",
    }:
        raise RuntimeConfigurationError("AI provider mode is invalid")
    if values.get("AUTOMATION_DRIVER", "patchright") not in {"patchright", "playwright", "fake"}:
        raise RuntimeConfigurationError("browser driver is invalid")
    if values.get("WEBAPP_ACCESS_MODE", "local") not in {"local", "lan"}:
        raise RuntimeConfigurationError("access mode is invalid")
    expected_host = "0.0.0.0" if values.get("WEBAPP_ACCESS_MODE", "local") == "lan" else "127.0.0.1"
    if values.get("API_HOST", expected_host) != expected_host:
        raise RuntimeConfigurationError("API host must match the access mode")
    if _port(values.get("API_PORT", "8765")) != 8765:
        raise RuntimeConfigurationError("API port is fixed at 8765")
    if values.get("DIGEST_SMTP_SECURITY", "starttls") not in {"starttls", "ssl"}:
        raise RuntimeConfigurationError("SMTP security is invalid")
    port = _port(values.get("DIGEST_SMTP_PORT", "587"))
    if not 1 <= port <= 65535:
        raise RuntimeConfigurationError("SMTP port is invalid")


def _validate_selected_provider(values: Mapping[str, str]) -> None:
    """Do not persist a provider switch that is guaranteed to fail after restart.

    Clearing an existing credential remains possible: it may be an intentional security action.
    The guard applies only when the user explicitly selects a provider, where accepting an
    unconfigured one would make the following confirmed restart fail before the web app opens.
    """
    provider = values.get("COMMENT_GENERATOR_MODE", "openai")
    if provider == "fake":
        return
    key = {
        "openai": "OPENAI_API_KEY",
        "gemini": "GEMINI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
    }[provider]
    if not values.get(key, "").strip():
        raise RuntimeConfigurationError("selected AI provider is not configured")


def _assert_no_symlink_directory(directory: Path) -> None:
    """Reject a private-file path reached through any symlinked directory component."""
    current = directory.absolute()
    while current != current.parent:
        if current.is_symlink():
            raise RuntimeConfigurationError("private configuration directory cannot be a symlink")
        current = current.parent
