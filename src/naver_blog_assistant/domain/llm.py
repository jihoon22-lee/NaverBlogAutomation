"""Provider-neutral generation vocabulary.

The application never names a vendor: it names a provider and a model. Which providers are usable
depends on configuration, so a selection is validated here rather than trusted from transport.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from naver_blog_assistant.domain.models import DomainValidationError

MAX_MODEL_NAME_LENGTH = 100


class LlmProvider(StrEnum):
    """Generation providers this build can call."""

    OPENAI = "openai"
    GEMINI = "gemini"
    ANTHROPIC = "anthropic"


class LlmCallStatus(StrEnum):
    """Terminal status of one provider attempt."""

    SUCCEEDED = "succeeded"
    FAILED = "failed"
    INDETERMINATE = "indeterminate"


@dataclass(frozen=True, slots=True)
class ModelSelection:
    """One provider and the model name to call on it."""

    provider: LlmProvider
    model: str

    def __post_init__(self) -> None:
        if not isinstance(self.provider, LlmProvider):
            raise DomainValidationError("provider must be an LlmProvider")
        normalized = self.model.strip()
        if not normalized:
            raise DomainValidationError("model must not be empty")
        if len(normalized) > MAX_MODEL_NAME_LENGTH:
            raise DomainValidationError(f"model must not exceed {MAX_MODEL_NAME_LENGTH} characters")
        if normalized != self.model:
            raise DomainValidationError("model must not have surrounding whitespace")

    @property
    def key(self) -> str:
        """Return the stable identifier used in idempotency keys and records."""
        return f"{self.provider.value}:{self.model}"


@dataclass(frozen=True, slots=True)
class ProviderAvailability:
    """Whether one provider can be called, without exposing any credential."""

    provider: LlmProvider
    configured: bool
    model: str

    def __post_init__(self) -> None:
        if not isinstance(self.provider, LlmProvider):
            raise DomainValidationError("provider must be an LlmProvider")
        if not isinstance(self.configured, bool):
            raise DomainValidationError("configured must be a boolean")


DEFAULT_MODELS: dict[LlmProvider, str] = {
    LlmProvider.OPENAI: "gpt-5.6-terra",
    LlmProvider.GEMINI: "gemini-3.6-flash",
    LlmProvider.ANTHROPIC: "claude-sonnet-5-20260514",
}
