"""Resolve which providers this process can call.

Credentials live only in the process environment. The registry reports whether a provider is
configured and builds clients on demand; it never returns or logs a key.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping

from naver_blog_assistant.application import GenerationUnavailableError
from naver_blog_assistant.domain.llm import (
    DEFAULT_MODELS,
    LlmProvider,
    ModelSelection,
    ProviderAvailability,
)
from naver_blog_assistant.ports.llm import StructuredCompletion

ClientFactory = Callable[[str, str], StructuredCompletion]


class ProviderRegistry:
    """Own the configured credentials and hand out one client per selection."""

    def __init__(
        self,
        *,
        api_keys: Mapping[LlmProvider, str],
        models: Mapping[LlmProvider, str] | None = None,
        factories: Mapping[LlmProvider, ClientFactory] | None = None,
    ) -> None:
        self._api_keys = {
            provider: key.strip() for provider, key in api_keys.items() if key.strip()
        }
        self._models = {**DEFAULT_MODELS, **dict(models or {})}
        self._factories = dict(factories or _default_factories())
        self._clients: dict[str, StructuredCompletion] = {}

    def availability(self) -> list[ProviderAvailability]:
        """Report every provider and whether it can be called, without any key material."""
        return [
            ProviderAvailability(
                provider=provider,
                configured=provider in self._api_keys,
                model=self._models[provider],
            )
            for provider in LlmProvider
        ]

    def configured(self) -> list[LlmProvider]:
        """Return the providers that have a usable key, in declaration order."""
        return [provider for provider in LlmProvider if provider in self._api_keys]

    def model_for(self, provider: LlmProvider) -> str:
        """Return the configured model name for `provider`."""
        return self._models[provider]

    def selection(self, provider: LlmProvider, model: str | None = None) -> ModelSelection:
        """Return the selection for `provider`, defaulting to its configured model."""
        return ModelSelection(provider=provider, model=model or self._models[provider])

    def client(self, selection: ModelSelection) -> StructuredCompletion:
        """Return a cached client for `selection`, refusing an unconfigured provider."""
        key = self._api_keys.get(selection.provider)
        if key is None:
            raise GenerationUnavailableError(
                f"{selection.provider.value} is not configured in this process"
            )
        cached = self._clients.get(selection.key)
        if cached is not None:
            return cached
        factory = self._factories.get(selection.provider)
        if factory is None:  # pragma: no cover - every provider has a factory
            raise GenerationUnavailableError(f"{selection.provider.value} has no client factory")
        client = factory(key, selection.model)
        self._clients[selection.key] = client
        return client

    def close(self) -> None:
        """Release every client this registry created."""
        for client in self._clients.values():
            client.close()
        self._clients.clear()


def _default_factories() -> dict[LlmProvider, ClientFactory]:
    return {
        LlmProvider.OPENAI: _openai,
        LlmProvider.GEMINI: _gemini,
        LlmProvider.ANTHROPIC: _anthropic,
    }


def _openai(api_key: str, model: str) -> StructuredCompletion:
    from naver_blog_assistant.infrastructure.llm.openai_client import (  # noqa: PLC0415
        OpenAIStructuredClient,
    )

    return OpenAIStructuredClient(api_key=api_key, model=model)


def _gemini(api_key: str, model: str) -> StructuredCompletion:
    from naver_blog_assistant.infrastructure.llm.gemini_client import (  # noqa: PLC0415
        GeminiStructuredClient,
    )

    return GeminiStructuredClient(api_key=api_key, model=model)


def _anthropic(api_key: str, model: str) -> StructuredCompletion:
    from naver_blog_assistant.infrastructure.llm.anthropic_client import (  # noqa: PLC0415
        AnthropicStructuredClient,
    )

    return AnthropicStructuredClient(api_key=api_key, model=model)
