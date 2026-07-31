"""Deterministic structured completion for development and tests."""

from __future__ import annotations

from collections.abc import Callable
from typing import cast

from pydantic import BaseModel

from naver_blog_assistant.domain.llm import LlmProvider
from naver_blog_assistant.ports.llm import SchemaT


class FakeStructuredClient:
    """Return scripted payloads or raise scripted errors without any network call."""

    def __init__(
        self,
        *,
        provider: LlmProvider = LlmProvider.OPENAI,
        model: str = "deterministic-fake",
        payloads: list[dict[str, object]] | None = None,
        error: Exception | None = None,
        build: Callable[[type[BaseModel]], BaseModel] | None = None,
    ) -> None:
        self._provider = provider
        self._model = model
        self._payloads = list(payloads or [])
        self._error = error
        self._build = build
        self.calls: list[tuple[str, str, float, int]] = []
        self.closed = False

    @property
    def provider(self) -> LlmProvider:
        return self._provider

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
        """Answer the next scripted result for `schema`."""
        self.calls.append((instructions, input_text, timeout_seconds, max_output_tokens))
        if self._error is not None:
            raise self._error
        if self._build is not None:
            return cast(SchemaT, self._build(schema))
        if not self._payloads:
            raise AssertionError("no scripted payload remains for the fake client")
        return schema.model_validate(self._payloads.pop(0))

    def close(self) -> None:
        self.closed = True
