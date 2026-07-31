"""OpenAI comment generator.

The prompt, the schema, and the candidate mapping moved to provider-neutral modules. This class
stays as the configured entry point for the OpenAI provider and keeps its previous behavior:
exactly one attempt per call, no automatic retry, and no article data left behind.
"""

from __future__ import annotations

from typing import Literal

from openai import OpenAI

from naver_blog_assistant.domain import CapturedPost, GenerationOutput, GenerationPreferences
from naver_blog_assistant.infrastructure.generators.provider_comment import (
    ProviderCommentGenerator,
)
from naver_blog_assistant.infrastructure.llm.openai_client import OpenAIStructuredClient


class OpenAICommentGenerator:
    """Make exactly one non-retried provider attempt per ``generate`` call."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        client: OpenAI | None = None,
        model: str = "gpt-5.6-terra",
        reasoning_effort: Literal["low", "medium", "high"] = "low",
        timeout_seconds: float = 35.0,
        max_output_tokens: int = 3_000,
    ) -> None:
        self._generator = ProviderCommentGenerator(
            OpenAIStructuredClient(
                api_key=api_key,
                client=client,
                model=model,
                reasoning_effort=reasoning_effort,
            ),
            timeout_seconds=timeout_seconds,
            max_output_tokens=max_output_tokens,
        )

    def generate(self, post: CapturedPost, preferences: GenerationPreferences) -> GenerationOutput:
        """Generate candidates without provider style examples."""
        return self._generator.generate(post, preferences)

    def generate_with_style(
        self,
        post: CapturedPost,
        preferences: GenerationPreferences,
        style_examples: tuple[str, ...],
    ) -> GenerationOutput:
        """Generate candidates without sending the source URL or retaining article data."""
        return self._generator.generate_with_style(post, preferences, style_examples)

    def close(self) -> None:
        self._generator.close()
