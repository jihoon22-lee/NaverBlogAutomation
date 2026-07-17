"""Behavior and privacy contract tests for the local FastAPI adapter."""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient, Response

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.application import (
    GenerationRateLimitedError,
    GenerationRefusedError,
    GenerationUnavailableError,
)
from naver_blog_assistant.domain import CapturedPost, GenerationOutput
from naver_blog_assistant.infrastructure.generators import DeterministicFakeGenerator
from naver_blog_assistant.ports import GenerationNotStartedError

ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BLOG_URL = "https://blog.naver.com/example/123"
BODY = "전시에서 인상 깊었던 작품과 관람 동선을 자세하게 정리한 테스트 본문입니다."


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

    recommendation_id, payload = create(client)

    assert payload["title"] == "주말 전시 후기"
    assert payload["review_status"] == "drafted"
    assert len(payload["candidates"]) == 3
    assert {item["tone"] for item in payload["candidates"]} == {
        "warm",
        "curious",
        "supportive",
    }
    assert "content_hash" not in payload and "excerpt" not in payload and "body" not in payload
    assert client.get(f"/api/v1/recommendations/{recommendation_id}").json() == payload


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
    assert "access-control-allow-credentials" not in allowed.headers
    assert_problem(denied, status=403, code="cors_origin_forbidden")
    assert "access-control-allow-origin" not in denied.headers

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


class SlowGenerator:
    def generate(self, post: CapturedPost) -> GenerationOutput:
        time.sleep(0.05)
        return DeterministicFakeGenerator().generate(post)


def test_generation_timeout_is_safely_mapped(database_path: Path) -> None:
    settings = ApiSettings(
        extension_origin=ORIGIN,
        database_url=f"sqlite:///{database_path}",
        generator_mode="fake",
        app_environment="test",
        generation_timeout_seconds=0.001,
    )
    with TestClient(create_app(settings, generator=SlowGenerator())) as slow:
        key = uuid4()
        response = slow.post(
            "/api/v1/recommendations",
            json=request_payload(),
            headers={"Idempotency-Key": str(key)},
        )
        assert_problem(response, status=504, code="generation_timeout")
        time.sleep(0.08)
        replay = slow.post(
            "/api/v1/recommendations",
            json=request_payload(),
            headers={"Idempotency-Key": str(key)},
        )
        assert replay.status_code == 200
        assert replay.headers["Idempotency-Replayed"] == "true"


class FailingGenerator:
    def __init__(self, error: Exception) -> None:
        self.error = error
        self.calls = 0

    def generate(self, post: CapturedPost) -> GenerationOutput:
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
    else:
        assert_problem(retry, status=409, code="generation_in_progress")
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
