"""Transport behavior for engagement runs and their event stream."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.application.automation import LOGIN_STATE_EXPRESSION
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver

RUNS = "/api/v1/automation/engagement-runs"
SESSION = "/api/v1/automation/session"
POST_URL = "https://blog.naver.com/example/223456789012"
BODY = "전시에서 인상 깊었던 작품과 관람 동선을 자세하게 정리한 합성 본문입니다."

CAPTURE = {
    "body": BODY,
    "canonicalUrl": None,
    "documentUrl": POST_URL,
    "originalLength": len(BODY),
    "selectorConfidence": 500,
    "selectorKind": "modern",
    "title": "합성 전시 후기",
}
PROBES: dict[str, Any] = {
    "captureArticle": CAPTURE,
    "probeLike": {"code": "already_liked", "selector": "#like", "optionSelector": None},
    "probeComment": {
        "code": "ready",
        "editorSelector": "#editor",
        "submitSelector": "#submit",
        "openerSelector": None,
        "state": "empty",
    },
    "countMatchingComments": 1,
    "commentStillPending": False,
    "captchaVisible": False,
    "diagnoseCommentPage": {"blocked": False, "captcha": False, "loginRequired": False},
}


@pytest.fixture
def driver() -> FakeBrowserDriver:
    return FakeBrowserDriver(
        page_results={LOGIN_STATE_EXPRESSION: "authenticated"},
        page_probe_results=dict(PROBES),
    )


def _settings(tmp_path: Path) -> ApiSettings:
    return ApiSettings(
        database_url=f"sqlite:///{tmp_path / 'runs.db'}",
        generator_mode="fake",
        app_environment="test",
        rate_limit_requests=50,
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
    )


@pytest.fixture
def client(tmp_path: Path, driver: FakeBrowserDriver) -> Iterator[TestClient]:
    with TestClient(create_app(_settings(tmp_path), browser_driver=driver)) as test_client:
        test_client.post(f"{SESSION}/launch")
        yield test_client


def approve(client: TestClient) -> tuple[str, str]:
    """Import one queued post, generate a comment, and approve it."""
    neighbor = client.post(
        "/api/v1/discovery/neighbors",
        json={
            "name": "합성 이웃",
            "blog_url": "https://blog.naver.com/example",
            "blog_id": "example",
        },
    )
    assert neighbor.status_code in {200, 201}, neighbor.text
    imported = client.post(
        "/api/v1/discovery/import",
        json={
            "source": "neighbor",
            "neighbor_id": neighbor.json()["id"],
            "posts": [
                {
                    "source_url": POST_URL,
                    "title": "합성 전시 후기",
                    "publisher_name": "합성 이웃",
                    "publisher_blog_id": "example",
                }
            ],
        },
    )
    assert imported.status_code in {200, 201}, imported.text
    queue = client.get("/api/v1/discovery/queue", params={"source": "neighbor"}).json()["items"]
    post_id = queue[0]["id"]
    response = client.post("/api/v1/automation/comments", json={"url": POST_URL})
    assert response.status_code == 200, response.text
    generated = response.json()
    recommendation = generated["recommendation"]
    client.patch(
        f"/api/v1/recommendations/{recommendation['id']}",
        json={
            "selected_candidate_id": recommendation["candidates"][0]["id"],
            "edited_comment": "합성 댓글입니다.",
            "review_status": "approved",
        },
    )
    return post_id, recommendation["id"]


def accept_consent(client: TestClient) -> None:
    client.put(
        "/api/v1/settings/automation_consent",
        json={"payload": {"accepted": True, "consent_version": 1}},
    )


async def _approve_async(http: AsyncClient) -> tuple[str, str]:
    """Import one queued post, generate a comment, and approve it over an async transport."""
    neighbor = await http.post(
        "/api/v1/discovery/neighbors",
        json={
            "name": "합성 이웃",
            "blog_url": "https://blog.naver.com/example",
            "blog_id": "example",
        },
    )
    assert neighbor.status_code in {200, 201}, neighbor.text
    imported = await http.post(
        "/api/v1/discovery/import",
        json={
            "source": "neighbor",
            "neighbor_id": neighbor.json()["id"],
            "posts": [
                {
                    "source_url": POST_URL,
                    "title": "합성 전시 후기",
                    "publisher_name": "합성 이웃",
                    "publisher_blog_id": "example",
                }
            ],
        },
    )
    assert imported.status_code in {200, 201}, imported.text
    queued = await http.get("/api/v1/discovery/queue", params={"source": "neighbor"})
    post_id = queued.json()["items"][0]["id"]
    generated = await http.post("/api/v1/automation/comments", json={"url": POST_URL})
    assert generated.status_code == 200, generated.text
    recommendation = generated.json()["recommendation"]
    await http.patch(
        f"/api/v1/recommendations/{recommendation['id']}",
        json={
            "selected_candidate_id": recommendation["candidates"][0]["id"],
            "edited_comment": "합성 댓글입니다.",
            "review_status": "approved",
        },
    )
    return post_id, recommendation["id"]


def test_a_run_requires_consent(client: TestClient) -> None:
    post_id, recommendation_id = approve(client)

    response = client.post(
        RUNS, json={"discovery_post_id": post_id, "recommendation_id": recommendation_id}
    )

    assert response.status_code == 403
    assert response.json()["code"] == "consent_missing"


def test_a_run_requires_an_approved_recommendation(client: TestClient) -> None:
    accept_consent(client)
    post_id, _ = approve(client)
    fresh = client.post(
        "/api/v1/automation/comments", json={"url": POST_URL, "replace": True}
    ).json()

    response = client.post(
        RUNS,
        json={"discovery_post_id": post_id, "recommendation_id": fresh["recommendation"]["id"]},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "recommendation_not_approved"


def test_an_unknown_post_is_not_found(client: TestClient) -> None:
    accept_consent(client)
    _, recommendation_id = approve(client)

    response = client.post(
        RUNS, json={"discovery_post_id": str(uuid4()), "recommendation_id": recommendation_id}
    )

    assert response.status_code == 404
    assert response.json()["code"] == "post_not_found"


def test_an_unknown_recommendation_is_not_found(client: TestClient) -> None:
    accept_consent(client)
    post_id, _ = approve(client)

    response = client.post(
        RUNS, json={"discovery_post_id": post_id, "recommendation_id": str(uuid4())}
    )

    assert response.status_code == 404
    assert response.json()["code"] == "recommendation_not_found"


def test_an_invalid_request_fails_validation(client: TestClient) -> None:
    response = client.post(RUNS, json={"discovery_post_id": "not-a-uuid"})

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"


def test_an_accepted_run_returns_the_persisted_run(client: TestClient) -> None:
    accept_consent(client)
    post_id, recommendation_id = approve(client)

    response = client.post(
        RUNS, json={"discovery_post_id": post_id, "recommendation_id": recommendation_id}
    )

    assert response.status_code == 202
    body = response.json()
    assert body["discovery_post_id"] == post_id
    assert [step["name"] for step in body["steps"]] == ["like", "comment"]


def test_the_run_records_each_step_result(client: TestClient) -> None:
    accept_consent(client)
    post_id, recommendation_id = approve(client)

    run = client.post(
        RUNS, json={"discovery_post_id": post_id, "recommendation_id": recommendation_id}
    ).json()
    stored = client.get(f"/api/v1/engagement-runs/{run['id']}").json()

    codes = {step["name"]: step["result_code"] for step in stored["steps"]}
    assert codes["like"] == "already_liked"
    assert codes["comment"] == "comment_published"
    assert stored["state"] == "succeeded"


def test_the_event_stream_replays_a_finished_run(client: TestClient) -> None:
    accept_consent(client)
    post_id, recommendation_id = approve(client)
    run = client.post(
        RUNS, json={"discovery_post_id": post_id, "recommendation_id": recommendation_id}
    ).json()

    response = client.get(f"{RUNS}/{run['id']}/events")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-store"
    body = response.text
    assert "event: run_started" in body
    assert "event: step_completed" in body
    assert '"result_code": "comment_published"' in body
    assert "event: run_finished" in body


def test_the_event_stream_closes_for_an_unknown_run(client: TestClient) -> None:
    accept_consent(client)
    post_id, recommendation_id = approve(client)
    client.post(RUNS, json={"discovery_post_id": post_id, "recommendation_id": recommendation_id})

    response = client.get(f"{RUNS}/{uuid4()}/events")

    assert response.status_code == 200
    assert response.text == ""


def test_the_event_stream_terminates_over_an_asgi_transport(
    tmp_path: Path, driver: FakeBrowserDriver
) -> None:
    """A real async transport consumes the stream incrementally and it still ends."""

    async def scenario() -> str:
        app = create_app(_settings(tmp_path), browser_driver=driver)
        async with app.router.lifespan_context(app):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://testserver") as http:
                await http.post(f"{SESSION}/launch")
                await http.put(
                    "/api/v1/settings/automation_consent",
                    json={"payload": {"accepted": True, "consent_version": 1}},
                )
                post_id, recommendation_id = await _approve_async(http)
                created = await http.post(
                    RUNS,
                    json={
                        "discovery_post_id": post_id,
                        "recommendation_id": recommendation_id,
                    },
                )
                assert created.status_code == 202, created.text
                run_id = created.json()["id"]
                chunks: list[str] = []
                async with http.stream("GET", f"{RUNS}/{run_id}/events") as response:
                    assert response.status_code == 200
                    async for chunk in response.aiter_text():
                        chunks.append(chunk)
                return "".join(chunks)

    async def bounded() -> str:
        async with asyncio.timeout(20):
            return await scenario()

    body = asyncio.run(bounded())

    assert "event: run_finished" in body


def test_a_second_run_for_the_same_post_replays_the_existing_run(client: TestClient) -> None:
    accept_consent(client)
    post_id, recommendation_id = approve(client)
    first = client.post(
        RUNS, json={"discovery_post_id": post_id, "recommendation_id": recommendation_id}
    ).json()

    second = client.post(
        RUNS, json={"discovery_post_id": post_id, "recommendation_id": recommendation_id}
    )

    assert second.status_code == 202
    assert second.json()["id"] == first["id"]
