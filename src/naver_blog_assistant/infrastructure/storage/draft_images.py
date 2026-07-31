"""Local storage for draft images.

Uploaded bytes never reach a provider by default and never leave the runtime directory. The stored
name is generated, so a hostile original filename cannot escape the draft directory or overwrite
another file.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID, uuid4

from naver_blog_assistant.domain.models import DomainValidationError
from naver_blog_assistant.domain.writing import (
    ALLOWED_IMAGE_MIMES,
    MAX_IMAGE_BYTES,
)

EXTENSIONS: dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
MAGIC_PREFIXES: dict[str, tuple[bytes, ...]] = {
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/gif": (b"GIF87a", b"GIF89a"),
    "image/webp": (b"RIFF",),
}
_SAFE_NAME = re.compile(r"[^0-9A-Za-z가-힣._-]+")
MAX_FILENAME_LENGTH = 255


@dataclass(frozen=True, slots=True)
class StoredImage:
    """Where one uploaded image landed."""

    id: UUID
    relative_path: str
    absolute_path: Path
    byte_size: int
    mime: str
    original_filename: str


class DraftImageStore:
    """Write and delete draft image files under one runtime root."""

    def __init__(self, root: Path) -> None:
        self._root = root

    @property
    def root(self) -> Path:
        """Return the runtime root every stored path is relative to."""
        return self._root

    def save(
        self, *, draft_id: UUID, content: bytes, mime: str, original_filename: str
    ) -> StoredImage:
        """Store one image under a generated name after validating type and size."""
        normalized_mime = mime.split(";", 1)[0].strip().lower()
        if normalized_mime not in ALLOWED_IMAGE_MIMES:
            raise DomainValidationError(f"{mime} is not an allowed image type")
        if not 0 < len(content) <= MAX_IMAGE_BYTES:
            raise DomainValidationError("image size must be between 1 byte and 10 MiB")
        if not _matches_declared_type(content, normalized_mime):
            raise DomainValidationError("image content does not match its declared type")
        image_id = uuid4()
        directory = self._root / "drafts" / str(draft_id)
        directory.mkdir(parents=True, exist_ok=True)
        name = f"{image_id}{EXTENSIONS[normalized_mime]}"
        target = directory / name
        target.write_bytes(content)
        return StoredImage(
            id=image_id,
            relative_path=f"drafts/{draft_id}/{name}",
            absolute_path=target,
            byte_size=len(content),
            mime=normalized_mime,
            original_filename=safe_filename(original_filename),
        )

    def delete(self, relative_path: str) -> bool:
        """Delete one stored file, refusing any path outside the runtime root."""
        target = self.resolve(relative_path)
        if target is None or not target.is_file():
            return False
        target.unlink()
        return True

    def delete_draft(self, draft_id: UUID) -> None:
        """Delete every file of one draft."""
        directory = self._root / "drafts" / str(draft_id)
        if not directory.is_dir():
            return
        for entry in sorted(directory.iterdir()):
            if entry.is_file():
                entry.unlink()
        directory.rmdir()

    def resolve(self, relative_path: str) -> Path | None:
        """Return the absolute path for a stored file, or None when it escapes the root."""
        candidate = (self._root / relative_path).resolve()
        root = self._root.resolve()
        if candidate == root or root not in candidate.parents:
            return None
        return candidate


def safe_filename(value: str) -> str:
    """Return a display-safe original filename with no path separators."""
    name = Path(value.strip()).name
    cleaned = _SAFE_NAME.sub("_", name).strip("._-")
    if not cleaned:
        return "image"
    return cleaned[:MAX_FILENAME_LENGTH]


def _matches_declared_type(content: bytes, mime: str) -> bool:
    prefixes = MAGIC_PREFIXES.get(mime)
    if prefixes is None:  # pragma: no cover - every allowed type has a prefix
        return False
    if mime == "image/webp":
        return content.startswith(b"RIFF") and content[8:12] == b"WEBP"
    return any(content.startswith(prefix) for prefix in prefixes)
