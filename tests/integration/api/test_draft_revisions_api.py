"""Iterative refinement: user edits, revision order, and repeated tagging."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.domain import AppSettingKind, DomainValidationError
from naver_blog_assistant.domain.settings import normalize_setting_payload
from naver_blog_assistant.domain.writing import DraftTag, body_tags

ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DRAFTS = "/api/v1/drafts"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


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


def create(client: TestClient) -> str:
    response = client.post(
        DRAFTS, json={"title": "합성 초안", "seed_text": "메모한 내용입니다.", "category_no": 7}
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def body(text: str, *, title: str = "직접 쓴 제목") -> dict[str, Any]:
    return {"title": title, "blocks": [{"type": "paragraph", "text": text}], "summary": "요약"}


def test_a_user_edit_is_stored_as_its_own_revision(client: TestClient) -> None:
    draft_id = create(client)

    response = client.put(f"{DRAFTS}/{draft_id}/body", json=body("직접 고친 문단"))

    assert response.status_code == 200, response.text
    revisions = response.json()["revisions"]
    assert [revision["kind"] for revision in revisions] == ["user_edited"]
    assert revisions[0]["is_active"] is True
    assert revisions[0]["blocks"][0]["text"] == "직접 고친 문단"


def test_repeated_edits_keep_the_revision_order(client: TestClient) -> None:
    draft_id = create(client)

    for index in range(3):
        client.put(f"{DRAFTS}/{draft_id}/body", json=body(f"{index}번째 수정"))

    revisions = client.get(f"{DRAFTS}/{draft_id}").json()["revisions"]
    assert [revision["round_no"] for revision in revisions] == [1, 2, 3]
    assert [revision["is_active"] for revision in revisions] == [False, False, True]


def test_versioned_canvas_saves_a_working_copy_and_refuses_a_stale_device(
    client: TestClient,
) -> None:
    draft_id = create(client)
    checkpoint = client.put(f"{DRAFTS}/{draft_id}/body", json=body("첫 checkpoint"))
    assert checkpoint.status_code == 200
    version = checkpoint.json()["working_copy"]["content_version"]

    saved = client.put(
        f"{DRAFTS}/{draft_id}/body",
        json={**body("자동 저장 문단"), "base_content_version": version},
    )
    assert saved.status_code == 200, saved.text
    assert len(saved.json()["revisions"]) == 1
    assert saved.json()["working_copy"]["blocks"][0]["text"] == "자동 저장 문단"
    assert saved.json()["working_copy"]["content_version"] == version + 1

    stale = client.put(
        f"{DRAFTS}/{draft_id}/body",
        json={**body("다른 기기의 오래된 편집"), "base_content_version": version},
    )
    assert stale.status_code == 409
    assert stale.json()["code"] == "draft_content_conflict"

    checkpointed = client.post(f"{DRAFTS}/{draft_id}/checkpoint")
    assert checkpointed.status_code == 200
    assert len(checkpointed.json()["revisions"]) == 2
    assert checkpointed.json()["revisions"][-1]["blocks"][0]["text"] == "자동 저장 문단"


def test_an_earlier_revision_can_be_restored(client: TestClient) -> None:
    draft_id = create(client)
    first = client.put(f"{DRAFTS}/{draft_id}/body", json=body("첫 수정")).json()["revisions"][0]
    client.put(f"{DRAFTS}/{draft_id}/body", json=body("두 번째 수정"))

    restored = client.patch(f"{DRAFTS}/{draft_id}", json={"active_revision_id": first["id"]})

    assert restored.status_code == 200
    active = [revision for revision in restored.json()["revisions"] if revision["is_active"]]
    assert len(active) == 1
    assert active[0]["id"] == first["id"]
    assert active[0]["blocks"][0]["text"] == "첫 수정"


def test_restoring_a_revision_of_another_draft_is_not_found(client: TestClient) -> None:
    first = create(client)
    second = create(client)
    revision_id = client.put(f"{DRAFTS}/{first}/body", json=body("첫 수정")).json()["revisions"][0][
        "id"
    ]

    response = client.patch(f"{DRAFTS}/{second}", json={"active_revision_id": revision_id})

    assert response.status_code == 404


def test_an_image_block_must_reference_an_uploaded_image(client: TestClient) -> None:
    draft_id = create(client)

    response = client.put(
        f"{DRAFTS}/{draft_id}/body",
        json={
            "title": "제목",
            "blocks": [
                {
                    "type": "image",
                    "image_id": "11111111-1111-4111-8111-111111111111",
                    "caption": "설명",
                }
            ],
        },
    )

    assert response.status_code == 422
    assert response.json()["code"] == "unknown_image_reference"


def test_an_uploaded_image_may_be_referenced(client: TestClient) -> None:
    draft_id = create(client)
    uploaded = client.post(
        f"{DRAFTS}/{draft_id}/images", files={"file": ("a.png", PNG, "image/png")}
    ).json()
    image_id = uploaded["images"][0]["id"]

    response = client.put(
        f"{DRAFTS}/{draft_id}/body",
        json={
            "title": "제목",
            "blocks": [{"type": "image", "image_id": image_id, "caption": "사진"}],
        },
    )

    assert response.status_code == 200
    assert response.json()["revisions"][0]["blocks"][0]["image_id"] == image_id


@pytest.mark.parametrize(
    "payload",
    [
        {"title": "제목", "blocks": []},
        {"title": "", "blocks": [{"type": "paragraph", "text": "문단"}]},
        {"title": "제목", "blocks": [{"type": "table", "text": "표"}]},
        {"title": "제목", "blocks": [{"type": "paragraph"}]},
        {"title": "제목", "blocks": [{"type": "paragraph", "text": "문단"}], "extra": 1},
    ],
)
def test_an_unusable_body_is_rejected(client: TestClient, payload: dict[str, Any]) -> None:
    draft_id = create(client)

    assert client.put(f"{DRAFTS}/{draft_id}/body", json=payload).status_code == 422


def test_saving_a_body_for_an_unknown_draft_is_not_found(client: TestClient) -> None:
    response = client.put(f"{DRAFTS}/11111111-1111-4111-8111-111111111111/body", json=body("문단"))

    assert response.status_code == 404


class TestWritingProfile:
    def test_the_documented_default_round_trips(self, client: TestClient) -> None:
        stored = client.get("/api/v1/settings/writing_profile")

        assert stored.status_code == 200
        payload = stored.json()["payload"]
        assert payload["target_length"] == "medium"
        assert payload["body_tag_cap"] == 20
        assert payload["use_image_vision"] is False
        assert stored.json()["updated_at"] is None

    def test_it_is_saved_and_read_back(self, client: TestClient) -> None:
        saved = client.put(
            "/api/v1/settings/writing_profile",
            json={
                "payload": {
                    "target_length": "long",
                    "tone": "calm",
                    "structure": "story",
                    "reference_post_count": 3,
                    "body_tag_cap": 30,
                    "use_image_vision": True,
                }
            },
        )

        assert saved.status_code == 200, saved.text
        assert client.get("/api/v1/settings/writing_profile").json()["payload"] == {
            "target_length": "long",
            "tone": "calm",
            "structure": "story",
            "reference_post_count": 3,
            "body_tag_cap": 30,
            "use_image_vision": True,
        }

    @pytest.mark.parametrize(
        "payload",
        [
            {"target_length": "huge"},
            {"tone": "angry"},
            {"structure": "freeform"},
            {"reference_post_count": 11},
            {"reference_post_count": -1},
            {"body_tag_cap": 0},
            {"body_tag_cap": 51},
            {"use_image_vision": "yes"},
        ],
    )
    def test_an_invalid_profile_is_rejected(self, payload: dict[str, Any]) -> None:
        base = {
            "target_length": "medium",
            "tone": "warm",
            "structure": "sectioned",
            "reference_post_count": 5,
            "body_tag_cap": 20,
            "use_image_vision": False,
        }

        with pytest.raises(DomainValidationError):
            normalize_setting_payload(AppSettingKind.WRITING_PROFILE, {**base, **payload})

    def test_the_body_tag_cap_bounds_the_inserted_tags(self) -> None:
        tags = tuple(DraftTag(tag=f"태그{index}", ordinal=index) for index in range(40))

        assert len(body_tags(tags, cap=30)) == 30
        assert len(body_tags(tags, cap=5)) == 5
