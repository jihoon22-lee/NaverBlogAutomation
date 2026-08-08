"""Behavior and privacy contract tests for the local FastAPI adapter."""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
from collections.abc import Iterator
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient, Response
from openai import OpenAI

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.application import (
    GenerationRateLimitedError,
    GenerationRefusedError,
    GenerationUnavailableError,
)
from naver_blog_assistant.domain import (
    CapturedPost,
    GenerationOutput,
    GenerationPreferences,
    ImportedDiscoveryPost,
)
from naver_blog_assistant.infrastructure.generators import DeterministicFakeGenerator
from naver_blog_assistant.infrastructure.generators.openai import OpenAICommentGenerator
from naver_blog_assistant.ports import GenerationNotStartedError

ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BLOG_URL = "https://blog.naver.com/example/123"
BODY = "전시에서 인상 깊었던 작품과 관람 동선을 자세하게 정리한 테스트 본문입니다."
ROOT = Path(__file__).parents[3]


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    return tmp_path / "local-api.db"


@pytest.fixture
def client(database_path: Path) -> Iterator[TestClient]:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{database_path}",
        generator_mode="fake",
        app_environment="test",
        rate_limit_requests=20,
        naver_search_client_id="test-client-id",
        naver_search_client_secret="test-client-secret",
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def request_payload(*, body: str = BODY, source_url: str = BLOG_URL) -> dict[str, str]:
    return {"source_url": source_url, "title": "  주말\n 전시 후기 ", "body": body}


def create(client: TestClient, *, key: UUID | None = None) -> tuple[UUID, dict[str, Any]]:
    response = client.post(
        "/api/v1/recommendations",
        json=request_payload(),
        headers={"Idempotency-Key": str(key or uuid4())},
    )
    assert response.status_code == 201, response.text
    payload = response.json()
    return UUID(payload["id"]), payload


def assert_problem(response: Response, *, status: int, code: str) -> None:
    assert response.status_code == status
    assert response.headers["content-type"].startswith("application/problem+json")
    payload = response.json()
    assert payload["code"] == code
    UUID(payload["request_id"])
    assert "traceback" not in response.text.lower()


def test_health_create_get_and_response_contract(client: TestClient) -> None:
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/api/v1/status").json() == {
        "status": "ready",
        "api_version": "1.0.0",
        "app_environment": "test",
        "database": "ready",
        "generator_mode": "fake",
        "generator_model": "deterministic-fake",
    }
    readiness = client.get("/api/v1/app/readiness")
    assert readiness.status_code == 200
    assert readiness.json() == {
        "access_mode": "local",
        "web_app_assets_ready": True,
        "lan_addresses": [],
        "browser_state": "stopped",
        "browser_login": "unknown",
        "own_blog_configured": False,
        "generation_available": True,
        "automation_consent": False,
        "safety_policy_configured": False,
        "blockers": [
            "browser_not_running",
            "own_blog_id_missing",
            "automation_consent_missing",
            "safety_policy_missing",
        ],
    }

    recommendation_id, payload = create(client)

    assert payload["title"] == "주말 전시 후기"
    assert payload["review_status"] == "drafted"
    assert payload["relationship_level"] == "friendly"
    assert payload["speech_style"] == "honorific"
    assert payload["comment_length"] == "medium"
    assert payload["comment_mood"] == "warm"
    assert payload["quality_warnings"] == []
    assert len(payload["candidates"]) == 3
    assert {item["tone"] for item in payload["candidates"]} == {
        "warm",
        "curious",
        "supportive",
    }
    assert "content_hash" not in payload and "excerpt" not in payload and "body" not in payload
    assert client.get(f"/api/v1/recommendations/{recommendation_id}").json() == payload


def test_engagement_api_persists_ordered_results_and_completes_linked_records(
    client: TestClient,
) -> None:
    recommendation_id, recommendation = create(client)
    approved = client.patch(
        f"/api/v1/recommendations/{recommendation_id}",
        json={
            "selected_candidate_id": recommendation["candidates"][0]["id"],
            "edited_comment": "사용자가 최종 승인한 댓글",
            "review_status": "approved",
        },
    )
    assert approved.status_code == 200
    neighbor = client.post(
        "/api/v1/discovery/neighbors",
        json={
            "name": "합성 이웃",
            "blog_url": "https://blog.naver.com/example",
            "blog_id": "example",
        },
    ).json()
    imported = client.post(
        "/api/v1/discovery/import",
        json={
            "source": "neighbor",
            "neighbor_id": neighbor["id"],
            "posts": [{"source_url": BLOG_URL, "title": "주말 전시 후기"}],
        },
    )
    assert imported.json() == {"imported_count": 1}
    post_id = client.get("/api/v1/discovery/queue?source=neighbor").json()["items"][0]["id"]
    approval_id = str(UUID("00000000-0000-4000-8000-000000000040"))

    started = client.post(
        "/api/v1/engagement-runs",
        json={
            "approval_id": approval_id,
            "discovery_post_id": post_id,
            "recommendation_id": str(recommendation_id),
        },
    )
    assert started.status_code == 201
    run = started.json()
    assert [step["name"] for step in run["steps"]] == ["like", "comment"]
    replay = client.post(
        "/api/v1/engagement-runs",
        json={
            "approval_id": approval_id,
            "discovery_post_id": post_id,
            "recommendation_id": str(recommendation_id),
        },
    )
    assert replay.status_code == 200
    assert replay.headers["Engagement-Replayed"] == "true"
    assert replay.json()["id"] == run["id"]
    assert client.get(f"/api/v1/engagement-runs/{run['id']}").json() == run
    assert client.get(f"/api/v1/engagement-runs/by-post/{post_id}").json() == run
    assert client.get("/api/v1/engagement-runs?limit=20").json()["items"] == [run]

    out_of_order = client.patch(
        f"/api/v1/engagement-runs/{run['id']}/steps/comment",
        json={"state": "running", "result_code": None},
    )
    assert_problem(out_of_order, status=409, code="engagement_transition_conflict")
    invalid_result = client.patch(
        f"/api/v1/engagement-runs/{run['id']}/steps/like",
        json={"state": "succeeded"},
    )
    assert_problem(invalid_result, status=422, code="invalid_request")

    assert (
        client.patch(
            f"/api/v1/engagement-runs/{run['id']}/steps/like",
            json={"state": "running"},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/v1/engagement-runs/{run['id']}/steps/like",
            json={"state": "skipped", "result_code": "already_liked"},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/v1/engagement-runs/{run['id']}/steps/comment",
            json={"state": "running"},
        ).status_code
        == 200
    )
    completed = client.patch(
        f"/api/v1/engagement-runs/{run['id']}/steps/comment",
        json={"state": "succeeded", "result_code": "submitted"},
    )

    assert completed.status_code == 200
    assert completed.json()["state"] == "succeeded"
    assert (
        client.get(f"/api/v1/recommendations/{recommendation_id}").json()["review_status"]
        == "completed"
    )
    assert client.get("/api/v1/discovery/queue?source=neighbor").json()["items"] == []


def test_manual_engagement_completion_resolves_failed_run_and_queue(client: TestClient) -> None:
    recommendation_id, recommendation = create(client)
    assert (
        client.patch(
            f"/api/v1/recommendations/{recommendation_id}",
            json={
                "selected_candidate_id": recommendation["candidates"][0]["id"],
                "review_status": "approved",
            },
        ).status_code
        == 200
    )
    neighbor = client.post(
        "/api/v1/discovery/neighbors",
        json={
            "name": "수동 완료 이웃",
            "blog_url": "https://blog.naver.com/manual",
            "blog_id": "manual",
        },
    ).json()
    assert (
        client.post(
            "/api/v1/discovery/import",
            json={
                "source": "neighbor",
                "neighbor_id": neighbor["id"],
                "posts": [{"source_url": BLOG_URL, "title": "주말 전시 후기"}],
            },
        ).status_code
        == 200
    )
    post_id = client.get("/api/v1/discovery/queue?source=neighbor").json()["items"][0]["id"]
    started = client.post(
        "/api/v1/engagement-runs",
        json={
            "approval_id": str(UUID("00000000-0000-4000-8000-000000000041")),
            "discovery_post_id": post_id,
            "recommendation_id": str(recommendation_id),
        },
    ).json()
    assert (
        client.patch(
            f"/api/v1/engagement-runs/{started['id']}/steps/like",
            json={"state": "running"},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/v1/engagement-runs/{started['id']}/steps/like",
            json={"state": "failed", "result_code": "not_found"},
        ).status_code
        == 200
    )

    completed = client.post(
        f"/api/v1/engagement-runs/{started['id']}/manual-completion",
        json={"completed_steps": ["like", "comment"]},
    )

    assert completed.status_code == 200
    assert completed.json()["state"] == "succeeded"
    assert [step["result_code"] for step in completed.json()["steps"]] == [
        "manual_confirmed",
        "manual_confirmed",
    ]
    assert client.get("/api/v1/discovery/queue?source=neighbor").json()["items"] == []


def test_automatic_discovery_settings_are_opt_in_and_preserve_last_run_state(
    client: TestClient,
) -> None:
    assert client.get("/api/v1/discovery/automation-settings").json() == {
        "own_blog_id": "",
        "enabled": False,
        "timezone": "Asia/Seoul",
        "hour": 9,
        "minute": 0,
        "last_synced_at": None,
        "last_status": "never",
        "last_detail": "",
    }
    missing_source = client.post("/api/v1/discovery/sync")
    assert missing_source.status_code == 200
    assert missing_source.json()["status"] == "failed"
    missing_blog_id = client.put(
        "/api/v1/discovery/automation-settings",
        json={"own_blog_id": "", "enabled": True},
    )
    assert_problem(missing_blog_id, status=422, code="invalid_automatic_discovery_settings")
    saved = client.put(
        "/api/v1/discovery/automation-settings",
        json={
            "own_blog_id": "my-blog",
            "enabled": True,
            "timezone": "Asia/Seoul",
            "hour": 8,
            "minute": 30,
        },
    )
    assert saved.status_code == 200
    assert saved.json()["own_blog_id"] == "my-blog"
    assert saved.json()["enabled"] is True
    assert saved.json()["last_status"] == "failed"


def test_automatic_discovery_sync_collects_public_metadata_without_browser_state(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def public_html(url: str) -> str:
        assert "BuddyList.naver" in url
        return '<a href="https://m.blog.naver.com/PostList.naver?blogId=friend">친한 이웃</a>'

    monkeypatch.setattr("naver_blog_assistant.api.factory.fetch_public_html", public_html)
    monkeypatch.setattr(
        "naver_blog_assistant.api.factory.fetch_naver_blog_search",
        lambda _query, **_kwargs: (
            ImportedDiscoveryPost(
                source_url="https://blog.naver.com/newfriend/456",
                title="새 전시 후기",
                publisher_blog_id="newfriend",
            ),
        ),
    )
    monkeypatch.setattr(
        "naver_blog_assistant.api.factory.fetch_rss_posts",
        lambda _url: (("https://blog.naver.com/friend/123", "이웃 새 글", None),),
    )
    settings = client.put(
        "/api/v1/discovery/automation-settings",
        json={"own_blog_id": "mine", "enabled": True},
    )
    assert settings.status_code == 200
    assert (
        client.post(
            "/api/v1/discovery/searches",
            json={"query": "전시", "excluded_terms": [], "freshness_days": 14},
        ).status_code
        == 201
    )

    response = client.post("/api/v1/discovery/sync")

    assert response.status_code == 200
    assert response.json() == {
        "neighbors_added": 1,
        "neighbor_posts_added": 1,
        "search_posts_added": 1,
        "search_provider": "naver_open_api",
        "status": "success",
        "detail": "이웃 1개, 이웃 새 글 1개, 검색 후보 1개를 확인했습니다.",
    }
    settings_after = client.get("/api/v1/discovery/automation-settings").json()
    assert settings_after["last_status"] == "success"
    assert settings_after["last_synced_at"] is not None


def test_automatic_discovery_sync_returns_aggregate_search_count_over_fifty(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("naver_blog_assistant.api.factory.fetch_public_html", lambda _url: "")
    monkeypatch.setattr("naver_blog_assistant.api.factory.fetch_rss_posts", lambda _url: ())

    def search_posts(query: str, **_kwargs: object) -> tuple[ImportedDiscoveryPost, ...]:
        return tuple(
            ImportedDiscoveryPost(
                source_url=f"https://blog.naver.com/{query}/{index}",
                title=f"{query} 후보 {index}",
                publisher_blog_id=f"{query}{index}",
            )
            for index in range(50)
        )

    monkeypatch.setattr("naver_blog_assistant.api.factory.fetch_naver_blog_search", search_posts)
    assert (
        client.put(
            "/api/v1/discovery/automation-settings",
            json={"own_blog_id": "mine", "enabled": True},
        ).status_code
        == 200
    )
    for query in ("전시", "여행", "맛집", "독서"):
        assert (
            client.post(
                "/api/v1/discovery/searches",
                json={"query": query, "excluded_terms": [], "freshness_days": 14},
            ).status_code
            == 201
        )

    response = client.post("/api/v1/discovery/sync")

    assert response.status_code == 200
    assert response.json()["search_posts_added"] == 200
    assert response.json()["status"] == "success"


def test_saved_search_refresh_explains_when_official_api_credentials_are_missing(
    database_path: Path,
) -> None:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{database_path}",
        generator_mode="fake",
        app_environment="test",
    )
    with TestClient(create_app(settings)) as configured_client:
        search = configured_client.post(
            "/api/v1/discovery/searches",
            json={"query": "전시", "excluded_terms": [], "freshness_days": 14},
        )
        assert search.status_code == 201

        response = configured_client.post(
            f"/api/v1/discovery/searches/{search.json()['id']}/refresh"
        )

    assert_problem(response, status=409, code="discovery_search_not_configured")
    assert "NAVER_SEARCH_CLIENT_ID" in response.json()["detail"]


def test_discovery_keeps_only_metadata_in_two_user_reviewed_queues(client: TestClient) -> None:
    neighbor = client.post(
        "/api/v1/discovery/neighbors",
        json={
            "name": "테스트 이웃",
            "blog_url": "https://blog.naver.com/friend",
            "blog_id": "friend",
        },
    )
    assert neighbor.status_code == 201
    neighbor_id = neighbor.json()["id"]
    assert client.get("/api/v1/discovery/neighbors").json()["items"][0]["feed_status"] == "unknown"

    search = client.post(
        "/api/v1/discovery/searches",
        json={"query": "전시 후기", "excluded_terms": ["광고"], "freshness_days": 7},
    )
    assert search.status_code == 201
    search_id = search.json()["id"]

    imported_neighbor = client.post(
        "/api/v1/discovery/import",
        json={
            "source": "neighbor",
            "neighbor_id": neighbor_id,
            "posts": [
                {
                    "source_url": "https://blog.naver.com/friend/123",
                    "title": "이웃의 새 글",
                }
            ],
        },
    )
    assert imported_neighbor.json() == {"imported_count": 1}
    imported_search = client.post(
        "/api/v1/discovery/import",
        json={
            "source": "search",
            "search_id": search_id,
            "posts": [
                {
                    "source_url": "https://blog.naver.com/newfriend/456",
                    "title": "전시 후기 신규 이웃 후보",
                    "publisher_name": "새 블로거",
                }
            ],
        },
    )
    assert imported_search.json() == {"imported_count": 1}
    assert client.post(
        "/api/v1/discovery/import",
        json={
            "source": "search",
            "search_id": search_id,
            "posts": [{"source_url": "https://blog.naver.com/newfriend/456", "title": "중복 글"}],
        },
    ).json() == {"imported_count": 0}

    neighbor_queue = client.get("/api/v1/app/discovery/queue?source=neighbor")
    assert neighbor_queue.status_code == 200
    assert neighbor_queue.json()["items"][0]["title"] == "이웃의 새 글"
    assert neighbor_queue.json()["items"][0]["source_label"] == "테스트 이웃"
    post_id = neighbor_queue.json()["items"][0]["id"]
    legacy_neighbor_queue = client.get("/api/v1/discovery/queue?source=neighbor")
    assert "source_label" not in legacy_neighbor_queue.json()["items"][0]
    assert (
        client.patch(f"/api/v1/discovery/queue/{post_id}", json={"state": "opened"}).json()["state"]
        == "opened"
    )
    search_item = client.get("/api/v1/app/discovery/queue?source=search").json()["items"][0]
    assert search_item["publisher_name"] == "새 블로거"
    assert search_item["source_label"] == "전시 후기"
    assert (
        client.patch(
            f"/api/v1/discovery/queue/{search_item['id']}", json={"state": "skipped"}
        ).json()["state"]
        == "skipped"
    )
    deleted_search = client.delete(f"/api/v1/discovery/searches/{search_id}")
    assert deleted_search.status_code == 204
    assert client.get("/api/v1/discovery/searches").json()["items"] == []
    retained_candidates = client.get(
        "/api/v1/app/discovery/queue?source=search&state=skipped"
    ).json()["items"]
    assert [item["id"] for item in retained_candidates] == [search_item["id"]]

    assert client.get("/api/v1/discovery/digest-settings").json() == {
        "timezone": "Asia/Seoul",
        "hour": 9,
        "minute": 0,
        "email_enabled": False,
        "smtp_configured": False,
    }
    assert (
        client.put(
            "/api/v1/discovery/digest-settings",
            json={"timezone": "Asia/Seoul", "hour": 8, "minute": 30, "email_enabled": False},
        ).json()["hour"]
        == 8
    )


def test_web_app_queue_pages_filters_and_restores_skipped_posts(client: TestClient) -> None:
    neighbor_id = client.post(
        "/api/v1/discovery/neighbors",
        json={
            "name": "큐 이웃",
            "blog_url": "https://blog.naver.com/queue-neighbor",
            "blog_id": "queue-neighbor",
        },
    ).json()["id"]
    imported = client.post(
        "/api/v1/discovery/import",
        json={
            "source": "neighbor",
            "neighbor_id": neighbor_id,
            "posts": [
                {"source_url": f"https://blog.naver.com/queue-neighbor/{number}", "title": title}
                for number, title in enumerate(("큐 첫 글", "큐 둘째 글", "큐 셋째 글"), start=1)
            ],
        },
    )
    assert imported.json() == {"imported_count": 3}

    first_page = client.get("/api/v1/app/discovery/queue?source=neighbor&limit=1")
    assert first_page.status_code == 200
    first = first_page.json()
    assert first["counts"] == {"neighbor": 3, "search": 0, "skipped": 0, "total": 3}
    assert len(first["items"]) == 1
    assert first["next_cursor"] is not None

    second = client.get(
        "/api/v1/app/discovery/queue",
        params={"source": "neighbor", "limit": 2, "cursor": first["next_cursor"]},
    ).json()
    assert {item["id"] for item in first["items"]}.isdisjoint(
        {item["id"] for item in second["items"]}
    )
    post_id = first["items"][0]["id"]
    skipped = client.patch(f"/api/v1/discovery/queue/{post_id}", json={"state": "skipped"})
    assert skipped.status_code == 200

    held = client.get("/api/v1/app/discovery/queue?state=skipped&query=큐")
    assert [item["id"] for item in held.json()["items"]] == [post_id]
    assert held.json()["counts"] == {"neighbor": 2, "search": 0, "skipped": 1, "total": 3}
    restored = client.patch(f"/api/v1/discovery/queue/{post_id}", json={"state": "queued"})
    assert restored.json()["state"] == "queued"


def test_web_app_queue_cursor_reaches_posts_beyond_the_legacy_source_cap(
    client: TestClient,
) -> None:
    neighbor_id = client.post(
        "/api/v1/discovery/neighbors",
        json={
            "name": "긴 큐 이웃",
            "blog_url": "https://blog.naver.com/long-queue-neighbor",
            "blog_id": "long-queue-neighbor",
        },
    ).json()["id"]
    for batch_start in range(0, 101, 50):
        batch_end = min(batch_start + 50, 101)
        response = client.post(
            "/api/v1/discovery/import",
            json={
                "source": "neighbor",
                "neighbor_id": neighbor_id,
                "posts": [
                    {
                        "source_url": f"https://blog.naver.com/long-queue-neighbor/{number}",
                        "title": f"긴 큐 {number}",
                    }
                    for number in range(batch_start, batch_end)
                ],
            },
        )
        assert response.json() == {"imported_count": batch_end - batch_start}

    first = client.get("/api/v1/app/discovery/queue?source=neighbor&limit=100").json()
    assert len(first["items"]) == 100
    assert first["counts"] == {"neighbor": 101, "search": 0, "skipped": 0, "total": 101}
    assert first["next_cursor"] is not None

    second = client.get(
        "/api/v1/app/discovery/queue",
        params={"source": "neighbor", "limit": 100, "cursor": first["next_cursor"]},
    ).json()
    assert len(second["items"]) == 1
    assert second["next_cursor"] is None
    assert {item["id"] for item in first["items"]}.isdisjoint(
        {item["id"] for item in second["items"]}
    )


def test_web_app_queue_can_filter_completed_and_unavailable_states(client: TestClient) -> None:
    neighbor_id = client.post(
        "/api/v1/discovery/neighbors",
        json={
            "name": "상태 이웃",
            "blog_url": "https://blog.naver.com/state-neighbor",
            "blog_id": "state-neighbor",
        },
    ).json()["id"]
    imported = client.post(
        "/api/v1/discovery/import",
        json={
            "source": "neighbor",
            "neighbor_id": neighbor_id,
            "posts": [
                {
                    "source_url": "https://blog.naver.com/state-neighbor/completed",
                    "title": "완료 상태",
                },
                {
                    "source_url": "https://blog.naver.com/state-neighbor/unavailable",
                    "title": "사용 불가 상태",
                },
            ],
        },
    )
    assert imported.json() == {"imported_count": 2}
    queued = client.get("/api/v1/app/discovery/queue?source=neighbor").json()["items"]
    by_title = {item["title"]: item["id"] for item in queued}
    assert (
        client.patch(
            f"/api/v1/discovery/queue/{by_title['완료 상태']}", json={"state": "completed"}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/v1/discovery/queue/{by_title['사용 불가 상태']}",
            json={"state": "unavailable"},
        ).status_code
        == 200
    )

    completed = client.get("/api/v1/app/discovery/queue?state=completed").json()
    unavailable = client.get("/api/v1/app/discovery/queue?state=unavailable").json()
    assert [item["title"] for item in completed["items"]] == ["완료 상태"]
    assert [item["title"] for item in unavailable["items"]] == ["사용 불가 상태"]
    assert completed["counts"] == {"neighbor": 0, "search": 0, "skipped": 0, "total": 0}


def test_discovery_search_import_applies_saved_exclusions_and_dated_freshness(
    client: TestClient,
) -> None:
    search_id = client.post(
        "/api/v1/discovery/searches",
        json={"query": "전시", "excluded_terms": ["광고"], "freshness_days": 7},
    ).json()["id"]
    response = client.post(
        "/api/v1/discovery/import",
        json={
            "source": "search",
            "search_id": search_id,
            "posts": [
                {
                    "source_url": "https://blog.naver.com/friend/11",
                    "title": "새 전시 후기",
                    "published_at": datetime.now(UTC).isoformat(),
                },
                {
                    "source_url": "https://blog.naver.com/friend/12",
                    "title": "광고 전시",
                    "published_at": datetime.now(UTC).isoformat(),
                },
                {
                    "source_url": "https://blog.naver.com/friend/13",
                    "title": "오래된 전시",
                    "published_at": "2000-01-01T00:00:00Z",
                },
            ],
        },
    )

    assert response.json() == {"imported_count": 1}
    queue = client.get("/api/v1/discovery/queue?source=search").json()["items"]
    assert [item["title"] for item in queue] == ["새 전시 후기"]


def test_history_lists_final_comment_and_delete_clears_local_record(client: TestClient) -> None:
    key = uuid4()
    recommendation_id, payload = create(client, key=key)
    selected = payload["candidates"][1]
    edited = "사용자가 기록에서 다시 복사할 최종 댓글입니다."
    reviewed = client.patch(
        f"/api/v1/recommendations/{recommendation_id}",
        json={
            "selected_candidate_id": selected["id"],
            "edited_comment": edited,
            "review_status": "approved",
        },
    )
    assert reviewed.status_code == 200

    history = client.get("/api/v1/recommendations?limit=1")
    assert history.status_code == 200
    assert history.json() == {
        "items": [
            {
                "id": str(recommendation_id),
                "source_url": BLOG_URL,
                "title": "주말 전시 후기",
                "review_status": "approved",
                "comment": edited,
                "created_at": payload["created_at"],
                "updated_at": reviewed.json()["updated_at"],
                "personalization_eligible": True,
            }
        ]
    }
    assert client.get("/api/v1/recommendations?limit=0").status_code == 422

    deleted = client.delete(f"/api/v1/recommendations/{recommendation_id}")
    assert deleted.status_code == 204
    assert deleted.content == b""
    assert client.get(f"/api/v1/recommendations/{recommendation_id}").status_code == 404
    assert client.delete(f"/api/v1/recommendations/{recommendation_id}").status_code == 404

    regenerated = client.post(
        "/api/v1/recommendations",
        json=request_payload(),
        headers={"Idempotency-Key": str(key)},
    )
    assert regenerated.status_code == 201
    assert regenerated.json()["id"] != str(recommendation_id)


def test_custom_preferences_are_generated_persisted_and_echoed(client: TestClient) -> None:
    response = client.post(
        "/api/v1/recommendations",
        json={
            **request_payload(),
            "relationship_level": "close",
            "speech_style": "banmal",
            "comment_length": "long",
            "comment_mood": "lively",
        },
        headers={"Idempotency-Key": str(uuid4())},
    )

    assert response.status_code == 201
    payload = response.json()
    assert {
        "relationship_level": payload["relationship_level"],
        "speech_style": payload["speech_style"],
        "comment_length": payload["comment_length"],
        "comment_mood": payload["comment_mood"],
    } == {
        "relationship_level": "close",
        "speech_style": "banmal",
        "comment_length": "long",
        "comment_mood": "lively",
    }
    assert all(200 <= len(candidate["comment"]) <= 320 for candidate in payload["candidates"])
    assert payload["quality_warnings"] == []
    assert client.get(f"/api/v1/recommendations/{payload['id']}").json() == payload


@pytest.mark.parametrize(
    "preferences",
    [
        {"relationship_level": "friendly", "speech_style": "banmal"},
        {"relationship_level": None},
        {"speech_style": "formal"},
        {"comment_length": "extra-long"},
        {"comment_mood": "electric"},
    ],
)
def test_invalid_preferences_return_422_problem(
    client: TestClient, preferences: dict[str, object]
) -> None:
    response = client.post(
        "/api/v1/recommendations",
        json={**request_payload(), **preferences},
        headers={"Idempotency-Key": str(uuid4())},
    )

    assert_problem(response, status=422, code="invalid_request")


def test_idempotency_replay_and_content_conflict(client: TestClient) -> None:
    key = uuid4()
    first = client.post(
        "/api/v1/recommendations",
        json=request_payload(),
        headers={"Idempotency-Key": str(key)},
    )
    replay = client.post(
        "/api/v1/recommendations",
        json=request_payload(),
        headers={"Idempotency-Key": str(key)},
    )
    conflict = client.post(
        "/api/v1/recommendations",
        json=request_payload(body="기존 요청과 완전히 다른 내용으로 구성된 충분히 긴 본문입니다."),
        headers={"Idempotency-Key": str(key)},
    )

    assert first.status_code == 201
    assert first.headers["Idempotency-Replayed"] == "false"
    assert replay.status_code == 200
    assert replay.headers["Idempotency-Replayed"] == "true"
    assert replay.json() == first.json()
    assert_problem(conflict, status=409, code="idempotency_conflict")


def test_idempotency_defaults_replay_but_preference_changes_conflict(
    client: TestClient,
) -> None:
    key = uuid4()
    omitted = client.post(
        "/api/v1/recommendations",
        json=request_payload(),
        headers={"Idempotency-Key": str(key)},
    )
    explicit_defaults = client.post(
        "/api/v1/recommendations",
        json={
            **request_payload(),
            "relationship_level": "friendly",
            "speech_style": "honorific",
            "comment_length": "medium",
        },
        headers={"Idempotency-Key": str(key)},
    )
    changed = client.post(
        "/api/v1/recommendations",
        json={**request_payload(), "comment_length": "short"},
        headers={"Idempotency-Key": str(key)},
    )

    assert omitted.status_code == 201
    assert explicit_defaults.status_code == 200
    assert explicit_defaults.json() == omitted.json()
    assert_problem(changed, status=409, code="idempotency_conflict")


def test_review_select_edit_and_forward_status_transitions(client: TestClient) -> None:
    recommendation_id, created = create(client)
    candidate_id = created["candidates"][0]["id"]

    approved = client.patch(
        f"/api/v1/recommendations/{recommendation_id}",
        json={
            "selected_candidate_id": candidate_id,
            "edited_comment": "사용자가 직접 다듬은 댓글입니다.",
            "review_status": "approved",
        },
    )
    completed = client.patch(
        f"/api/v1/recommendations/{recommendation_id}",
        json={"review_status": "completed"},
    )
    invalid_edit = client.patch(
        f"/api/v1/recommendations/{recommendation_id}",
        json={"edited_comment": "완료 뒤 수정"},
    )

    assert approved.status_code == 200
    assert approved.json()["selected_candidate_id"] == candidate_id
    assert approved.json()["edited_comment"] == "사용자가 직접 다듬은 댓글입니다."
    assert completed.json()["review_status"] == "completed"
    assert_problem(invalid_edit, status=409, code="review_conflict")


def test_review_supports_explicit_clears_and_rejects_invalid_changes(client: TestClient) -> None:
    recommendation_id, created = create(client)
    candidate_id = created["candidates"][0]["id"]
    client.patch(
        f"/api/v1/recommendations/{recommendation_id}",
        json={"selected_candidate_id": candidate_id, "edited_comment": "수정 댓글"},
    )

    cleared = client.patch(
        f"/api/v1/recommendations/{recommendation_id}",
        json={"selected_candidate_id": None, "edited_comment": None},
    )
    empty = client.patch(f"/api/v1/recommendations/{recommendation_id}", json={})
    foreign = client.patch(
        f"/api/v1/recommendations/{recommendation_id}",
        json={"selected_candidate_id": str(uuid4())},
    )

    assert cleared.json()["selected_candidate_id"] is None
    assert cleared.json()["edited_comment"] is None
    assert_problem(empty, status=422, code="invalid_request")
    assert_problem(foreign, status=409, code="review_conflict")


def test_review_maps_whitespace_only_comment_to_validation_problem(client: TestClient) -> None:
    recommendation_id, _ = create(client)
    response = client.patch(
        f"/api/v1/recommendations/{recommendation_id}",
        json={"edited_comment": " "},
    )

    assert_problem(response, status=422, code="invalid_review")


@pytest.mark.parametrize(
    "source_url",
    [
        "http://blog.naver.com/example/123",
        "https://blog.naver.com.evil.example/example/123",
        "https://blog.naver.com@evil.example/example/123",
        "https://user@blog.naver.com/example/123",
        "https://blog.naver.com:444/example/123",
        "https://[::1/example",
        "https://blog.naver.com/example/a b",
        "https://blog.naver.com/example/%zz",
        "https://blog.naver.com/example/%00",
        "https://blog.naver.com/example/%0a",
        "https://blog.naver.com/example/%20",
    ],
)
def test_create_rejects_spoofed_or_unsupported_source_urls(
    client: TestClient, source_url: str
) -> None:
    response = client.post(
        "/api/v1/recommendations",
        json=request_payload(source_url=source_url),
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert_problem(response, status=422, code="unsupported_source_url")


def test_validation_not_found_and_request_size_errors_are_problem_json(
    client: TestClient,
) -> None:
    missing_key = client.post("/api/v1/recommendations", json=request_payload())
    bad_key = client.post(
        "/api/v1/recommendations",
        json=request_payload(),
        headers={"Idempotency-Key": "not-a-uuid"},
    )
    short_body = client.post(
        "/api/v1/recommendations",
        json=request_payload(body=" 너무 짧음 "),
        headers={"Idempotency-Key": str(uuid4())},
    )
    not_found = client.get(f"/api/v1/recommendations/{uuid4()}")
    oversized = client.post(
        "/api/v1/recommendations",
        content=b"x" * 512_001,
        headers={"Content-Type": "application/json", "Idempotency-Key": str(uuid4())},
    )

    for response in (missing_key, bad_key, short_body):
        assert_problem(response, status=422, code="invalid_request")
    assert_problem(not_found, status=404, code="recommendation_not_found")
    assert_problem(oversized, status=413, code="payload_too_large")


def test_framework_404_and_405_errors_are_problem_json(client: TestClient) -> None:
    assert_problem(client.get("/missing-route"), status=404, code="route_not_found")
    assert_problem(client.delete("/health"), status=405, code="method_not_allowed")


def test_streamed_oversized_request_returns_cors_readable_problem(
    database_path: Path,
) -> None:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{database_path}",
        generator_mode="fake",
        app_environment="test",
        max_request_bytes=16,
    )
    app = create_app(settings)

    async def chunks():
        yield b"x" * 10
        yield b"y" * 10

    async def send_request() -> Response:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as async_client:
            return await async_client.post(
                "/api/v1/recommendations",
                content=chunks(),
                headers={
                    "Content-Type": "application/json",
                    "Idempotency-Key": str(uuid4()),
                    "Origin": ORIGIN,
                },
            )

    try:
        response = asyncio.run(send_request())
    finally:
        app.state.database_engine.dispose()

    assert_problem(response, status=413, code="payload_too_large")
    assert response.headers["access-control-allow-origin"] == ORIGIN


def test_cors_allows_only_configured_extension_origin(client: TestClient) -> None:
    allowed = client.options(
        "/api/v1/recommendations",
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,idempotency-key",
        },
    )
    denied = client.options(
        "/api/v1/recommendations",
        headers={
            "Origin": "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == ORIGIN
    assert allowed.headers["access-control-expose-headers"] == (
        "Idempotency-Replayed, Engagement-Replayed, Retry-After"
    )
    assert allowed.headers["access-control-allow-methods"] == "DELETE, GET, POST, PUT, PATCH"
    assert "access-control-allow-credentials" not in allowed.headers
    assert_problem(denied, status=403, code="cors_origin_forbidden")
    assert "access-control-allow-origin" not in denied.headers

    same_origin = client.get("/health", headers={"Origin": "http://testserver"})
    assert same_origin.status_code == 200
    assert "access-control-allow-origin" not in same_origin.headers

    delete_preflight = client.options(
        "/api/v1/recommendations/00000000-0000-4000-8000-000000000010",
        headers={"Origin": ORIGIN, "Access-Control-Request-Method": "DELETE"},
    )
    assert delete_preflight.status_code == 200
    assert delete_preflight.headers["access-control-allow-origin"] == ORIGIN

    put_preflight = client.options(
        "/api/v1/discovery/automation-settings",
        headers={"Origin": ORIGIN, "Access-Control-Request-Method": "PUT"},
    )
    assert put_preflight.status_code == 200
    assert put_preflight.headers["access-control-allow-origin"] == ORIGIN

    oversized = client.post(
        "/api/v1/recommendations",
        content=b"x" * 512_001,
        headers={
            "Content-Type": "application/json",
            "Idempotency-Key": str(uuid4()),
            "Origin": ORIGIN,
        },
    )
    assert_problem(oversized, status=413, code="payload_too_large")
    assert oversized.headers["access-control-allow-origin"] == ORIGIN


def test_local_rate_limit_returns_retry_after(database_path: Path) -> None:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{database_path}",
        generator_mode="fake",
        app_environment="test",
        rate_limit_requests=1,
    )
    with TestClient(create_app(settings)) as limited:
        create(limited)
        response = limited.post(
            "/api/v1/recommendations",
            json=request_payload(),
            headers={"Idempotency-Key": str(uuid4())},
        )

    assert_problem(response, status=429, code="generation_rate_limited")
    assert int(response.headers["Retry-After"]) >= 1


class BlockingGenerator:
    def __init__(self) -> None:
        self.calls = 0
        self.started = Event()
        self.release = Event()
        self.generation_returned = Event()

    def generate(self, post: CapturedPost, preferences: GenerationPreferences) -> GenerationOutput:
        self.calls += 1
        self.started.set()
        if not self.release.wait(timeout=5):
            raise TimeoutError("test did not release the blocking generator")
        output = DeterministicFakeGenerator().generate(post, preferences)
        self.generation_returned.set()
        return output


class RecordingGenerator:
    def __init__(self) -> None:
        self.calls = 0

    def generate(self, post: CapturedPost, preferences: GenerationPreferences) -> GenerationOutput:
        self.calls += 1
        return DeterministicFakeGenerator().generate(post, preferences)


def test_legacy_success_snapshot_replays_with_default_preference_echo(
    database_path: Path,
) -> None:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{database_path}",
        generator_mode="fake",
        app_environment="test",
    )
    generator = RecordingGenerator()
    key = uuid4()
    with TestClient(create_app(settings, generator=generator)) as api:
        created = api.post(
            "/api/v1/recommendations",
            json=request_payload(),
            headers={"Idempotency-Key": str(key)},
        )
        assert created.status_code == 201
        with closing(sqlite3.connect(database_path)) as connection:
            snapshot_json = connection.execute(
                "SELECT response_snapshot FROM idempotency_records WHERE key = ?", (str(key),)
            ).fetchone()[0]
            snapshot = json.loads(snapshot_json)
            del snapshot["generation_preferences"]
            connection.execute(
                "UPDATE idempotency_records SET response_snapshot = ? WHERE key = ?",
                (json.dumps(snapshot, ensure_ascii=False), str(key)),
            )
            connection.commit()

        replay = api.post(
            "/api/v1/recommendations",
            json={**request_payload(), "relationship_level": "friendly"},
            headers={"Idempotency-Key": str(key)},
        )

    assert replay.status_code == 200
    assert replay.headers["Idempotency-Replayed"] == "true"
    assert replay.json()["relationship_level"] == "friendly"
    assert replay.json()["speech_style"] == "honorific"
    assert replay.json()["comment_length"] == "medium"
    assert generator.calls == 1


def test_get_echoes_defaults_for_recommendation_migrated_from_v2(
    database_path: Path,
) -> None:
    database_url = f"sqlite:///{database_path}"
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", database_url)
    command.upgrade(config, "20260717_0002")
    recommendation_id = UUID(int=701)
    with closing(sqlite3.connect(database_path)) as connection:
        connection.execute(
            "INSERT INTO recommendations "
            "(id, source_url, title, content_hash, excerpt, summary, topics_json, "
            "review_status, selected_candidate_id, edited_comment, created_at, "
            "updated_at, version) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'drafted', NULL, NULL, ?, NULL, 0)",
            (
                str(recommendation_id),
                BLOG_URL,
                "이전 버전 합성 제목",
                "a" * 64,
                "이전 버전 일부",
                "이전 버전 합성 요약",
                '["전시"]',
                "2026-07-19T00:00:00Z",
            ),
        )
        for position, tone in enumerate(("warm", "curious", "supportive")):
            connection.execute(
                "INSERT INTO comment_candidates "
                "(id, recommendation_id, position, tone, comment, referenced_detail) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    str(UUID(int=710 + position)),
                    str(recommendation_id),
                    position,
                    tone,
                    f"{tone} 합성 댓글",
                    "이전 버전 근거",
                ),
            )
        connection.commit()

    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=database_url,
        generator_mode="fake",
        app_environment="test",
    )
    with TestClient(create_app(settings)) as api:
        response = api.get(f"/api/v1/recommendations/{recommendation_id}")

    assert response.status_code == 200
    assert response.json()["relationship_level"] == "friendly"
    assert response.json()["speech_style"] == "honorific"
    assert response.json()["comment_length"] == "medium"


def test_generation_timeout_is_safely_mapped(database_path: Path) -> None:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{database_path}",
        generator_mode="fake",
        app_environment="test",
        generation_timeout_seconds=0.001,
    )
    generator = BlockingGenerator()
    with TestClient(create_app(settings, generator=generator)) as slow:
        key = uuid4()
        response = slow.post(
            "/api/v1/recommendations",
            json=request_payload(),
            headers={"Idempotency-Key": str(key)},
        )
        assert_problem(response, status=504, code="generation_timeout")
        assert generator.started.wait(timeout=5)
        assert generator.calls == 1
        generator.release.set()
        assert generator.generation_returned.wait(timeout=5)

        replay: Response | None = None
        observed_statuses: list[int] = []
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            candidate = slow.post(
                "/api/v1/recommendations",
                json=request_payload(),
                headers={"Idempotency-Key": str(key)},
            )
            observed_statuses.append(candidate.status_code)
            if candidate.status_code == 200:
                replay = candidate
                break
            assert candidate.status_code in {409, 504}
            assert candidate.json()["code"] in {
                "generation_in_progress",
                "generation_timeout",
            }
            assert generator.calls == 1
            time.sleep(0.01)

        assert replay is not None, f"generation did not complete; statuses={observed_statuses}"
        assert replay.headers["Idempotency-Replayed"] == "true"
        assert generator.calls == 1


def test_provider_timeout_precedes_outer_timeout_and_blocks_duplicate(
    database_path: Path,
) -> None:
    calls = 0

    def provider_timeout(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("private timing detail", request=request)

    provider_client = OpenAI(
        api_key="test-key",
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(provider_timeout)),
    )
    generator = OpenAICommentGenerator(client=provider_client, timeout_seconds=0.05)
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{database_path}",
        generator_mode="openai",
        app_environment="test",
        openai_api_key="test-key",
        # Leave enough scheduling headroom for the provider client's 50 ms timeout to
        # surface first on slower WSL/CI filesystems.
        generation_timeout_seconds=10.0,
        openai_timeout_seconds=0.05,
    )
    key = uuid4()
    with TestClient(create_app(settings, generator=generator)) as api:
        first = api.post(
            "/api/v1/recommendations",
            json=request_payload(),
            headers={"Idempotency-Key": str(key)},
        )
        replay = api.post(
            "/api/v1/recommendations",
            json=request_payload(),
            headers={"Idempotency-Key": str(key)},
        )
    provider_client.close()

    assert_problem(first, status=409, code="generation_indeterminate")
    assert_problem(replay, status=409, code="generation_indeterminate")
    assert replay.headers["Idempotency-Replayed"] == "true"
    assert calls == 1


class FailingGenerator:
    def __init__(self, error: Exception) -> None:
        self.error = error
        self.calls = 0

    def generate(self, post: CapturedPost, preferences: GenerationPreferences) -> GenerationOutput:
        del post, preferences
        self.calls += 1
        raise self.error


@pytest.mark.parametrize(
    ("error", "status", "code", "retry_after"),
    [
        (GenerationRateLimitedError(17), 429, "generation_rate_limited", "17"),
        (GenerationRefusedError("provider refusal"), 502, "generation_refused", None),
        (GenerationUnavailableError("provider unavailable"), 503, "generation_unavailable", None),
        (GenerationNotStartedError("connection not opened"), 503, "generation_unavailable", None),
    ],
)
def test_provider_failures_are_mapped_without_raw_details(
    database_path: Path,
    error: Exception,
    status: int,
    code: str,
    retry_after: str | None,
) -> None:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{database_path}",
        generator_mode="fake",
        app_environment="test",
    )
    generator = FailingGenerator(error)
    key = uuid4()
    with TestClient(create_app(settings, generator=generator)) as failing:
        response = failing.post(
            "/api/v1/recommendations",
            json=request_payload(),
            headers={"Idempotency-Key": str(key)},
        )
        retry = failing.post(
            "/api/v1/recommendations",
            json=request_payload(),
            headers={"Idempotency-Key": str(key)},
        )

    assert_problem(response, status=status, code=code)
    assert str(error) not in response.text
    assert response.headers.get("Retry-After") == retry_after
    if isinstance(error, GenerationNotStartedError):
        assert_problem(retry, status=status, code=code)
        assert generator.calls == 2
    elif isinstance(error, GenerationRateLimitedError):
        assert_problem(retry, status=409, code="generation_indeterminate")
        assert retry.headers["Idempotency-Replayed"] == "true"
        assert generator.calls == 1
    else:
        assert_problem(retry, status=status, code=code)
        assert retry.headers["Idempotency-Replayed"] == "true"
        assert response.json()["request_id"] != retry.json()["request_id"]
        assert generator.calls == 1


def test_database_and_request_logs_never_contain_full_body(
    client: TestClient,
    database_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    private_body = "비공개-원문-표식 " + ("긴 테스트 본문 내용 " * 80)
    caplog.set_level(logging.INFO, logger="naver_blog_assistant.api")
    response = client.post(
        "/api/v1/recommendations",
        json=request_payload(body=private_body),
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 201

    with closing(sqlite3.connect(database_path)) as connection:
        dump = "\n".join(connection.iterdump())
    assert private_body not in dump
    assert private_body not in caplog.text
    assert "Idempotency-Key" not in caplog.text
    assert "path=/api/v1/recommendations status=201" in caplog.text


def test_database_never_contains_complete_short_body(
    client: TestClient, database_path: Path
) -> None:
    private_body = "마침표 없이 끝나는 비공개 합성 테스트 본문 내용"
    response = client.post(
        "/api/v1/recommendations",
        json=request_payload(body=private_body),
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 201

    with closing(sqlite3.connect(database_path)) as connection:
        dump = "\n".join(connection.iterdump())
    assert private_body not in dump
