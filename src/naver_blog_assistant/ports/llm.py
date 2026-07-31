"""Port for one structured generation call against any provider.

Every adapter makes exactly one attempt and maps its own SDK exceptions to the same application
errors, so the caller can treat providers interchangeably: an indeterminate outcome is never retried
automatically and a definite pre-generation rejection stays safe to retry with the same key.
"""

from __future__ import annotations

from typing import Protocol, TypeVar

from pydantic import BaseModel

from naver_blog_assistant.domain.llm import LlmProvider

SchemaT = TypeVar("SchemaT", bound=BaseModel)


class StructuredCompletion(Protocol):
    """Generate one schema-validated object from trusted instructions and untrusted input."""

    @property
    def provider(self) -> LlmProvider:
        """Return the provider this client calls."""
        ...

    @property
    def model(self) -> str:
        """Return the model name this client calls."""
        ...

    def structured(
        self,
        *,
        instructions: str,
        input_text: str,
        schema: type[SchemaT],
        timeout_seconds: float,
        max_output_tokens: int,
    ) -> SchemaT:
        """Return one validated object, raising an application error on any failure."""
        ...

    def close(self) -> None:
        """Release any owned transport resources."""
        ...
