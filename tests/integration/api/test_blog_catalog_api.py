"""Transport behavior for the own-blog catalog endpoints."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.application.automation import LOGIN_STATE_EXPRESSION
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver

CATEGORIES = "/api/v1/blog/categories"
REFERENCES = "/api/v1/blog/reference-posts"
OWNER = "example"

PROBES: dict[str, Any] = {
    "probeMyBlogCategories": {
        "categories": [{"categoryNo": 7, "name": "전시 후기", "postCount": 12}]
    },
    "probeCategoryPostList": {
        "categoryNo": 7,
        "posts": [
            {
                "logNo": "1",
                "title": "첫 전시",
                "publishedAt": "2026-07-20",
                "url": "https://blog.naver.com/example/1",
            }
        ],
    },
}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    driver = FakeBrowserDriver(
        page_results={LOGIN_STATE_EXPRESSION: "authenticated"},
        page_probe_results=dict(PROBES),
    )
    settings = ApiSettings(
        database_url=f"sqlite:///{tmp_path / 'blog.db'}",
        generator_mode="fake",
        app_environment="test",
        rate_limit_requests=80,
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
    )
    with TestClient(create_app(settings, browser_driver=driver)) as test_client:
        test_client.post("/api/v1/automation/session/launch")
        yield test_client


def save_owner(client: TestClient) -> None:
    response = client.put(
        "/api/v1/discovery/automation-settings",
        json={"enabled": True, "own_blog_id": OWNER, "hour": 9, "minute": 0},
    )
    assert response.status_code == 200, response.text


def test_the_catalog_is_empty_before_a_sync(client: TestClient) -> None:
    response = client.get(CATEGORIES)

    assert response.status_code == 200
    assert response.json() == {"items": []}


def test_a_sync_caches_the_categories(client: TestClient) -> None:
    save_owner(client)

    response = client.post(f"{CATEGORIES}/sync")

    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [item["category_no"] for item in items] == [7]
    assert items[0]["name"] == "전시 후기"
    assert items[0]["synced_at"] is not None
    assert client.get(CATEGORIES).json()["items"] == items


def test_a_sync_without_a_saved_owner_is_refused(client: TestClient) -> None:
    response = client.post(f"{CATEGORIES}/sync")

    assert response.status_code == 422
    assert response.json()["code"] == "blog_id_missing"


def test_another_blog_is_refused(client: TestClient) -> None:
    save_owner(client)

    response = client.post(f"{CATEGORIES}/sync", json={"blog_id": "someone-else"})

    assert response.status_code == 403
    assert response.json()["code"] == "not_blog_owner"


def test_reference_posts_come_from_the_cache(client: TestClient) -> None:
    save_owner(client)
    client.post(f"{CATEGORIES}/sync")

    response = client.get(REFERENCES, params={"category_no": 7, "limit": 3})

    assert response.status_code == 200
    items = response.json()["items"]
    assert items[0]["title"] == "첫 전시"
    assert items[0]["published_at"] == "2026-07-20"


def test_an_unknown_category_returns_no_references(client: TestClient) -> None:
    response = client.get(REFERENCES, params={"category_no": 99})

    assert response.status_code == 200
    assert response.json() == {"items": []}


@pytest.mark.parametrize("params", [{"category_no": -1}, {"category_no": 7, "limit": 0}, {}])
def test_invalid_parameters_are_rejected(client: TestClient, params: dict[str, Any]) -> None:
    assert client.get(REFERENCES, params=params).status_code == 422


def test_the_reference_limit_is_bounded(client: TestClient) -> None:
    assert client.get(REFERENCES, params={"category_no": 7, "limit": 99}).status_code == 422
