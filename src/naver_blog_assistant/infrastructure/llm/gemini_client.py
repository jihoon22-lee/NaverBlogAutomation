"""Gemini adapter for one structured generation call.

Gemini validates a JSON Schema server-side and the SDK can return a parsed Pydantic object, but a
schema-compliant answer is still untrusted: the adapter validates it again before returning.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ValidationError

from naver_blog_assistant.application import (
    GenerationIndeterminateError,
    GenerationInvalidError,
    GenerationRefusedError,
)
from naver_blog_assistant.domain.llm import LlmProvider
from naver_blog_assistant.infrastructure.llm.errors import (
    ProviderRateLimitError,
    parse_retry_after,
    status_failure,
)
from naver_blog_assistant.ports.llm import SchemaT

BLOCKED_FINISH_REASONS = frozenset({"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"})
INCOMPLETE_FINISH_REASONS = frozenset({"MAX_TOKENS", "RECITATION", "MALFORMED_FUNCTION_CALL"})


class GeminiStructuredClient:
    """Make exactly one non-retried Gemini attempt per call."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        client: Any | None = None,
        model: str = "gemini-3.6-flash",
    ) -> None:
        if client is None and not (api_key or "").strip():
            raise ValueError("api_key is required when no Gemini client is supplied")
        self._client = client if client is not None else _build_client(api_key or "")
        self._owns_client = client is None
        self._model = model

    @property
    def provider(self) -> LlmProvider:
        return LlmProvider.GEMINI

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
        """Return one validated object from `generate_content`."""
        try:
            response = self._client.models.generate_content(
                model=self._model,
                contents=input_text,
                config={
                    "system_instruction": instructions,
                    "response_mime_type": "application/json",
                    "response_schema": schema,
                    "max_output_tokens": max_output_tokens,
                    "http_options": {"timeout": int(timeout_seconds * 1_000)},
                },
            )
        except Exception as error:  # noqa: BLE001 - SDK exception types vary by failure
            raise _mapped(error) from error

        feedback = getattr(response, "prompt_feedback", None)
        if getattr(feedback, "block_reason", None) is not None:
            raise GenerationRefusedError("provider refused generation")
        reason = _finish_reason(response)
        if reason in BLOCKED_FINISH_REASONS:
            raise GenerationRefusedError("provider content filter refused generation")
        if reason in INCOMPLETE_FINISH_REASONS:
            raise GenerationInvalidError("provider output was incomplete")
        parsed = getattr(response, "parsed", None)
        if isinstance(parsed, schema):
            return parsed
        text = getattr(response, "text", None)
        if not isinstance(text, str) or not text.strip():
            raise GenerationInvalidError("provider returned no structured output")
        try:
            return schema.model_validate_json(text)
        except ValidationError as error:
            raise GenerationInvalidError("structured output validation failed") from error

    def close(self) -> None:
        if self._owns_client:
            close = getattr(self._client, "close", None)
            if callable(close):
                close()


def _build_client(api_key: str) -> Any:
    from google import genai  # noqa: PLC0415 - imported lazily so tests need no credentials

    return genai.Client(api_key=api_key)


def _finish_reason(response: object) -> str | None:
    candidates = getattr(response, "candidates", None)
    if not candidates:
        return None
    reason = getattr(candidates[0], "finish_reason", None)
    if reason is None:
        return None
    return str(getattr(reason, "name", reason))


def _mapped(error: Exception) -> Exception:
    """Map one SDK exception onto the shared vocabulary."""
    if isinstance(error, BaseModel):  # pragma: no cover - defensive, never a model
        return GenerationInvalidError("provider returned an unexpected object")
    name = type(error).__name__
    if "Timeout" in name or "DeadlineExceeded" in name:
        return GenerationIndeterminateError("provider timeout")
    if "Connection" in name:
        return GenerationIndeterminateError("provider connection failed")
    status = _status_of(error)
    if status == 429:
        return ProviderRateLimitError(parse_retry_after(_retry_after_of(error)))
    if status is not None:
        return status_failure(status, provider="provider")
    return GenerationIndeterminateError("provider outcome is indeterminate")


def _status_of(error: Exception) -> int | None:
    for attribute in ("code", "status_code"):
        value = getattr(error, attribute, None)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) and not isinstance(status, bool) else None


def _retry_after_of(error: Exception) -> object:
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    getter = getattr(headers, "get", None)
    return getter("retry-after") if callable(getter) else None
