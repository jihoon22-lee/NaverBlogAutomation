"""Fan-out orchestration and the call budget.

Providers are called through stubs, so every outcome combination is deterministic: partial
failure, total failure, replay, timeout, and each refusal class. The clock is injected so the daily
cap can be checked from midnight without waiting.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest

from naver_blog_assistant.application import (
    GenerationIndeterminateError,
    GenerationInProgressError,
    GenerationInvalidError,
    GenerationRateLimitedError,
    GenerationRefusedError,
    GenerationResult,
    GenerationUnavailableError,
    IdempotencyConflictError,
)
from naver_blog_assistant.application.llm import (
    BudgetExceededError,
    CallBudget,
    FanOutGeneration,
    fanout_key,
)
from naver_blog_assistant.domain import (
    DEFAULT_GENERATION_PREFERENCES,
    AppSettingKind,
    CandidateTone,
    CapturedPost,
    CommentCandidate,
    LlmCallStatus,
    LlmProvider,
    ModelSelection,
    PersonalizationMode,
    Recommendation,
    ReviewStatus,
)

POST = CapturedPost(
    source_url="https://blog.naver.com/example/223456789012",
    title="합성 전시 후기",
    body="전시에서 인상 깊었던 작품과 관람 동선을 정리한 합성 본문입니다." * 3,
)
REQUEST_HASH = "a" * 64
OPENAI = ModelSelection(provider=LlmProvider.OPENAI, model="gpt-test")
GEMINI = ModelSelection(provider=LlmProvider.GEMINI, model="gemini-test")
ANTHROPIC = ModelSelection(provider=LlmProvider.ANTHROPIC, model="claude-test")


def recommendation_for(source_url: str) -> Recommendation:
    """Build one stored recommendation without touching a repository."""
    return Recommendation(
        id=uuid4(),
        source_url=source_url,
        title="합성 전시 후기",
        content_hash="b" * 64,
        excerpt="합성 본문 일부",
        summary="합성 요약",
        topics=("전시",),
        candidates=tuple(
            CommentCandidate(
                id=uuid4(),
                tone=tone,
                comment=f"{tone.value} 댓글",
                referenced_detail="본문 근거",
            )
            for tone in CandidateTone
        ),
        review_status=ReviewStatus.DRAFTED,
        created_at=datetime(2026, 7, 31, 12, 0, tzinfo=UTC),
        preferences=DEFAULT_GENERATION_PREFERENCES,
    )


@dataclass
class _Setting:
    payload: dict[str, Any]


class _Settings:
    def __init__(self, payload: dict[str, Any] | None = None) -> None:
        self.payload = payload or {"daily_call_cap": 10, "per_request_provider_cap": 3}

    def execute(self, kind: AppSettingKind) -> _Setting:
        assert kind is AppSettingKind.LLM_BUDGET
        return _Setting(self.payload)


class _Attempts:
    def __init__(self, used: int = 0) -> None:
        self.used = used
        self.records: list[dict[str, Any]] = []

    def count_since(self, moment: datetime) -> int:
        self.moment = moment
        return self.used

    def record(self, **kwargs: Any) -> None:
        self.records.append(kwargs)


class _Generator:
    """Answer one provider's generation with a scripted result or error."""

    def __init__(self, *, error: BaseException | None = None, replayed: bool = False) -> None:
        self.error = error
        self.replayed = replayed
        self.keys: list[UUID] = []

    def execute(self, **kwargs: Any) -> GenerationResult:
        self.keys.append(kwargs["idempotency_key"])
        if self.error is not None:
            raise self.error
        return GenerationResult(
            recommendation=recommendation_for(POST.source_url), replayed=self.replayed
        )


def budget(settings: _Settings | None = None, attempts: _Attempts | None = None) -> CallBudget:
    return CallBudget(
        read_setting=settings or _Settings(),
        attempts=attempts or _Attempts(),
        clock=lambda: datetime(2026, 7, 31, 12, 0, tzinfo=UTC),
    )


def fanout(
    generators: dict[str, _Generator],
    *,
    attempts: _Attempts | None = None,
    settings: _Settings | None = None,
    timeout_seconds: float = 5.0,
) -> tuple[FanOutGeneration, _Attempts]:
    ledger = attempts or _Attempts()
    return (
        FanOutGeneration(
            generators=generators,
            attempts=ledger,
            budget=budget(settings, ledger),
            timeout_seconds=timeout_seconds,
        ),
        ledger,
    )


def run(generation: FanOutGeneration, selections: list[ModelSelection], attempt: int = 1) -> Any:
    async def scenario() -> Any:
        async with asyncio.timeout(10):
            return await generation.execute(
                post=POST,
                request_hash=REQUEST_HASH,
                attempt=attempt,
                selections=selections,
                preferences=DEFAULT_GENERATION_PREFERENCES,
                personalization_mode=PersonalizationMode.OFF,
            )

    return asyncio.run(scenario())


class TestFanoutKey:
    def test_it_is_stable_for_the_same_selection(self) -> None:
        assert fanout_key(REQUEST_HASH, 1, OPENAI) == fanout_key(REQUEST_HASH, 1, OPENAI)

    def test_it_differs_per_provider_model_and_attempt(self) -> None:
        keys = {
            fanout_key(REQUEST_HASH, 1, OPENAI),
            fanout_key(REQUEST_HASH, 1, GEMINI),
            fanout_key(REQUEST_HASH, 2, OPENAI),
            fanout_key(REQUEST_HASH, 1, ModelSelection(provider=LlmProvider.OPENAI, model="other")),
        }

        assert len(keys) == 4


class TestFanoutExecution:
    def test_every_provider_is_called_once_with_its_own_key(self) -> None:
        generators = {"openai": _Generator(), "gemini": _Generator()}
        generation, ledger = fanout(generators)

        result = run(generation, [OPENAI, GEMINI])

        assert [outcome.selection.provider.value for outcome in result.outcomes] == [
            "openai",
            "gemini",
        ]
        assert generators["openai"].keys == [fanout_key(REQUEST_HASH, 1, OPENAI)]
        assert generators["gemini"].keys == [fanout_key(REQUEST_HASH, 1, GEMINI)]
        assert len(ledger.records) == 2

    def test_a_partial_failure_keeps_the_usable_answer(self) -> None:
        generation, _ = fanout(
            {
                "openai": _Generator(),
                "gemini": _Generator(error=GenerationRefusedError("refused")),
            }
        )

        result = run(generation, [OPENAI, GEMINI])

        assert [outcome.status for outcome in result.outcomes] == [
            LlmCallStatus.SUCCEEDED,
            LlmCallStatus.FAILED,
        ]
        assert len(result.succeeded) == 1
        assert result.outcomes[1].result_code == "generation_refused"

    def test_total_failure_reports_no_success(self) -> None:
        generation, _ = fanout(
            {
                "openai": _Generator(error=GenerationInvalidError("invalid")),
                "gemini": _Generator(error=GenerationUnavailableError("down")),
            }
        )

        result = run(generation, [OPENAI, GEMINI])

        assert result.succeeded == ()
        assert [outcome.result_code for outcome in result.outcomes] == [
            "generation_invalid",
            "generation_unavailable",
        ]

    def test_a_replayed_result_is_reported(self) -> None:
        generation, _ = fanout({"openai": _Generator(replayed=True)})

        result = run(generation, [OPENAI])

        assert result.outcomes[0].replayed is True

    def test_an_unconfigured_provider_fails_without_calling_anything(self) -> None:
        generation, ledger = fanout({"openai": _Generator()})

        result = run(generation, [ANTHROPIC])

        assert result.outcomes[0].result_code == "provider_not_configured"
        assert ledger.records[0]["status"] is LlmCallStatus.FAILED

    @pytest.mark.parametrize(
        ("error", "status", "code"),
        [
            (IdempotencyConflictError("x"), LlmCallStatus.FAILED, "idempotency_conflict"),
            (GenerationInProgressError("x"), LlmCallStatus.INDETERMINATE, "generation_in_progress"),
            (
                GenerationIndeterminateError("x"),
                LlmCallStatus.INDETERMINATE,
                "generation_indeterminate",
            ),
            (GenerationRateLimitedError(9), LlmCallStatus.FAILED, "generation_rate_limited"),
        ],
    )
    def test_each_failure_maps_to_a_stable_code(
        self, error: BaseException, status: LlmCallStatus, code: str
    ) -> None:
        generation, _ = fanout({"openai": _Generator(error=error)})

        outcome = run(generation, [OPENAI]).outcomes[0]

        assert outcome.status is status
        assert outcome.result_code == code

    def test_rate_limiting_keeps_the_retry_delay(self) -> None:
        generation, _ = fanout({"openai": _Generator(error=GenerationRateLimitedError(9))})

        assert run(generation, [OPENAI]).outcomes[0].retry_after == 9

    def test_a_slow_provider_is_indeterminate(self) -> None:
        class _Slow(_Generator):
            def execute(self, **kwargs: Any) -> GenerationResult:
                import time

                time.sleep(0.3)
                return super().execute(**kwargs)

        generation, _ = fanout({"openai": _Slow()}, timeout_seconds=0.05)

        outcome = run(generation, [OPENAI]).outcomes[0]

        assert outcome.status is LlmCallStatus.INDETERMINATE
        assert outcome.result_code == "generation_timeout"

    def test_it_rejects_an_unusable_timeout(self) -> None:
        with pytest.raises(ValueError, match="positive"):
            FanOutGeneration(
                generators={},
                attempts=_Attempts(),
                budget=budget(),
                timeout_seconds=0,
            )


class TestCallBudget:
    def test_it_returns_the_stored_limits(self) -> None:
        limits = budget(_Settings({"daily_call_cap": 4, "per_request_provider_cap": 2})).limits()

        assert limits.daily_call_cap == 4
        assert limits.per_request_provider_cap == 2

    def test_it_refuses_too_many_providers_for_one_request(self) -> None:
        checker = budget(_Settings({"daily_call_cap": 10, "per_request_provider_cap": 1}))

        with pytest.raises(BudgetExceededError) as error:
            checker.check([OPENAI, GEMINI])

        assert error.value.code == "provider_cap_exceeded"
        assert error.value.limit == 1
        assert error.value.observed == 2

    def test_it_refuses_a_request_that_would_pass_the_daily_cap(self) -> None:
        attempts = _Attempts(used=9)
        checker = budget(_Settings({"daily_call_cap": 10, "per_request_provider_cap": 3}), attempts)

        with pytest.raises(BudgetExceededError) as error:
            checker.check([OPENAI, GEMINI])

        assert error.value.code == "daily_cap_exceeded"
        assert error.value.observed == 9

    def test_it_allows_a_request_that_exactly_reaches_the_cap(self) -> None:
        attempts = _Attempts(used=8)
        checker = budget(_Settings({"daily_call_cap": 10, "per_request_provider_cap": 3}), attempts)

        assert checker.check([OPENAI, GEMINI]).daily_call_cap == 10

    def test_it_counts_from_midnight_utc(self) -> None:
        attempts = _Attempts()
        checker = CallBudget(
            read_setting=_Settings(),
            attempts=attempts,
            clock=lambda: datetime(2026, 7, 31, 0, 30, 15, tzinfo=UTC),
        )

        checker.check([OPENAI])

        assert attempts.moment == datetime(2026, 7, 31, 0, 0, tzinfo=UTC)

    def test_an_unknown_budget_code_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="not a known budget code"):
            BudgetExceededError("unknown", limit=1, observed=2)

    def test_the_budget_runs_before_any_provider_call(self) -> None:
        generator = _Generator()
        generation, _ = fanout(
            {"openai": generator},
            settings=_Settings({"daily_call_cap": 1, "per_request_provider_cap": 1}),
            attempts=_Attempts(used=1),
        )

        with pytest.raises(BudgetExceededError):
            run(generation, [OPENAI])
        assert generator.keys == []


def test_recorded_ids_are_unique_per_selection() -> None:
    """Two providers must not collide in the ledger for one request."""
    generation, ledger = fanout({"openai": _Generator(), "gemini": _Generator()})

    run(generation, [OPENAI, GEMINI])

    keys = {(record["selection"].key, record["attempt"]) for record in ledger.records}
    assert len(keys) == 2
    assert all(record["request_hash"] == REQUEST_HASH for record in ledger.records)
    assert uuid4() not in {record.get("recommendation_id") for record in ledger.records}
