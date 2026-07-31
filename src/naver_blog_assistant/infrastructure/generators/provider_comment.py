"""Comment generation over any structured completion provider.

The prompt, the schema, and the mapping from candidates to domain tones live here, so adding a
provider only means adding a client. The article body and style examples never leave this call.
"""

from __future__ import annotations

import json

from naver_blog_assistant.domain import (
    CandidateTone,
    CapturedPost,
    GeneratedComment,
    GenerationOutput,
    GenerationPreferences,
)
from naver_blog_assistant.domain.llm import LlmProvider
from naver_blog_assistant.infrastructure.generators.comment_prompt import (
    STRUCTURED_FORMATS,
    comment_instructions,
)
from naver_blog_assistant.ports.llm import StructuredCompletion


class ProviderCommentGenerator:
    """Generate three grounded candidates with exactly one provider attempt."""

    def __init__(
        self,
        client: StructuredCompletion,
        *,
        timeout_seconds: float = 35.0,
        max_output_tokens: int = 3_000,
    ) -> None:
        if timeout_seconds <= 0 or max_output_tokens < 1:
            raise ValueError("provider timeout and output token limit must be positive")
        self._client = client
        self._timeout_seconds = timeout_seconds
        self._max_output_tokens = max_output_tokens

    @property
    def provider(self) -> LlmProvider:
        return self._client.provider

    @property
    def model(self) -> str:
        return self._client.model

    def generate(self, post: CapturedPost, preferences: GenerationPreferences) -> GenerationOutput:
        """Generate candidates without provider style examples."""
        return self.generate_with_style(post, preferences, ())

    def generate_with_style(
        self,
        post: CapturedPost,
        preferences: GenerationPreferences,
        style_examples: tuple[str, ...],
    ) -> GenerationOutput:
        """Generate candidates without sending the source URL or retaining article data."""
        parsed = self._client.structured(
            instructions=comment_instructions(preferences),
            input_text=_input_text(post, style_examples),
            schema=STRUCTURED_FORMATS[preferences.length],
            timeout_seconds=self._timeout_seconds,
            max_output_tokens=self._max_output_tokens,
        )
        return GenerationOutput(
            summary=parsed.summary,
            topics=tuple(parsed.topics),
            candidates=tuple(
                GeneratedComment(
                    tone=tone,
                    comment=candidate.comment,
                    referenced_detail=candidate.referenced_detail,
                )
                for tone, candidate in (
                    (CandidateTone.WARM, parsed.warm),
                    (CandidateTone.CURIOUS, parsed.curious),
                    (CandidateTone.SUPPORTIVE, parsed.supportive),
                )
            ),
        )

    def close(self) -> None:
        self._client.close()


def _input_text(post: CapturedPost, style_examples: tuple[str, ...]) -> str:
    article_data = json.dumps(
        {"title": post.title, "body": post.body},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    style_data = json.dumps(list(style_examples), ensure_ascii=False, separators=(",", ":"))
    return (
        f"<ARTICLE_DATA>{article_data}</ARTICLE_DATA>\n"
        f"<STYLE_EXAMPLES>{style_data}</STYLE_EXAMPLES>"
    )
