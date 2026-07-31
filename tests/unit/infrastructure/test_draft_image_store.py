"""Local image storage: type checks, size limits, and path containment."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest

from naver_blog_assistant.domain.models import DomainValidationError
from naver_blog_assistant.domain.writing import MAX_IMAGE_BYTES
from naver_blog_assistant.infrastructure.storage import DraftImageStore, safe_filename

JPEG = b"\xff\xd8\xff" + b"0" * 32
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32
GIF = b"GIF89a" + b"0" * 32
WEBP = b"RIFF" + b"0000" + b"WEBP" + b"0" * 32


@pytest.fixture
def store(tmp_path: Path) -> DraftImageStore:
    return DraftImageStore(tmp_path / "media")


def test_it_stores_a_jpeg_under_a_generated_name(store: DraftImageStore) -> None:
    draft_id = uuid4()

    stored = store.save(
        draft_id=draft_id, content=JPEG, mime="image/jpeg", original_filename="photo.jpg"
    )

    assert stored.relative_path == f"drafts/{draft_id}/{stored.id}.jpg"
    assert stored.absolute_path.read_bytes() == JPEG
    assert stored.byte_size == len(JPEG)


@pytest.mark.parametrize(
    ("content", "mime", "suffix"),
    [(PNG, "image/png", ".png"), (GIF, "image/gif", ".gif"), (WEBP, "image/webp", ".webp")],
)
def test_it_stores_every_allowed_type(
    store: DraftImageStore, content: bytes, mime: str, suffix: str
) -> None:
    stored = store.save(
        draft_id=uuid4(), content=content, mime=mime, original_filename=f"x{suffix}"
    )

    assert stored.relative_path.endswith(suffix)


def test_it_ignores_charset_parameters_on_the_declared_type(store: DraftImageStore) -> None:
    stored = store.save(
        draft_id=uuid4(), content=PNG, mime="image/png; charset=binary", original_filename="x.png"
    )

    assert stored.mime == "image/png"


@pytest.mark.parametrize("mime", ["image/svg+xml", "application/pdf", "", "text/plain"])
def test_it_refuses_a_type_that_is_not_allowed(store: DraftImageStore, mime: str) -> None:
    with pytest.raises(DomainValidationError, match="allowed image type"):
        store.save(draft_id=uuid4(), content=JPEG, mime=mime, original_filename="x")


def test_it_refuses_content_that_does_not_match_its_type(store: DraftImageStore) -> None:
    with pytest.raises(DomainValidationError, match="declared type"):
        store.save(draft_id=uuid4(), content=PNG, mime="image/jpeg", original_filename="x.jpg")


def test_it_refuses_a_riff_container_that_is_not_webp(store: DraftImageStore) -> None:
    with pytest.raises(DomainValidationError, match="declared type"):
        store.save(
            draft_id=uuid4(),
            content=b"RIFF0000AVI ",
            mime="image/webp",
            original_filename="x.webp",
        )


def test_it_refuses_an_empty_upload(store: DraftImageStore) -> None:
    with pytest.raises(DomainValidationError, match="image size"):
        store.save(draft_id=uuid4(), content=b"", mime="image/png", original_filename="x.png")


def test_it_refuses_an_oversized_upload(store: DraftImageStore) -> None:
    oversized = PNG + b"0" * MAX_IMAGE_BYTES

    with pytest.raises(DomainValidationError, match="image size"):
        store.save(draft_id=uuid4(), content=oversized, mime="image/png", original_filename="x")


def test_deleting_removes_the_file(store: DraftImageStore) -> None:
    stored = store.save(draft_id=uuid4(), content=PNG, mime="image/png", original_filename="x.png")

    assert store.delete(stored.relative_path) is True
    assert stored.absolute_path.exists() is False
    assert store.delete(stored.relative_path) is False


@pytest.mark.parametrize("path", ["../escape.png", "drafts/../../escape.png", "/etc/passwd", ""])
def test_it_refuses_a_path_outside_the_root(store: DraftImageStore, path: str) -> None:
    assert store.delete(path) is False


def test_deleting_a_draft_removes_its_directory(store: DraftImageStore) -> None:
    draft_id = uuid4()
    store.save(draft_id=draft_id, content=PNG, mime="image/png", original_filename="a.png")
    store.save(draft_id=draft_id, content=JPEG, mime="image/jpeg", original_filename="b.jpg")

    store.delete_draft(draft_id)

    assert (store.root / "drafts" / str(draft_id)).exists() is False


def test_deleting_an_unknown_draft_is_a_no_op(store: DraftImageStore) -> None:
    store.delete_draft(uuid4())


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("photo.jpg", "photo.jpg"),
        ("../../etc/passwd", "passwd"),
        ("사진 01.png", "사진_01.png"),
        ("   ", "image"),
        ("...", "image"),
        ("a" * 400, "a" * 255),
    ],
)
def test_it_makes_the_original_filename_safe(value: str, expected: str) -> None:
    assert safe_filename(value) == expected
