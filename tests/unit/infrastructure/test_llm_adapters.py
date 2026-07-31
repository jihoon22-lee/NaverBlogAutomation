"""Error mapping and result handling for every structured completion adapter.

No test makes a network call: each provider's SDK objects are stubbed so the mapping from provider
failure to application error is checked exactly once per case. Every provider must agree on the
meaning of a failure, which is why the same table is asserted three times.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from anthropic import (
    Anthropic,
)
from openai import (
    OpenAI,
)
from pydantic import BaseModel

from naver_blog_assistant.application import (
    GenerationIndeterminateError,
    GenerationInvalidError,
    GenerationRateLimitedError,
    GenerationRefusedError,
    GenerationUnavailableError,
)
from naver_blog_assistant.domain.llm import LlmProvider
from naver_blog_assistant.infrastructure.llm.anthropic_client import (
    TOOL_NAME,
    AnthropicStructuredClient,
)
from naver_blog_assistant.infrastructure.llm.gemini_client import GeminiStructuredClient
from naver_blog_assistant.infrastructure.llm.openai_client import OpenAIStructuredClient
from naver_blog_assistant.ports import GenerationNotStartedError


class Answer(BaseModel):
    value: str


REQUEST = httpx.Request("POST", "https://provider.example/v1")


def response(status: int, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status, headers=headers or {}, request=REQUEST)


def call(client: Any) -> Answer:
    return client.structured(
        instructions="지시",
        input_text="입력",
        schema=Answer,
        timeout_seconds=5.0,
        max_output_tokens=100,
    )


def openai_client(model: str = "gpt-test") -> OpenAIStructuredClient:
    """Build a client whose transport never leaves the process."""
    http_client = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
    return OpenAIStructuredClient(
        client=OpenAI(api_key="test", max_retries=0, http_client=http_client), model=model
    )


class TestOpenAIAdapter:
    """The response mapping is covered end to end in `test_openai_generator.py`."""

    def test_it_reports_its_provider_and_model(self) -> None:
        client = openai_client()

        assert client.provider is LlmProvider.OPENAI
        assert client.model == "gpt-test"

    def test_an_injected_client_must_not_retry(self) -> None:
        http_client = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
        with pytest.raises(ValueError, match="max_retries=0"):
            OpenAIStructuredClient(
                client=OpenAI(api_key="test", max_retries=2, http_client=http_client)
            )

    def test_a_key_is_required_without_a_client(self) -> None:
        with pytest.raises(ValueError, match="api_key"):
            OpenAIStructuredClient(api_key="  ")


class _GeminiModels:
    def __init__(self, result: Any) -> None:
        self._result = result
        self.calls: list[dict[str, Any]] = []

    def generate_content(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if isinstance(self._result, Exception):
            raise self._result
        return self._result


class _GeminiClient:
    def __init__(self, result: Any) -> None:
        self.models = _GeminiModels(result)
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _GeminiResponse:
    def __init__(
        self,
        *,
        parsed: Any = None,
        text: str | None = None,
        finish_reason: str | None = None,
        block_reason: str | None = None,
    ) -> None:
        self.parsed = parsed
        self.text = text
        self.candidates = (type("Candidate", (), {"finish_reason": finish_reason})(),)
        self.prompt_feedback = type("Feedback", (), {"block_reason": block_reason})()


class _GeminiError(Exception):
    def __init__(self, code: int, headers: dict[str, str] | None = None) -> None:
        super().__init__(f"status {code}")
        self.code = code
        self.response = httpx.Response(code, headers=headers or {}, request=REQUEST)


def gemini_client(result: Any) -> tuple[GeminiStructuredClient, _GeminiClient]:
    stub = _GeminiClient(result)
    return GeminiStructuredClient(client=stub, model="gemini-test"), stub


class TestGeminiAdapter:
    def test_it_returns_the_parsed_object(self) -> None:
        client, stub = gemini_client(_GeminiResponse(parsed=Answer(value="확인")))

        assert call(client).value == "확인"
        config = stub.models.calls[0]["config"]
        assert config["response_mime_type"] == "application/json"
        assert config["max_output_tokens"] == 100
        assert config["http_options"] == {"timeout": 5_000}

    def test_it_reports_its_provider_and_model(self) -> None:
        client, _ = gemini_client(_GeminiResponse(parsed=Answer(value="확인")))

        assert client.provider is LlmProvider.GEMINI
        assert client.model == "gemini-test"

    def test_it_validates_json_text_when_the_sdk_returns_none(self) -> None:
        client, _ = gemini_client(_GeminiResponse(text='{"value":"확인"}'))

        assert call(client).value == "확인"

    def test_malformed_json_text_is_invalid(self) -> None:
        client, _ = gemini_client(_GeminiResponse(text='{"value":1}'))

        with pytest.raises(GenerationInvalidError):
            call(client)

    def test_missing_output_is_invalid(self) -> None:
        client, _ = gemini_client(_GeminiResponse(text="   "))

        with pytest.raises(GenerationInvalidError):
            call(client)

    def test_a_blocked_prompt_is_refused(self) -> None:
        client, _ = gemini_client(_GeminiResponse(block_reason="SAFETY"))

        with pytest.raises(GenerationRefusedError):
            call(client)

    def test_a_blocked_finish_reason_is_refused(self) -> None:
        client, _ = gemini_client(_GeminiResponse(finish_reason="PROHIBITED_CONTENT"))

        with pytest.raises(GenerationRefusedError):
            call(client)

    def test_a_truncated_finish_reason_is_invalid(self) -> None:
        client, _ = gemini_client(_GeminiResponse(finish_reason="MAX_TOKENS"))

        with pytest.raises(GenerationInvalidError):
            call(client)

    def test_a_timeout_is_indeterminate(self) -> None:
        client, _ = gemini_client(type("DeadlineExceededError", (Exception,), {})())

        with pytest.raises(GenerationIndeterminateError):
            call(client)

    def test_a_connection_failure_is_indeterminate(self) -> None:
        client, _ = gemini_client(type("ConnectionError", (Exception,), {})())

        with pytest.raises(GenerationIndeterminateError):
            call(client)

    def test_rate_limiting_keeps_the_retry_delay(self) -> None:
        client, _ = gemini_client(_GeminiError(429, {"retry-after": "3"}))

        with pytest.raises(GenerationRateLimitedError) as error:
            call(client)
        assert error.value.retry_after == 3

    @pytest.mark.parametrize("status", [408, 409, 500, 503])
    def test_unknown_outcomes_are_indeterminate(self, status: int) -> None:
        client, _ = gemini_client(_GeminiError(status))

        with pytest.raises(GenerationIndeterminateError):
            call(client)

    @pytest.mark.parametrize("status", [400, 403])
    def test_definite_rejections_are_safe_to_retry(self, status: int) -> None:
        client, _ = gemini_client(_GeminiError(status))

        with pytest.raises(GenerationUnavailableError) as error:
            call(client)
        assert isinstance(error.value, GenerationNotStartedError)

    def test_an_unclassified_error_is_indeterminate(self) -> None:
        client, _ = gemini_client(RuntimeError("무엇인가 실패"))

        with pytest.raises(GenerationIndeterminateError):
            call(client)

    def test_closing_leaves_an_injected_client_alone(self) -> None:
        client, stub = gemini_client(_GeminiResponse(parsed=Answer(value="확인")))

        client.close()

        assert stub.closed is False

    def test_a_key_is_required_without_a_client(self) -> None:
        with pytest.raises(ValueError, match="api_key"):
            GeminiStructuredClient(api_key="")


TOOL_RESULT = {
    "id": "msg_test",
    "type": "message",
    "role": "assistant",
    "model": "claude-test",
    "content": [
        {"type": "text", "text": "결과를 도구로 전달합니다."},
        {"type": "tool_use", "id": "tu_1", "name": TOOL_NAME, "input": {"value": "확인"}},
    ],
    "stop_reason": "tool_use",
    "stop_sequence": None,
    "usage": {"input_tokens": 10, "output_tokens": 5},
}


def anthropic_message(**overrides: Any) -> dict[str, Any]:
    return {**TOOL_RESULT, **overrides}


def anthropic_client(
    handler: Callable[[httpx.Request], httpx.Response],
) -> AnthropicStructuredClient:
    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    return AnthropicStructuredClient(
        client=Anthropic(api_key="test", max_retries=0, http_client=http_client),
        model="claude-test",
    )


def anthropic_returning(payload: dict[str, Any]) -> AnthropicStructuredClient:
    return anthropic_client(lambda _request: httpx.Response(200, json=payload))


def anthropic_failing(status: int, headers: dict[str, str] | None = None):
    return anthropic_client(
        lambda _request: httpx.Response(status, headers=headers or {}, json={"error": {}})
    )


class TestAnthropicAdapter:
    def test_it_returns_the_tool_input(self) -> None:
        captured: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            return httpx.Response(200, json=TOOL_RESULT)

        assert call(anthropic_client(handler)).value == "확인"
        assert captured["tool_choice"] == {"type": "tool", "name": TOOL_NAME}
        assert captured["max_tokens"] == 100
        assert captured["tools"][0]["name"] == TOOL_NAME
        assert captured["system"] == "지시"

    def test_it_reports_its_provider_and_model(self) -> None:
        client = anthropic_returning(TOOL_RESULT)

        assert client.provider is LlmProvider.ANTHROPIC
        assert client.model == "claude-test"

    def test_a_missing_tool_call_is_invalid(self) -> None:
        client = anthropic_returning(
            anthropic_message(content=[{"type": "text", "text": "설명만 반환"}])
        )

        with pytest.raises(GenerationInvalidError):
            call(client)

    def test_another_tool_name_is_ignored(self) -> None:
        client = anthropic_returning(
            anthropic_message(
                content=[
                    {"type": "tool_use", "id": "tu_2", "name": "other", "input": {"value": "확인"}}
                ]
            )
        )

        with pytest.raises(GenerationInvalidError):
            call(client)

    def test_a_schema_violation_is_invalid(self) -> None:
        client = anthropic_returning(
            anthropic_message(
                content=[
                    {"type": "tool_use", "id": "tu_3", "name": TOOL_NAME, "input": {"value": 1}}
                ]
            )
        )

        with pytest.raises(GenerationInvalidError):
            call(client)

    def test_a_refusal_stop_reason_is_refused(self) -> None:
        client = anthropic_returning(anthropic_message(stop_reason="refusal", content=[]))

        with pytest.raises(GenerationRefusedError):
            call(client)

    def test_a_truncated_message_is_invalid(self) -> None:
        client = anthropic_returning(anthropic_message(stop_reason="max_tokens", content=[]))

        with pytest.raises(GenerationInvalidError):
            call(client)

    def test_a_timeout_is_indeterminate(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.TimeoutException("timeout")

        with pytest.raises(GenerationIndeterminateError):
            call(anthropic_client(handler))

    def test_rate_limiting_keeps_the_retry_delay(self) -> None:
        with pytest.raises(GenerationRateLimitedError) as error:
            call(anthropic_failing(429, {"retry-after": "11"}))

        assert error.value.retry_after == 11
        assert isinstance(error.value, GenerationNotStartedError)

    def test_a_connection_failure_is_indeterminate(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        with pytest.raises(GenerationIndeterminateError):
            call(anthropic_client(handler))

    @pytest.mark.parametrize("status", [408, 409, 500, 529])
    def test_unknown_outcomes_are_indeterminate(self, status: int) -> None:
        with pytest.raises(GenerationIndeterminateError):
            call(anthropic_failing(status))

    @pytest.mark.parametrize("status", [400, 401, 403])
    def test_definite_rejections_are_safe_to_retry(self, status: int) -> None:
        with pytest.raises(GenerationUnavailableError) as error:
            call(anthropic_failing(status))

        assert isinstance(error.value, GenerationNotStartedError)

    def test_an_injected_client_must_not_retry(self) -> None:
        http_client = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
        with pytest.raises(ValueError, match="max_retries=0"):
            AnthropicStructuredClient(
                client=Anthropic(api_key="test", max_retries=3, http_client=http_client)
            )

    def test_a_key_is_required_without_a_client(self) -> None:
        with pytest.raises(ValueError, match="api_key"):
            AnthropicStructuredClient(api_key="   ")
