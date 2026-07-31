"""Anthropic adapter for one structured generation call.

Claude returns structured data through a forced tool call, so the adapter validates the tool input
with the same Pydantic schema every other provider uses.
"""

from __future__ import annotations

from typing import Any

from anthropic import (
    Anthropic,
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    RateLimitError,
)
from pydantic import ValidationError

from naver_blog_assistant.application import (
    GenerationIndeterminateError,
    GenerationInvalidError,
    GenerationRefusedError,
)
from naver_blog_assistant.domain.llm import LlmProvider
from naver_blog_assistant.infrastructure.llm.errors import (
    ProviderRateLimitError,
    ProviderRejectedError,
    parse_retry_after,
)
from naver_blog_assistant.ports.llm import SchemaT

TOOL_NAME = "emit_result"


class AnthropicStructuredClient:
    """Make exactly one non-retried Anthropic attempt per call."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        client: Anthropic | None = None,
        model: str = "claude-sonnet-5-20260514",
    ) -> None:
        if client is None and not (api_key or "").strip():
            raise ValueError("api_key is required when no Anthropic client is supplied")
        if client is not None and getattr(client, "max_retries", 0) != 0:
            raise ValueError("injected Anthropic client must configure max_retries=0")
        self._client = client or Anthropic(api_key=api_key, max_retries=0)
        self._owns_client = client is None
        self._model = model

    @property
    def provider(self) -> LlmProvider:
        return LlmProvider.ANTHROPIC

    @property
    def model(self) -> str:
        return self._model

    def structured(
        self,
        *,
        instructions: str,
        input_text: str,
        schema: type[SchemaT],
        timeout_seconds: float,
        max_output_tokens: int,
    ) -> SchemaT:
        """Return one validated object from a forced tool call."""
        try:
            message = self._client.messages.create(
                model=self._model,
                system=instructions,
                messages=[{"role": "user", "content": input_text}],
                max_tokens=max_output_tokens,
                tools=[
                    {
                        "name": TOOL_NAME,
                        "description": "Return the requested result.",
                        "input_schema": schema.model_json_schema(),
                    }
                ],
                tool_choice={"type": "tool", "name": TOOL_NAME},
                timeout=timeout_seconds,
            )
        except APITimeoutError as error:
            raise GenerationIndeterminateError("provider timeout") from error
        except RateLimitError as error:
            raise ProviderRateLimitError(_retry_after(error)) from error
        except APIConnectionError as error:
            raise GenerationIndeterminateError("provider connection failed") from error
        except APIStatusError as error:
            if error.status_code in {408, 409} or error.status_code >= 500:
                raise GenerationIndeterminateError("provider outcome is indeterminate") from error
            raise ProviderRejectedError("provider rejected request before generation") from error

        reason = getattr(message, "stop_reason", None)
        if reason == "refusal":
            raise GenerationRefusedError("provider refused generation")
        if reason == "max_tokens":
            raise GenerationInvalidError("provider output was incomplete")
        payload = _tool_input(message)
        if payload is None:
            raise GenerationInvalidError("provider returned no structured output")
        try:
            return schema.model_validate(payload)
        except ValidationError as error:
            raise GenerationInvalidError("structured output validation failed") from error

    def close(self) -> None:
        if self._owns_client:
            self._client.close()


def _tool_input(message: object) -> dict[str, Any] | None:
    for block in getattr(message, "content", ()):
        if getattr(block, "type", None) != "tool_use":
            continue
        if getattr(block, "name", None) != TOOL_NAME:
            continue
        payload = getattr(block, "input", None)
        if isinstance(payload, dict):
            return payload
    return None


def _retry_after(error: RateLimitError) -> int | None:
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    getter = getattr(headers, "get", None)
    return parse_retry_after(getter("retry-after")) if callable(getter) else None
