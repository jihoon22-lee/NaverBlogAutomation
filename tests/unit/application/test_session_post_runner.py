"""One-post session orchestration preserves failure and idempotency boundaries."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, cast
from uuid import UUID

import pytest

from naver_blog_assistant.application.automation.generate_comment import (
    GenerationOptions,
    PlanGeneration,
)
from naver_blog_assistant.application.automation.session_post_runner import SessionPostRunner
from naver_blog_assistant.application.errors import ApplicationError
from naver_blog_assistant.application.settings import ReadAppSetting
from naver_blog_assistant.domain import (
    DEFAULT_GENERATION_PREFERENCES,
    AppSettingKind,
    ArticleExtraction,
    CandidateTone,
    CapturedPost,
    CommentCandidate,
    DiscoveredPost,
    DiscoverySource,
    DiscoveryState,
    EngagementRunState,
    PersonalizationMode,
    Recommendation,
    ReviewPatch,
    ReviewStatus,
)

NOW = datetime(2026, 8, 9, 12, 0, tzinfo=UTC)
POST_ID = UUID("11111111-1111-4111-8111-111111111111")
RECOMMENDATION_ID = UUID("22222222-2222-4222-8222-222222222222")
RUN_ID = UUID("33333333-3333-4333-8333-333333333333")
IDEMPOTENCY_KEY = UUID("44444444-4444-4444-8444-444444444444")


class _CodedApplicationError(ApplicationError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def post() -> DiscoveredPost:
    return DiscoveredPost(
        id=POST_ID,
        source=DiscoverySource.NEIGHBOR,
        state=DiscoveryState.QUEUED,
        source_url="https://blog.naver.com/example/223456789012",
        title="합성 전시 후기",
        publisher_name="합성 이웃",
        publisher_blog_id="example",
        published_at=NOW,
        neighbor_id=UUID("55555555-5555-4555-8555-555555555555"),
        search_id=None,
        created_at=NOW,
        updated_at=NOW,
    )


def extraction() -> ArticleExtraction:
    body = "전시에서 인상 깊었던 작품과 관람 동선을 정리한 합성 본문입니다."
    return ArticleExtraction(
        source_url="https://blog.naver.com/example/223456789012",
        title="합성 전시 후기",
        body=body,
        original_length=len(body),
    )


def recommendation() -> Recommendation:
    return Recommendation(
        id=RECOMMENDATION_ID,
        source_url="https://blog.naver.com/example/223456789012",
        title="합성 전시 후기",
        content_hash="a" * 64,
        excerpt="합성 본문 일부",
        summary="합성 전시 요약",
        topics=("전시",),
        candidates=tuple(
            CommentCandidate(
                id=UUID(int=100 + index),
                tone=tone,
                comment=f"{tone.value} 댓글",
                referenced_detail="본문 근거",
            )
            for index, tone in enumerate(CandidateTone)
        ),
        review_status=ReviewStatus.DRAFTED,
        created_at=NOW,
        preferences=DEFAULT_GENERATION_PREFERENCES,
        personalization_mode=PersonalizationMode.OFF,
    )


@dataclass(frozen=True)
class _Plan:
    post: CapturedPost
    preferences: Any = DEFAULT_GENERATION_PREFERENCES
    personalization_mode: PersonalizationMode = PersonalizationMode.OFF


class _Extractor:
    def __init__(self, *, error: BaseException | None = None) -> None:
        self.error = error
        self.calls: list[str] = []

    async def execute(self, source_url: str) -> ArticleExtraction:
        self.calls.append(source_url)
        if self.error is not None:
            raise self.error
        return extraction()


class _Planner:
    def __init__(self) -> None:
        self.calls: list[tuple[ArticleExtraction, GenerationOptions]] = []
        self.key_calls: list[tuple[_Plan, GenerationOptions]] = []
        article = extraction()
        self.plan = _Plan(
            post=CapturedPost(
                source_url=article.source_url,
                title=article.title,
                body=article.body,
            )
        )

    def execute(self, article: ArticleExtraction, options: GenerationOptions) -> _Plan:
        self.calls.append((article, options))
        return self.plan

    def key_for(self, plan: _Plan, options: GenerationOptions) -> tuple[int, str]:
        self.key_calls.append((plan, options))
        return 1, str(IDEMPOTENCY_KEY)


class _Generator:
    def __init__(self, *, error: BaseException | None = None) -> None:
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def execute(self, **kwargs: Any) -> SimpleNamespace:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(recommendation=recommendation())


class _Review:
    def __init__(self, *, error: BaseException | None = None) -> None:
        self.error = error
        self.calls: list[tuple[UUID, ReviewPatch]] = []

    def execute(self, recommendation_id: UUID, patch: ReviewPatch) -> Recommendation:
        self.calls.append((recommendation_id, patch))
        if self.error is not None:
            raise self.error
        return recommendation()


class _Settings:
    def __init__(self, phrase: str = "감사합니다") -> None:
        self.phrase = phrase
        self.calls: list[AppSettingKind] = []

    def execute(self, kind: AppSettingKind) -> SimpleNamespace:
        self.calls.append(kind)
        return SimpleNamespace(payload={"phrase": self.phrase})


class _Runs:
    def __init__(
        self,
        *,
        error: BaseException | None = None,
        finished: SimpleNamespace | None = None,
    ) -> None:
        self.error = error
        self.finished = finished
        self.prepare_calls: list[tuple[UUID, UUID]] = []
        self.run_calls: list[tuple[UUID, object]] = []

    def prepare(self, *, discovery_post_id: UUID, recommendation_id: UUID) -> tuple[Any, object]:
        self.prepare_calls.append((discovery_post_id, recommendation_id))
        if self.error is not None:
            raise self.error
        return SimpleNamespace(id=RUN_ID), object()

    async def run(self, run_id: UUID, request: object) -> SimpleNamespace | None:
        self.run_calls.append((run_id, request))
        return self.finished


def make_subject(
    *,
    extraction_error: BaseException | None = None,
    generation_error: BaseException | None = None,
    review_error: BaseException | None = None,
    prepare_error: BaseException | None = None,
    finished: SimpleNamespace | None = None,
    to_thread: Callable[..., Any] | None = None,
) -> tuple[SessionPostRunner, _Extractor, _Planner, _Generator, _Review, _Settings, _Runs]:
    extractor = _Extractor(error=extraction_error)
    planner = _Planner()
    generator = _Generator(error=generation_error)
    review = _Review(error=review_error)
    settings = _Settings()
    runs = _Runs(error=prepare_error, finished=finished)
    subject = SessionPostRunner(
        extract=extractor,
        planner=cast(PlanGeneration, planner),
        generate=generator,
        review=review,
        runs=runs,
        read_setting=cast(ReadAppSetting, settings),
        to_thread=to_thread,
    )
    return subject, extractor, planner, generator, review, settings, runs


def run_one(subject: SessionPostRunner) -> tuple[EngagementRunState, tuple[str, ...]]:
    return asyncio.run(subject.run_one(post()))


def finished(
    state: EngagementRunState = EngagementRunState.SUCCEEDED,
    *result_codes: str | None,
) -> SimpleNamespace:
    return SimpleNamespace(
        state=state,
        steps=[SimpleNamespace(result_code=code) for code in result_codes],
    )


def test_success_preserves_plan_provenance_approval_and_result_codes() -> None:
    subject, extractor, planner, generator, review, settings, runs = make_subject(
        finished=finished(EngagementRunState.SUCCEEDED, "liked", None, "comment_published")
    )

    state, codes = run_one(subject)

    assert state is EngagementRunState.SUCCEEDED
    assert codes == ("liked", "comment_published")
    assert extractor.calls == [post().source_url]
    assert len(planner.calls) == 1
    assert planner.calls[0][1] == GenerationOptions()
    assert planner.key_calls == [(planner.plan, GenerationOptions())]
    assert len(generator.calls) == 1
    assert generator.calls[0]["post"] == planner.plan.post
    assert generator.calls[0]["preferences"] == planner.plan.preferences
    assert generator.calls[0]["personalization_mode"] is PersonalizationMode.OFF
    assert generator.calls[0]["idempotency_key"] == IDEMPOTENCY_KEY
    assert settings.calls == [AppSettingKind.CLOSING_PHRASE]
    assert len(review.calls) == 1
    recommendation_id, patch = review.calls[0]
    assert recommendation_id == RECOMMENDATION_ID
    assert patch.selected_candidate_id == UUID(int=100)
    assert patch.edited_comment == "warm 댓글 감사합니다"
    assert patch.review_status is ReviewStatus.APPROVED
    assert runs.prepare_calls == [(POST_ID, RECOMMENDATION_ID)]
    assert len(runs.run_calls) == 1
    assert runs.run_calls[0][0] == RUN_ID


def test_injected_thread_runner_can_execute_generation_without_replaying_it() -> None:
    calls: list[Callable[..., Any]] = []

    async def direct(function: Callable[..., Any], **kwargs: Any) -> Any:
        calls.append(function)
        return function(**kwargs)

    subject, _, _, _, _, _, _ = make_subject(
        finished=finished(EngagementRunState.SUCCEEDED, "comment_published"),
        to_thread=direct,
    )

    state, codes = run_one(subject)

    assert state is EngagementRunState.SUCCEEDED
    assert codes == ("comment_published",)
    assert len(calls) == 1


@pytest.mark.parametrize(
    ("error", "expected_code"),
    [
        (_CodedApplicationError("source_unavailable"), "source_unavailable"),
        (ApplicationError("opaque extraction failure"), "extraction_failed"),
        (RuntimeError("adapter failed"), "extraction_failed"),
    ],
)
def test_extraction_failures_become_terminal_codes(
    error: BaseException, expected_code: str
) -> None:
    subject, _, _, generator, review, _, runs = make_subject(extraction_error=error)

    state, codes = run_one(subject)

    assert state is EngagementRunState.FAILED
    assert codes == (expected_code,)
    assert generator.calls == []
    assert review.calls == []
    assert runs.prepare_calls == []


@pytest.mark.parametrize(
    ("error", "expected_code"),
    [
        (_CodedApplicationError("provider_refused"), "provider_refused"),
        (ApplicationError("opaque generation failure"), "generation_failed"),
    ],
)
def test_generation_application_errors_use_their_code_or_safe_fallback(
    error: ApplicationError, expected_code: str
) -> None:
    subject, _, _, _, review, _, runs = make_subject(generation_error=error)

    state, codes = run_one(subject)

    assert state is EngagementRunState.FAILED
    assert codes == (expected_code,)
    assert review.calls == []
    assert runs.prepare_calls == []


def test_approval_failure_does_not_start_an_engagement_run() -> None:
    subject, _, _, generator, review, _, runs = make_subject(
        review_error=ApplicationError("review conflict")
    )

    state, codes = run_one(subject)

    assert state is EngagementRunState.FAILED
    assert codes == ("approval_failed",)
    assert len(generator.calls) == 1
    assert len(review.calls) == 1
    assert runs.prepare_calls == []
    assert runs.run_calls == []


@pytest.mark.parametrize(
    ("error", "expected_code"),
    [
        (_CodedApplicationError("engagement_not_allowed"), "engagement_not_allowed"),
        (ApplicationError("opaque prepare failure"), "not_allowed"),
        (ValueError("stale engagement"), "engagement_conflict"),
    ],
)
def test_prepare_failures_never_execute_external_steps(
    error: BaseException, expected_code: str
) -> None:
    subject, _, _, _, _, _, runs = make_subject(prepare_error=error)

    state, codes = run_one(subject)

    assert state is EngagementRunState.FAILED
    assert codes == (expected_code,)
    assert runs.prepare_calls == [(POST_ID, RECOMMENDATION_ID)]
    assert runs.run_calls == []


def test_missing_finished_run_is_unconfirmed_and_never_claimed_successful() -> None:
    subject, _, _, _, _, _, runs = make_subject(finished=None)

    state, codes = run_one(subject)

    assert state is EngagementRunState.UNCONFIRMED
    assert codes == ("run_missing",)
    assert len(runs.run_calls) == 1


def test_finished_failure_keeps_only_persisted_result_codes() -> None:
    subject, _, _, _, _, _, _ = make_subject(
        finished=finished(EngagementRunState.FAILED, None, "comment_failed")
    )

    state, codes = run_one(subject)

    assert state is EngagementRunState.FAILED
    assert codes == ("comment_failed",)
