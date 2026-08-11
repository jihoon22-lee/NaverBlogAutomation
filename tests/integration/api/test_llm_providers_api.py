"""Transport behavior for the provider configuration endpoint."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from naver_blog_assistant.api import ApiSettings, create_app

PROVIDERS = "/api/v1/llm/providers"
GEMINI_KEY = "gemini-secret-value"
ANTHROPIC_KEY = "anthropic-secret-value"


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = ApiSettings(
        database_url=f"sqlite:///{tmp_path / 'providers.db'}",
        generator_mode="fake",
        app_environment="test",
        gemini_api_key=GEMINI_KEY,
        gemini_model="gemini-test",
        anthropic_api_key="   ",
        anthropic_model="claude-test",
        automation_driver="fake",
        automation_headless=True,
        automation_profile_dir=str(tmp_path / "profile"),
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_it_lists_every_provider_in_declaration_order(client: TestClient) -> None:
    response = client.get(PROVIDERS)

    assert response.status_code == 200
    assert [item["provider"] for item in response.json()["items"]] == [
        "openai",
        "gemini",
        "anthropic",
    ]


def test_it_reports_configuration_state_only(client: TestClient) -> None:
    items = {item["provider"]: item for item in client.get(PROVIDERS).json()["items"]}

    assert items["gemini"] == {"provider": "gemini", "configured": True, "model": "gemini-test"}
    assert items["anthropic"]["configured"] is False
    assert items["openai"]["configured"] is False


def test_no_credential_appears_in_the_response(client: TestClient) -> None:
    body = client.get(PROVIDERS).text

    assert GEMINI_KEY not in body
    assert ANTHROPIC_KEY not in body


def test_the_superseded_provider_selection_setting_is_not_available(client: TestClient) -> None:
    response = client.get("/api/v1/settings/llm_providers")

    assert response.status_code == 404
    assert response.json()["code"] == "setting_not_found"
