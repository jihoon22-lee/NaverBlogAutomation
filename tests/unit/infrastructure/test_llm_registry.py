"""Provider selection, registry behavior, and provider-neutral comment generation."""

from __future__ import annotations

from typing import cast

import pytest

from naver_blog_assistant.application import GenerationUnavailableError
from naver_blog_assistant.domain import (
    DEFAULT_GENERATION_PREFERENCES,
    AppSettingKind,
    CapturedPost,
    DomainValidationError,
    LlmProvider,
    ModelSelection,
    normalize_setting_payload,
)
from naver_blog_assistant.infrastructure.generators.comment_prompt import (
    STRUCTURED_FORMATS,
    comment_instructions,
)
from naver_blog_assistant.infrastructure.generators.provider_comment import (
    ProviderCommentGenerator,
)
from naver_blog_assistant.infrastructure.llm import FakeStructuredClient, ProviderRegistry

POST = CapturedPost(
    source_url="https://blog.naver.com/example/223456789012",
    title="합성 전시 후기",
    body="전시에서 인상 깊었던 작품과 관람 동선을 정리한 합성 본문입니다." * 3,
)


def candidate(text: str) -> dict[str, str]:
    return {"comment": text, "referenced_detail": "본문 근거"}


def payload() -> dict[str, object]:
    medium = "가" * 120
    return {
        "summary": "합성 요약",
        "topics": ["전시"],
        "warm": candidate(medium),
        "curious": candidate(f"{'가' * 119}?"),
        "supportive": candidate(medium),
    }


class TestModelSelection:
    def test_it_builds_a_stable_key(self) -> None:
        selection = ModelSelection(provider=LlmProvider.GEMINI, model="gemini-test")

        assert selection.key == "gemini:gemini-test"

    @pytest.mark.parametrize("model", ["", "   ", " padded", "padded "])
    def test_it_rejects_an_unusable_model_name(self, model: str) -> None:
        with pytest.raises(DomainValidationError):
            ModelSelection(provider=LlmProvider.OPENAI, model=model)

    def test_it_rejects_an_over_long_model_name(self) -> None:
        with pytest.raises(DomainValidationError, match="100"):
            ModelSelection(provider=LlmProvider.OPENAI, model="m" * 101)

    def test_it_requires_a_known_provider(self) -> None:
        with pytest.raises(DomainValidationError, match="LlmProvider"):
            ModelSelection(provider=cast(LlmProvider, "openai"), model="gpt")


class TestProviderSettings:
    def test_the_default_lists_every_provider(self) -> None:
        stored = normalize_setting_payload(
            AppSettingKind.LLM_PROVIDERS,
            {
                "default_provider": "openai",
                "models": {"openai": "gpt-test", "gemini": "g", "anthropic": "c"},
            },
        )

        assert stored["default_provider"] == "openai"
        assert list(stored["models"]) == ["anthropic", "gemini", "openai"]

    def test_it_trims_a_model_name(self) -> None:
        stored = normalize_setting_payload(
            AppSettingKind.LLM_PROVIDERS,
            {"default_provider": "gemini", "models": {"gemini": "  gemini-test  "}},
        )

        assert stored["models"] == {"gemini": "gemini-test"}

    @pytest.mark.parametrize(
        "value",
        [
            {"default_provider": "mistral", "models": {"openai": "gpt"}},
            {"default_provider": "openai", "models": {"mistral": "m"}},
            {"default_provider": "openai", "models": {}},
            {"default_provider": "openai", "models": "gpt"},
            {"default_provider": "openai", "models": {"openai": 1}},
            {"default_provider": "gemini", "models": {"openai": "gpt"}},
            {"models": {"openai": "gpt"}},
            {"default_provider": "openai", "models": {"openai": "gpt"}, "extra": True},
        ],
    )
    def test_it_rejects_a_malformed_payload(self, value: dict[str, object]) -> None:
        with pytest.raises(DomainValidationError):
            normalize_setting_payload(AppSettingKind.LLM_PROVIDERS, value)


class TestProviderRegistry:
    def test_it_reports_configuration_without_any_key(self) -> None:
        registry = ProviderRegistry(api_keys={LlmProvider.OPENAI: "secret"})

        availability = registry.availability()

        assert [entry.provider for entry in availability] == list(LlmProvider)
        assert [entry.configured for entry in availability] == [True, False, False]
        assert all("secret" not in entry.model for entry in availability)

    def test_a_blank_key_is_not_configured(self) -> None:
        registry = ProviderRegistry(api_keys={LlmProvider.GEMINI: "   "})

        assert registry.configured() == []

    def test_it_keeps_the_configured_order(self) -> None:
        registry = ProviderRegistry(api_keys={LlmProvider.ANTHROPIC: "a", LlmProvider.OPENAI: "b"})

        assert registry.configured() == [LlmProvider.OPENAI, LlmProvider.ANTHROPIC]

    def test_it_uses_the_configured_model_by_default(self) -> None:
        registry = ProviderRegistry(
            api_keys={LlmProvider.OPENAI: "b"}, models={LlmProvider.OPENAI: "gpt-custom"}
        )

        assert registry.selection(LlmProvider.OPENAI).model == "gpt-custom"
        assert registry.model_for(LlmProvider.OPENAI) == "gpt-custom"
        assert registry.selection(LlmProvider.OPENAI, "gpt-other").model == "gpt-other"

    def test_it_caches_one_client_per_selection(self) -> None:
        built: list[str] = []

        def factory(_key: str, model: str) -> FakeStructuredClient:
            built.append(model)
            return FakeStructuredClient(model=model)

        registry = ProviderRegistry(
            api_keys={LlmProvider.OPENAI: "b"},
            factories={LlmProvider.OPENAI: factory},
        )
        selection = registry.selection(LlmProvider.OPENAI)

        first = registry.client(selection)
        second = registry.client(selection)

        assert first is second
        assert built == [registry.model_for(LlmProvider.OPENAI)]

    def test_an_unconfigured_provider_is_refused(self) -> None:
        registry = ProviderRegistry(api_keys={})

        with pytest.raises(GenerationUnavailableError, match="not configured"):
            registry.client(registry.selection(LlmProvider.ANTHROPIC))

    def test_closing_releases_every_client(self) -> None:
        clients: list[FakeStructuredClient] = []

        def factory(_key: str, model: str) -> FakeStructuredClient:
            client = FakeStructuredClient(model=model)
            clients.append(client)
            return client

        registry = ProviderRegistry(
            api_keys={LlmProvider.OPENAI: "b"},
            factories={LlmProvider.OPENAI: factory},
        )
        registry.client(registry.selection(LlmProvider.OPENAI))

        registry.close()

        assert [client.closed for client in clients] == [True]


class TestProviderCommentGenerator:
    def test_it_maps_candidates_to_the_documented_tones(self) -> None:
        client = FakeStructuredClient(payloads=[payload()])
        generator = ProviderCommentGenerator(client)

        output = generator.generate(POST, DEFAULT_GENERATION_PREFERENCES)

        assert [candidate.tone.value for candidate in output.candidates] == [
            "warm",
            "curious",
            "supportive",
        ]
        assert output.summary == "합성 요약"
        assert output.topics == ("전시",)

    def test_it_sends_the_article_as_untrusted_data_without_the_url(self) -> None:
        client = FakeStructuredClient(payloads=[payload()])

        ProviderCommentGenerator(client).generate_with_style(
            POST, DEFAULT_GENERATION_PREFERENCES, ("예시 문장",)
        )

        instructions, input_text, timeout, tokens = client.calls[0]
        assert "<ARTICLE_DATA>" in input_text
        assert "예시 문장" in input_text
        assert POST.source_url not in input_text
        assert "신뢰할 수 없는" in instructions
        assert timeout == 35.0
        assert tokens == 3_000

    def test_it_uses_the_length_specific_schema(self) -> None:
        client = FakeStructuredClient(
            build=lambda schema: (
                schema.model_validate(payload())
                if schema is STRUCTURED_FORMATS[DEFAULT_GENERATION_PREFERENCES.length]
                else pytest.fail("unexpected schema")
            )
        )

        ProviderCommentGenerator(client).generate(POST, DEFAULT_GENERATION_PREFERENCES)

    def test_it_exposes_the_provider_and_model(self) -> None:
        generator = ProviderCommentGenerator(
            FakeStructuredClient(provider=LlmProvider.ANTHROPIC, model="claude-test")
        )

        assert generator.provider is LlmProvider.ANTHROPIC
        assert generator.model == "claude-test"

    def test_it_propagates_a_provider_failure_unchanged(self) -> None:
        client = FakeStructuredClient(error=GenerationUnavailableError("down"))

        with pytest.raises(GenerationUnavailableError):
            ProviderCommentGenerator(client).generate(POST, DEFAULT_GENERATION_PREFERENCES)

    @pytest.mark.parametrize(("timeout", "tokens"), [(0.0, 10), (-1.0, 10), (5.0, 0)])
    def test_it_rejects_unusable_limits(self, timeout: float, tokens: int) -> None:
        with pytest.raises(ValueError, match="positive"):
            ProviderCommentGenerator(
                FakeStructuredClient(), timeout_seconds=timeout, max_output_tokens=tokens
            )

    def test_closing_closes_the_client(self) -> None:
        client = FakeStructuredClient()

        ProviderCommentGenerator(client).close()

        assert client.closed is True

    def test_the_instructions_state_the_selected_options(self) -> None:
        text = comment_instructions(DEFAULT_GENERATION_PREFERENCES)

        assert "GENERATION_CONFIG" in text
        assert DEFAULT_GENERATION_PREFERENCES.speech.value in text
