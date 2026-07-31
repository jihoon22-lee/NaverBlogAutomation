"""Transport behavior for the post draft endpoints."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from naver_blog_assistant.api import ApiSettings, create_app

ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DRAFTS = "/api/v1/drafts"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64
JPEG = b"\xff\xd8\xff" + b"0" * 64


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{tmp_path / 'drafts.db'}",
        generator_mode="fake",
        app_environment="test",
        rate_limit_requests=200,
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
        draft_media_dir=str(tmp_path / "media"),
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def create(client: TestClient, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "title": "합성 초안",
        "seed_text": "전시에서 본 작품을 메모했습니다.",
        "category_no": 7,
    }
    payload.update(overrides)
    response = client.post(DRAFTS, json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_a_draft_is_created_and_read_back(client: TestClient) -> None:
    created = create(client)

    fetched = client.get(f"{DRAFTS}/{created['id']}")

    assert fetched.status_code == 200
    body = fetched.json()
    assert body["status"] == "collecting"
    assert body["revisions"] == []
    assert body["images"] == []
    assert body["tags"] == []


def test_the_newest_drafts_are_listed(client: TestClient) -> None:
    create(client, title="첫 초안")
    create(client, title="두 번째 초안")

    listed = client.get(DRAFTS, params={"limit": 5})

    assert listed.status_code == 200
    assert len(listed.json()["items"]) == 2


@pytest.mark.parametrize(
    "payload",
    [
        {"title": "", "seed_text": "메모"},
        {"title": "제목"},
        {"title": "제목", "seed_text": "메모", "category_no": -1},
        {"title": "제목", "seed_text": "메모", "unexpected": True},
        {"title": "제목", "seed_text": "가" * 20_001},
    ],
)
def test_an_invalid_draft_is_rejected(client: TestClient, payload: dict[str, Any]) -> None:
    assert client.post(DRAFTS, json=payload).status_code == 422


def test_an_unknown_draft_is_not_found(client: TestClient) -> None:
    response = client.get(f"{DRAFTS}/11111111-1111-4111-8111-111111111111")

    assert response.status_code == 404
    assert response.json()["code"] == "draft_not_found"


def test_an_image_is_stored_without_returning_its_bytes(client: TestClient) -> None:
    created = create(client)

    response = client.post(
        f"{DRAFTS}/{created['id']}/images",
        files={"file": ("photo.png", PNG, "image/png")},
        data={"alt_text": "전시장 입구"},
    )

    assert response.status_code == 201, response.text
    images = response.json()["images"]
    assert images[0]["mime"] == "image/png"
    assert images[0]["byte_size"] == len(PNG)
    assert images[0]["alt_text"] == "전시장 입구"
    assert "stored_path" not in images[0]
    assert "content" not in images[0]


def test_a_disallowed_upload_is_rejected(client: TestClient) -> None:
    created = create(client)

    response = client.post(
        f"{DRAFTS}/{created['id']}/images",
        files={"file": ("note.txt", b"hello", "text/plain")},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_image"


def test_content_that_contradicts_its_type_is_rejected(client: TestClient) -> None:
    created = create(client)

    response = client.post(
        f"{DRAFTS}/{created['id']}/images",
        files={"file": ("photo.png", JPEG, "image/png")},
    )

    assert response.status_code == 422


def test_an_image_can_be_removed(client: TestClient) -> None:
    created = create(client)
    uploaded = client.post(
        f"{DRAFTS}/{created['id']}/images", files={"file": ("a.png", PNG, "image/png")}
    ).json()
    image_id = uploaded["images"][0]["id"]

    response = client.delete(f"{DRAFTS}/{created['id']}/images/{image_id}")

    assert response.status_code == 200
    assert response.json()["images"] == []
    assert client.delete(f"{DRAFTS}/{created['id']}/images/{image_id}").status_code == 404


def test_a_draft_can_be_renamed(client: TestClient) -> None:
    created = create(client)

    response = client.patch(f"{DRAFTS}/{created['id']}", json={"title": "새 제목"})

    assert response.status_code == 200
    assert response.json()["title"] == "새 제목"


def test_a_patch_that_changes_nothing_is_rejected(client: TestClient) -> None:
    created = create(client)

    assert client.patch(f"{DRAFTS}/{created['id']}", json={}).status_code == 422


def test_tags_can_be_added_and_deselected(client: TestClient) -> None:
    created = create(client)

    added = client.patch(f"{DRAFTS}/{created['id']}/tags", json={"added": ["#전시", "전시 후기"]})
    assert added.status_code == 200
    assert [tag["tag"] for tag in added.json()["tags"]] == ["전시", "전시후기"]
    assert added.json()["tags"][0]["source"] == "user"

    deselected = client.patch(f"{DRAFTS}/{created['id']}/tags", json={"selected": ["전시"]})
    assert [tag["selected"] for tag in deselected.json()["tags"]] == [True, False]


def test_a_tag_patch_without_a_field_is_rejected(client: TestClient) -> None:
    created = create(client)

    assert client.patch(f"{DRAFTS}/{created['id']}/tags", json={}).status_code == 422


def test_composing_without_a_configured_provider_is_unavailable(client: TestClient) -> None:
    created = create(client)

    response = client.post(f"{DRAFTS}/{created['id']}/compose", json={"provider": "openai"})

    assert response.status_code == 503
    assert response.json()["code"] == "generation_unavailable"


def test_composing_an_unknown_draft_is_not_found(client: TestClient) -> None:
    response = client.post(
        f"{DRAFTS}/11111111-1111-4111-8111-111111111111/compose", json={"provider": "openai"}
    )

    assert response.status_code == 404


@pytest.mark.parametrize(
    "payload",
    [
        {"provider": "mistral"},
        {"provider": "openai", "length": "huge"},
        {"provider": "openai", "reference_limit": 99},
        {"provider": "openai", "unexpected": 1},
        {},
    ],
)
def test_an_invalid_generation_request_is_rejected(
    client: TestClient, payload: dict[str, Any]
) -> None:
    created = create(client)

    response = client.post(f"{DRAFTS}/{created['id']}/compose", json=payload)

    assert response.status_code == 422


def test_a_draft_and_its_images_are_deleted(client: TestClient, tmp_path: Path) -> None:
    created = create(client)
    client.post(f"{DRAFTS}/{created['id']}/images", files={"file": ("a.png", PNG, "image/png")})

    response = client.delete(f"{DRAFTS}/{created['id']}")

    assert response.status_code == 204
    assert client.get(f"{DRAFTS}/{created['id']}").status_code == 404
    assert list((tmp_path / "media" / "drafts").glob("*/*")) == []
