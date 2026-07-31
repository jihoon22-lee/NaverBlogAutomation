"""OpenAI Responses adapter for one structured generation call."""

from __future__ import annotations

from typing import Literal

from openai import (
    APIConnectionError,
    APIResponseValidationError,
    APIStatusError,
    APITimeoutError,
    OpenAI,
    RateLimitError,
)
from pydantic import BaseModel, ValidationError

from naver_blog_assistant.application import (
    GenerationIndeterminateError,
    GenerationInvalidError,
    GenerationRefusedError,
    GenerationUnavailableError,
)
from naver_blog_assistant.domain.llm import LlmProvider
from naver_blog_assistant.infrastructure.llm.errors import (
    ProviderRateLimitError,
    ProviderRejectedError,
    parse_retry_after,
)
from naver_blog_assistant.ports.llm import SchemaT


class OpenAIStructuredClient:
    """Make exactly one non-retried OpenAI attempt per call."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        client: OpenAI | None = None,
        model: str = "gpt-5.6-terra",
        reasoning_effort: Literal["low", "medium", "high"] = "low",
    ) -> None:
        if client is None and not (api_key or "").strip():
            raise ValueError("api_key is required when no OpenAI client is supplied")
        if client is not None and client.max_retries != 0:
            raise ValueError("injected OpenAI client must configure max_retries=0")
        self._client = client or OpenAI(api_key=api_key, max_retries=0)
        self._owns_client = client is None
        self._model = model
        self._reasoning_effort = reasoning_effort

    @property
    def provider(self) -> LlmProvider:
        return LlmProvider.OPENAI

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
        """Return one validated object from the Responses API."""
        try:
            response = self._client.responses.parse(
                model=self._model,
                instructions=instructions,
                input=input_text,
                text_format=schema,
                reasoning={"effort": self._reasoning_effort},
                store=False,
                max_output_tokens=max_output_tokens,
                timeout=timeout_seconds,
            )
        except APITimeoutError as error:
            raise GenerationIndeterminateError("provider timeout") from error
        except RateLimitError as error:
            raise ProviderRateLimitError(
                parse_retry_after(error.response.headers.get("retry-after"))
            ) from error
        except APIConnectionError as error:
            raise GenerationIndeterminateError("provider connection failed") from error
        except APIStatusError as error:
            if error.status_code in {408, 409} or error.status_code >= 500:
                raise GenerationIndeterminateError("provider outcome is indeterminate") from error
            raise ProviderRejectedError("provider rejected request before generation") from error
        except APIResponseValidationError as error:
            raise GenerationInvalidError("provider response validation failed") from error
        except ValidationError as error:
            raise GenerationInvalidError("structured output validation failed") from error

        if _contains_refusal(response):
            raise GenerationRefusedError("provider refused generation")
        if response.status == "incomplete":
            reason = getattr(response.incomplete_details, "reason", None)
            if reason == "content_filter":
                raise GenerationRefusedError("provider content filter refused generation")
            raise GenerationInvalidError("provider output was incomplete")
        if response.status != "completed" or response.error is not None:
            raise GenerationUnavailableError("provider did not complete generation")
        parsed = response.output_parsed
        if not isinstance(parsed, schema) or not isinstance(parsed, BaseModel):
            raise GenerationInvalidError("provider returned no structured output")
        return parsed

    def close(self) -> None:
        if self._owns_client:
            self._client.close()


def _contains_refusal(response: object) -> bool:
    for item in getattr(response, "output", ()):
        for content in getattr(item, "content", ()):
            if getattr(content, "type", None) == "refusal":
                return True
    return False
