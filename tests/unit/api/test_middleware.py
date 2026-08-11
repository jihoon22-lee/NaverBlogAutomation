"""Tests for the local web-app origin boundary."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from naver_blog_assistant.api.middleware import OriginBoundaryMiddleware


def test_same_origin_web_app_request_needs_no_cors_header() -> None:
    app = FastAPI()
    app.add_middleware(OriginBoundaryMiddleware)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    with TestClient(app) as client:
        response = client.get("/health", headers={"Origin": "http://testserver"})

    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers


def test_foreign_browser_origin_is_rejected() -> None:
    app = FastAPI()
    app.add_middleware(OriginBoundaryMiddleware)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    with TestClient(app) as client:
        response = client.get("/health", headers={"Origin": "http://example.test"})

    assert response.status_code == 403
    assert response.json()["code"] == "origin_forbidden"
