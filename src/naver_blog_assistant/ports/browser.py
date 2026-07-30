"""Port for controlling one locally owned browser session.

The application layer never imports a browser library. Adapters translate these operations onto a
concrete driver so the orchestration logic stays testable with an in-memory fake.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any, Protocol


class BrowserLaunchError(RuntimeError):
    """Raised when a browser session cannot be started with the requested profile."""


class BrowserOperationError(RuntimeError):
    """Raised when navigation, evaluation, or capture fails inside a live session."""


class FrameHandle(Protocol):
    """One document inside a page, addressed for read-only probing."""

    @property
    def url(self) -> str:
        """Return the current document URL."""
        ...

    async def evaluate(self, expression: str, argument: Any = None) -> Any:
        """Evaluate ``expression`` in an isolated context and return a JSON-safe value."""
        ...


class PageHandle(Protocol):
    """One browser tab owned by the local service."""

    @property
    def url(self) -> str:
        """Return the current top-level URL."""
        ...

    @property
    def frames(self) -> Sequence[FrameHandle]:
        """Return the main frame followed by every attached child frame."""
        ...

    async def goto(self, url: str, *, timeout_seconds: float | None = None) -> None:
        """Navigate to ``url`` and wait for the document to settle."""
        ...

    async def evaluate(self, expression: str, argument: Any = None) -> Any:
        """Evaluate ``expression`` in the main frame's isolated context."""
        ...

    async def screenshot(self) -> bytes:
        """Return a PNG capture that must stay in memory."""
        ...

    async def close(self) -> None:
        """Close this tab, ignoring an already closed target."""
        ...


class BrowserContextHandle(Protocol):
    """A persistent-profile context that keeps the user's manual sign-in."""

    @property
    def pages(self) -> Sequence[PageHandle]:
        """Return the currently open tabs."""
        ...

    async def new_page(self) -> PageHandle:
        """Open one additional tab."""
        ...

    async def bring_to_front(self) -> None:
        """Raise the browser window so the user can act on it."""
        ...

    async def close(self) -> None:
        """Close the context and release the profile lock."""
        ...


class BrowserDriver(Protocol):
    """Launch persistent-profile browser contexts for the local automation surface."""

    @property
    def name(self) -> str:
        """Return the configured driver identifier."""
        ...

    async def launch(
        self,
        *,
        profile_dir: Path,
        headless: bool,
        channel: str | None = None,
    ) -> BrowserContextHandle:
        """Start one context on ``profile_dir`` without injecting a synthetic fingerprint."""
        ...
