"""OpenAI adapter contract tests using the real SDK over MockTransport."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import cast

import httpx
import pytest
from openai import OpenAI

from naver_blog_assistant.application import (
    GenerationIndeterminateError,
    GenerationInvalidError,
    GenerationRateLimitedError,
    GenerationRefusedError,
    GenerationUnavailableError,
)
from naver_blog_assistant.domain import CandidateTone, CapturedPost
from naver_blog_assistant.infrastructure.generators.openai import OpenAICommentGenerator
from naver_blog_assistant.ports import GenerationNotStartedError


def post() -> CapturedPost:
    return CapturedPost(
        source_url="https://blog.naver.com/private-account/123",
        title="주말 전시 후기",
        body="푸른 조각과 조용한 2층 전시 동선이 인상적이었다.",
    )


def completed_payload(content: str | None = None) -> dict[str, object]:
    text = content or json.dumps(
        {
            "summary": "푸른 조각과 관람 동선을 소개한 후기",
            "topics": ["전시", "조각"],
            "candidates": [
                {
                    "tone": tone.value,
                    "comment": f"{tone.value} 댓글",
                    "referenced_detail": "푸른 조각",
                }
                for tone in CandidateTone
            ],
        },
        ensure_ascii=False,
    )
    return {
        "id": "resp_test",
        "created_at": 0,
        "model": "gpt-5.6-terra",
        "object": "response",
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "output": [
            {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
        ],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
    }


def generator(handler: Callable[[httpx.Request], httpx.Response]) -> OpenAICommentGenerator:
    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = OpenAI(api_key="test-key", max_retries=0, http_client=http_client)
    return OpenAICommentGenerator(client=client, timeout_seconds=3, max_output_tokens=777)


def test_injected_client_must_disable_sdk_retries() -> None:
    client = OpenAI(
        api_key="test-key",
        max_retries=2,
        http_client=httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200))),
    )
    with pytest.raises(ValueError, match="max_retries=0"):
        OpenAICommentGenerator(client=client)
    client.close()


def test_structured_parse_uses_privacy_and_safety_controls() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json=completed_payload())

    result = generator(handler).generate(post())

    assert result.summary.startswith("푸른 조각")
    assert {item.tone for item in result.candidates} == set(CandidateTone)
    assert captured["store"] is False
    assert captured["max_output_tokens"] == 777
    assert captured["reasoning"] == {"effort": "low"}
    serialized = json.dumps(captured, ensure_ascii=False)
    assert "private-account" not in serialized
    assert "https://blog.naver.com" not in serialized
    assert "신뢰할 수 없는 데이터" in serialized
    text_config = cast(dict[str, object], captured["text"])
    output_format = cast(dict[str, object], text_config["format"])
    assert output_format["type"] == "json_schema"
    assert output_format["strict"] is True


def test_refusal_is_mapped_without_exposing_provider_text() -> None:
    payload = completed_payload()
    payload["output"] = [
        {
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "refusal", "refusal": "sensitive provider explanation"}],
        }
    ]
    item = generator(lambda _: httpx.Response(200, json=payload))

    with pytest.raises(GenerationRefusedError, match="provider refused"):
        item.generate(post())


def test_invalid_structured_output_is_mapped() -> None:
    item = generator(lambda _: httpx.Response(200, json=completed_payload('{"summary": 1}')))

    with pytest.raises(GenerationInvalidError):
        item.generate(post())


def test_rate_limit_is_a_definite_safe_to_retry_rejection() -> None:
    item = generator(
        lambda _: httpx.Response(
            429,
            headers={"Retry-After": "12"},
            json={"error": {"message": "secret", "type": "rate_limit_error"}},
        )
    )

    with pytest.raises(GenerationRateLimitedError) as caught:
        item.generate(post())
    assert isinstance(caught.value, GenerationNotStartedError)
    assert caught.value.retry_after == 12


@pytest.mark.parametrize("value", ["not-seconds", "-2"])
def test_malformed_retry_after_is_not_forwarded(value: str) -> None:
    item = generator(
        lambda _: httpx.Response(
            429,
            headers={"Retry-After": value},
            json={"error": {"message": "secret", "type": "rate_limit_error"}},
        )
    )
    with pytest.raises(GenerationRateLimitedError) as caught:
        item.generate(post())
    assert caught.value.retry_after is None


def test_connection_failure_is_indeterminate() -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("secret endpoint details", request=request)

    with pytest.raises(GenerationIndeterminateError, match="provider connection failed"):
        generator(fail).generate(post())


def test_timeout_is_indeterminate() -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("secret timing", request=request)

    with pytest.raises(GenerationIndeterminateError, match="provider timeout"):
        generator(timeout).generate(post())


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_definite_http_rejection_is_safe_to_retry(status: int) -> None:
    item = generator(
        lambda _: httpx.Response(
            status,
            json={"error": {"message": "secret payload", "type": "invalid_request_error"}},
        )
    )
    with pytest.raises(GenerationUnavailableError) as caught:
        item.generate(post())
    assert isinstance(caught.value, GenerationNotStartedError)


@pytest.mark.parametrize("status", [408, 409, 500, 502])
def test_ambiguous_http_status_is_indeterminate(status: int) -> None:
    item = generator(
        lambda _: httpx.Response(
            status,
            json={"error": {"message": "secret payload", "type": "server_error"}},
        )
    )
    with pytest.raises(GenerationIndeterminateError, match="outcome is indeterminate") as caught:
        item.generate(post())
    assert not isinstance(caught.value, GenerationNotStartedError)


def test_incomplete_output_is_invalid() -> None:
    payload = completed_payload()
    payload["status"] = "incomplete"
    payload["incomplete_details"] = {"reason": "max_output_tokens"}

    with pytest.raises(GenerationInvalidError, match="incomplete"):
        generator(lambda _: httpx.Response(200, json=payload)).generate(post())


def test_content_filter_incomplete_is_refused() -> None:
    payload = completed_payload()
    payload["status"] = "incomplete"
    payload["incomplete_details"] = {"reason": "content_filter"}

    with pytest.raises(GenerationRefusedError, match="content filter"):
        generator(lambda _: httpx.Response(200, json=payload)).generate(post())


def test_noncompleted_error_response_is_unavailable() -> None:
    payload = completed_payload()
    payload["status"] = "failed"
    payload["error"] = {"code": "server_error", "message": "secret provider payload"}

    with pytest.raises(GenerationUnavailableError, match="did not complete"):
        generator(lambda _: httpx.Response(200, json=payload)).generate(post())


def test_sdk_response_validation_failure_is_invalid() -> None:
    http_client = httpx.Client(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"unexpected": True}))
    )
    client = OpenAI(
        api_key="test-key",
        max_retries=0,
        http_client=http_client,
        _strict_response_validation=True,
    )
    item = OpenAICommentGenerator(client=client)

    with pytest.raises(GenerationInvalidError, match="response validation failed"):
        item.generate(post())
    client.close()
