"""Semantic checks between Pydantic transport models and the committed contract."""

from pathlib import Path

import pytest
import yaml
from fastapi.openapi.utils import get_openapi
from fastapi.routing import APIRoute
from pydantic import ValidationError

from naver_blog_assistant.api import ApiSettings, create_app
from naver_blog_assistant.api.models import (
    CreateRecommendationRequest,
    ProblemDetails,
    RecommendationHistoryItemResponse,
    RecommendationHistoryResponse,
    RecommendationResponse,
    ReviewRecommendationRequest,
    ServiceStatusResponse,
)
from naver_blog_assistant.domain import CommentLength, CommentMood, Relationship, SpeechStyle

ROOT = Path(__file__).parents[3]
ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


def test_checked_in_operations_match_fastapi_operation_ids() -> None:
    contract = yaml.safe_load((ROOT / "docs/api/openapi.yaml").read_text(encoding="utf-8"))
    app = create_app(
        ApiSettings(
            extension_origin=ORIGIN,
            database_url="sqlite:///:memory:",
            generator_mode="fake",
            app_environment="test",
        ),
        run_migrations=False,
    )
    assert app.openapi() == contract

    generated = get_openapi(title=app.title, version=app.version, routes=app.routes)
    http_methods = {"get", "post", "put", "patch", "delete", "options", "head", "trace"}
    expected_operations = {
        (path, method)
        for path, path_item in contract["paths"].items()
        for method in path_item
        if method in http_methods
    }
    actual_operations = {
        (route.path, method.lower())
        for route in app.routes
        if isinstance(route, APIRoute)
        for method in (route.methods or set())
    }
    assert actual_operations == expected_operations
    for path, method in expected_operations:
        generated_operation = generated["paths"][path][method]
        documented_operation = contract["paths"][path][method]
        assert generated_operation["operationId"] == documented_operation["operationId"]
        assert set(generated_operation["responses"]) == set(documented_operation["responses"])
        for status, documented_response in documented_operation["responses"].items():
            generated_response = generated_operation["responses"][status]
            if "$ref" in documented_response:
                documented_response = contract["components"]["responses"][
                    documented_response["$ref"].rsplit("/", 1)[-1]
                ]
            if "content" in documented_response and "application/problem+json" in (
                documented_response.get("content") or {}
            ):
                problem = generated_response["content"]["application/problem+json"]
                assert problem["schema"]["$ref"] == "#/components/schemas/ProblemDetails"
            assert set(generated_response.get("headers", {})) == set(
                documented_response.get("headers", {})
            )

    post_responses = generated["paths"]["/api/v1/recommendations"]["post"]["responses"]
    for status in ("200", "201"):
        response = post_responses[status]
        assert response["content"]["application/json"]["schema"] == {
            "$ref": "#/components/schemas/RecommendationResponse"
        }
        assert response["headers"]["Idempotency-Replayed"]["schema"] == {"type": "boolean"}
    app.state.database_engine.dispose()


def test_transport_models_preserve_contract_fields_and_limits() -> None:
    contract = yaml.safe_load((ROOT / "docs/api/openapi.yaml").read_text(encoding="utf-8"))
    schemas = contract["components"]["schemas"]

    pairs = (
        (CreateRecommendationRequest, "CreateRecommendationRequest"),
        (ServiceStatusResponse, "ServiceStatusResponse"),
        (RecommendationHistoryItemResponse, "RecommendationHistoryItemResponse"),
        (RecommendationHistoryResponse, "RecommendationHistoryResponse"),
        (RecommendationResponse, "RecommendationResponse"),
        (ReviewRecommendationRequest, "ReviewRecommendationRequest"),
        (ProblemDetails, "ProblemDetails"),
    )
    for model, name in pairs:
        generated = model.model_json_schema()
        documented = schemas[name]
        assert set(generated["properties"]) == set(documented["properties"])
        assert set(generated.get("required", ())) == set(documented.get("required", ()))

    request_properties = CreateRecommendationRequest.model_json_schema()["properties"]
    assert request_properties["source_url"]["maxLength"] == 2048
    assert request_properties["source_url"]["format"] == "uri"
    assert request_properties["title"]["maxLength"] == 300
    assert request_properties["body"]["minLength"] == 20
    assert request_properties["body"]["maxLength"] == 100_000
    assert request_properties["relationship_level"] == {
        "default": "friendly",
        "enum": ["new", "polite", "friendly", "close"],
        "title": "Relationship Level",
        "type": "string",
    }
    assert request_properties["speech_style"]["default"] == "honorific"
    assert request_properties["speech_style"]["enum"] == ["honorific", "banmal"]
    assert request_properties["comment_length"]["default"] == "medium"
    assert request_properties["comment_length"]["enum"] == ["short", "medium", "long"]
    assert request_properties["comment_mood"]["default"] == "warm"
    assert request_properties["comment_mood"]["enum"] == ["calm", "warm", "lively"]

    response_properties = RecommendationResponse.model_json_schema()["properties"]
    assert response_properties["candidates"]["minItems"] == 3
    assert response_properties["candidates"]["maxItems"] == 3
    assert response_properties["quality_warnings"]["maxItems"] == 3
    assert response_properties["quality_warnings"]["uniqueItems"] is True
    response_required = set(RecommendationResponse.model_json_schema()["required"])
    assert {
        "relationship_level",
        "speech_style",
        "comment_length",
        "comment_mood",
        "quality_warnings",
    } <= response_required
    assert "relationship_level" not in CreateRecommendationRequest.model_json_schema()["required"]


def test_request_preferences_default_map_and_allow_partial_override() -> None:
    base = {
        "source_url": "https://blog.naver.com/example/1",
        "title": "합성 제목",
        "body": "설정 mapping을 검증하기 위한 충분히 긴 합성 본문입니다.",
    }

    defaults = CreateRecommendationRequest.model_validate(base).to_generation_preferences()
    partial = CreateRecommendationRequest.model_validate(
        {
            **base,
            "relationship_level": "polite",
            "comment_length": "long",
            "comment_mood": "lively",
        }
    ).to_generation_preferences()

    assert defaults.relationship is Relationship.FRIENDLY
    assert defaults.speech is SpeechStyle.HONORIFIC
    assert defaults.length is CommentLength.MEDIUM
    assert defaults.mood is CommentMood.WARM
    assert partial.relationship is Relationship.POLITE
    assert partial.speech is SpeechStyle.HONORIFIC
    assert partial.length is CommentLength.LONG
    assert partial.mood is CommentMood.LIVELY


@pytest.mark.parametrize(
    "changes",
    [
        {"relationship_level": None},
        {"speech_style": None},
        {"comment_length": None},
        {"comment_mood": None},
        {"relationship_level": "unknown"},
        {"speech_style": "formal"},
        {"comment_length": "extra-long"},
        {"comment_mood": "electric"},
        {"relationship_level": "friendly", "speech_style": "banmal"},
        {"unexpected": "value"},
    ],
)
def test_request_preferences_reject_null_unknown_extra_and_invalid_combinations(
    changes: dict[str, object],
) -> None:
    base: dict[str, object] = {
        "source_url": "https://blog.naver.com/example/1",
        "title": "합성 제목",
        "body": "설정 validation을 검증하기 위한 충분히 긴 합성 본문입니다.",
    }
    with pytest.raises(ValidationError):
        CreateRecommendationRequest.model_validate({**base, **changes})
