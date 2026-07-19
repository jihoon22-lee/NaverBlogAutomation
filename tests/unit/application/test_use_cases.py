"""Tests for generation, retrieval, and review application use cases."""

from dataclasses import dataclass, replace
from datetime import UTC, datetime
from uuid import UUID

import pytest

from naver_blog_assistant.application import (
    ConcurrentReviewError,
    GenerateRecommendation,
    GenerationIndeterminateError,
    GenerationInProgressError,
    GenerationInvalidError,
    GenerationRefusedError,
    GetRecommendation,
    IdempotencyConflictError,
    RecommendationNotFoundError,
    ReviewRecommendation,
)
from naver_blog_assistant.domain import (
    DEFAULT_GENERATION_PREFERENCES,
    CandidateTone,
    CapturedPost,
    CommentLength,
    GeneratedComment,
    GenerationOutput,
    GenerationPreferences,
    Recommendation,
    Relationship,
    ReviewPatch,
    ReviewStatus,
    SpeechStyle,
)
from naver_blog_assistant.ports import (
    GenerationFailureSnapshot,
    GenerationNotStartedError,
    IdempotencyOutcome,
    IdempotencyReservation,
    RecommendationVersionConflictError,
)

KEY = UUID("00000000-0000-0000-0000-000000000010")
IDS = iter(UUID(f"00000000-0000-0000-0000-{value:012d}") for value in range(20, 100))
NOW = datetime(2026, 7, 16, 10, tzinfo=UTC)


@dataclass
class FakeGenerator:
    output: GenerationOutput
    error: Exception | None = None
    calls: int = 0
    received_post: CapturedPost | None = None
    received_preferences: GenerationPreferences | None = None

    def generate(self, post: CapturedPost, preferences: GenerationPreferences) -> GenerationOutput:
        self.calls += 1
        self.received_post = post
        self.received_preferences = preferences
        if self.error is not None:
            raise self.error
        return self.output


class FakeRecommendationRepository:
    def __init__(self) -> None:
        self.items: dict[UUID, Recommendation] = {}
        self.updated: list[Recommendation] = []
        self.fail_version = False

    def get(self, recommendation_id: UUID) -> Recommendation | None:
        return self.items.get(recommendation_id)

    def update(self, recommendation: Recommendation) -> Recommendation:
        if self.fail_version:
            raise RecommendationVersionConflictError("synthetic stale review")
        persisted = replace(recommendation, version=recommendation.version + 1)
        self.items[persisted.id] = persisted
        self.updated.append(persisted)
        return persisted


class FakeIdempotencyRepository:
    def __init__(self, recommendations: FakeRecommendationRepository) -> None:
        self._recommendations = recommendations
        self.records: dict[UUID, tuple[str, Recommendation | None, UUID]] = {}
        self.in_progress: set[UUID] = set()
        self.released: list[UUID] = []
        self.fail_commit = False
        self.fail_failure = False
        self.fail_mark = False
        self.generation_started: set[UUID] = set()
        self.failures: dict[UUID, GenerationFailureSnapshot] = {}
        self._attempts = iter(UUID(int=value) for value in range(500, 600))

    def reserve(self, key: UUID, request_hash: str) -> IdempotencyReservation:
        record = self.records.get(key)
        if record is not None:
            prior_hash, response_snapshot, _ = record
            if prior_hash != request_hash:
                return IdempotencyReservation(IdempotencyOutcome.CONFLICT)
            if response_snapshot is not None:
                return IdempotencyReservation(IdempotencyOutcome.REPLAY, response_snapshot)
            if key in self.failures:
                return IdempotencyReservation(
                    IdempotencyOutcome.FAILURE_REPLAY,
                    failure_snapshot=self.failures[key],
                )
        if key in self.in_progress:
            return IdempotencyReservation(IdempotencyOutcome.IN_PROGRESS)
        attempt_id = next(self._attempts)
        self.records[key] = (request_hash, None, attempt_id)
        self.in_progress.add(key)
        return IdempotencyReservation(IdempotencyOutcome.STARTED, attempt_id=attempt_id)

    def mark_generation_started(self, key: UUID, attempt_id: UUID) -> None:
        if self.fail_mark:
            raise RuntimeError("synthetic mark failure")
        if key not in self.in_progress or self.records[key][2] != attempt_id:
            raise RuntimeError("reservation is not active")
        self.generation_started.add(key)

    def commit_generation(
        self,
        key: UUID,
        attempt_id: UUID,
        *,
        recommendation: Recommendation,
    ) -> None:
        if self.fail_commit:
            raise RuntimeError("synthetic atomic commit failure")
        request_hash, _, current_attempt = self.records[key]
        if current_attempt != attempt_id:
            raise RuntimeError("stale attempt")
        self._recommendations.items[recommendation.id] = recommendation
        self.records[key] = (request_hash, recommendation, attempt_id)
        self.in_progress.remove(key)
        self.generation_started.discard(key)

    def release(self, key: UUID, attempt_id: UUID) -> None:
        if key not in self.records or self.records[key][2] != attempt_id:
            return
        self.records.pop(key, None)
        self.in_progress.discard(key)
        self.generation_started.discard(key)
        self.released.append(key)

    def commit_failure(
        self,
        key: UUID,
        attempt_id: UUID,
        *,
        failure: GenerationFailureSnapshot,
        indeterminate: bool = False,
    ) -> None:
        del indeterminate
        if self.fail_failure:
            raise RuntimeError("synthetic failure persistence error")
        if self.records[key][2] != attempt_id:
            raise RuntimeError("stale attempt")
        self.failures[key] = failure
        self.in_progress.discard(key)
        self.generation_started.discard(key)


def generation_output() -> GenerationOutput:
    return GenerationOutput(
        summary="전시 작품과 관람 동선을 소개한 후기",
        topics=("전시", "관람 동선"),
        candidates=tuple(
            GeneratedComment(
                tone=tone,
                comment=f"{tone.value} 댓글",
                referenced_detail=f"{tone.value} 근거",
            )
            for tone in CandidateTone
        ),
    )


def captured_post(
    body: str = "전시에서 인상 깊었던 작품과 관람 동선을 정리한 본문입니다.",
) -> CapturedPost:
    return CapturedPost(
        source_url="https://blog.naver.com/example/123",
        title="주말 전시 후기",
        body=body,
    )


def build_generation_use_case(
    *, output: GenerationOutput | None = None, error: Exception | None = None
) -> tuple[
    GenerateRecommendation,
    FakeGenerator,
    FakeRecommendationRepository,
    FakeIdempotencyRepository,
]:
    generator = FakeGenerator(output or generation_output(), error=error)
    recommendations = FakeRecommendationRepository()
    idempotency = FakeIdempotencyRepository(recommendations)
    use_case = GenerateRecommendation(
        generator=generator,
        idempotency=idempotency,
        clock=lambda: NOW,
        id_factory=lambda: next(IDS),
    )
    return use_case, generator, recommendations, idempotency


def test_generate_creates_three_tones_and_persists_no_full_body() -> None:
    use_case, generator, recommendations, idempotency = build_generation_use_case()
    post = captured_post()

    result = use_case.execute(post=post, idempotency_key=KEY)

    assert not result.replayed
    assert result.recommendation.review_status is ReviewStatus.DRAFTED
    assert result.recommendation.preferences is DEFAULT_GENERATION_PREFERENCES
    assert {candidate.tone for candidate in result.recommendation.candidates} == set(CandidateTone)
    assert result.recommendation.content_hash == post.content_hash
    assert result.recommendation.excerpt == post.excerpt
    assert not hasattr(result.recommendation, "body")
    assert generator.received_post is post
    assert generator.received_preferences is DEFAULT_GENERATION_PREFERENCES
    assert recommendations.items == {result.recommendation.id: result.recommendation}
    assert idempotency.records[KEY][1] is result.recommendation


def test_generate_passes_and_persists_explicit_preferences() -> None:
    use_case, generator, _, idempotency = build_generation_use_case()
    post = captured_post()
    preferences = GenerationPreferences(
        relationship=Relationship.CLOSE,
        speech=SpeechStyle.BANMAL,
        length=CommentLength.LONG,
    )

    result = use_case.execute(
        post=post,
        preferences=preferences,
        idempotency_key=KEY,
    )

    assert generator.received_preferences is preferences
    assert result.recommendation.preferences is preferences
    assert idempotency.records[KEY][0] == post.request_hash_for(preferences)


def test_generate_replays_completed_request_without_calling_generator() -> None:
    use_case, generator, _, _ = build_generation_use_case()
    post = captured_post()
    first = use_case.execute(post=post, idempotency_key=KEY)

    second = use_case.execute(post=post, idempotency_key=KEY)

    assert second.replayed
    assert second.recommendation is first.recommendation
    assert generator.calls == 1


def test_generate_replays_immutable_first_response_after_canonical_review() -> None:
    use_case, generator, recommendations, _ = build_generation_use_case()
    post = captured_post()
    first = use_case.execute(post=post, idempotency_key=KEY)
    review = ReviewRecommendation(recommendations, clock=lambda: NOW)
    reviewed = review.execute(
        first.recommendation.id,
        ReviewPatch(
            selected_candidate_index=0,
            edited_comment="사용자가 다듬은 댓글",
            review_status=ReviewStatus.APPROVED,
        ),
    )

    replayed = use_case.execute(post=post, idempotency_key=KEY)

    assert recommendations.get(first.recommendation.id) is reviewed
    assert replayed.replayed
    assert replayed.recommendation is first.recommendation
    assert replayed.recommendation.review_status is ReviewStatus.DRAFTED
    assert replayed.recommendation.selected_candidate_id is None
    assert replayed.recommendation.edited_comment is None
    assert generator.calls == 1


def test_generate_rejects_key_reuse_for_different_content() -> None:
    use_case, generator, _, _ = build_generation_use_case()
    use_case.execute(post=captured_post(), idempotency_key=KEY)

    with pytest.raises(IdempotencyConflictError):
        use_case.execute(post=captured_post("완전히 다른 새 본문입니다."), idempotency_key=KEY)

    assert generator.calls == 1


def test_generate_rejects_request_already_in_progress() -> None:
    use_case, generator, _, idempotency = build_generation_use_case()
    post = captured_post()
    idempotency.reserve(KEY, post.request_hash)

    with pytest.raises(GenerationInProgressError):
        use_case.execute(post=post, idempotency_key=KEY)

    assert generator.calls == 0


def test_generate_releases_reservation_after_generator_failure() -> None:
    failure = GenerationNotStartedError("provider request was not sent")
    use_case, _, _, idempotency = build_generation_use_case(error=failure)

    with pytest.raises(GenerationNotStartedError, match="not sent"):
        use_case.execute(post=captured_post(), idempotency_key=KEY)

    assert idempotency.released == [KEY]
    assert KEY not in idempotency.records


def test_generate_cleans_up_its_attempt_when_generation_mark_fails() -> None:
    use_case, generator, _, idempotency = build_generation_use_case()
    idempotency.fail_mark = True

    with pytest.raises(RuntimeError, match="mark failure"):
        use_case.execute(post=captured_post(), idempotency_key=KEY)

    assert generator.calls == 0
    assert KEY not in idempotency.records
    assert idempotency.released == [KEY]


@pytest.mark.parametrize("failure", [RuntimeError("provider failure"), TimeoutError("timeout")])
def test_generate_preserves_uncertain_provider_failure(failure: Exception) -> None:
    use_case, _, _, idempotency = build_generation_use_case(error=failure)

    with pytest.raises(GenerationIndeterminateError):
        use_case.execute(post=captured_post(), idempotency_key=KEY)

    assert KEY in idempotency.records
    assert KEY not in idempotency.generation_started
    assert idempotency.failures[KEY].code == "generation_indeterminate"
    assert not idempotency.released


def test_generate_rejects_invalid_output_without_risking_duplicate_generation() -> None:
    output = generation_output()
    invalid = GenerationOutput(output.summary, output.topics, output.candidates[:2])
    use_case, _, recommendations, idempotency = build_generation_use_case(output=invalid)

    with pytest.raises(GenerationInvalidError):
        use_case.execute(post=captured_post(), idempotency_key=KEY)

    assert not recommendations.items
    assert KEY not in idempotency.in_progress
    assert KEY not in idempotency.generation_started
    assert idempotency.failures[KEY].code == "generation_invalid"
    assert not idempotency.released


def test_generate_atomic_commit_failure_persists_neither_canonical_nor_snapshot() -> None:
    use_case, _, recommendations, idempotency = build_generation_use_case()
    idempotency.fail_commit = True

    with pytest.raises(GenerationIndeterminateError):
        use_case.execute(post=captured_post(), idempotency_key=KEY)

    assert not recommendations.items
    assert KEY in idempotency.records
    assert KEY not in idempotency.in_progress
    assert KEY not in idempotency.generation_started
    assert idempotency.failures[KEY].code == "generation_indeterminate"
    assert not idempotency.released


@pytest.mark.parametrize(
    "provider_error",
    [GenerationInvalidError("invalid"), GenerationRefusedError("refused")],
)
def test_failure_persistence_error_is_stable_and_keeps_generating_row(
    provider_error: Exception,
) -> None:
    use_case, _, _, idempotency = build_generation_use_case(error=provider_error)
    idempotency.fail_failure = True

    with pytest.raises(GenerationIndeterminateError, match="persisted safely"):
        use_case.execute(post=captured_post(), idempotency_key=KEY)

    assert KEY in idempotency.in_progress
    assert KEY in idempotency.generation_started
    assert KEY not in idempotency.failures


def test_success_commit_and_failure_commit_double_failure_remains_generating() -> None:
    use_case, _, recommendations, idempotency = build_generation_use_case()
    idempotency.fail_commit = True
    idempotency.fail_failure = True

    with pytest.raises(GenerationIndeterminateError, match="persisted safely"):
        use_case.execute(post=captured_post(), idempotency_key=KEY)

    assert not recommendations.items
    assert KEY in idempotency.in_progress
    assert KEY in idempotency.generation_started


def test_get_returns_existing_recommendation_and_rejects_missing_id() -> None:
    generate, _, repository, _ = build_generation_use_case()
    recommendation = generate.execute(post=captured_post(), idempotency_key=KEY).recommendation
    get = GetRecommendation(repository)

    assert get.execute(recommendation.id) is recommendation
    with pytest.raises(RecommendationNotFoundError) as error:
        get.execute(UUID(int=404))
    assert error.value.recommendation_id == UUID(int=404)


def test_review_updates_selected_candidate_edit_and_status() -> None:
    generate, _, repository, _ = build_generation_use_case()
    recommendation = generate.execute(post=captured_post(), idempotency_key=KEY).recommendation
    review = ReviewRecommendation(repository, clock=lambda: NOW)

    updated = review.execute(
        recommendation.id,
        ReviewPatch(
            selected_candidate_index=1,
            edited_comment="사용자가 다듬은 댓글",
            review_status=ReviewStatus.APPROVED,
        ),
    )

    assert updated.selected_candidate_id == recommendation.candidates[1].id
    assert updated.edited_comment == "사용자가 다듬은 댓글"
    assert updated.review_status is ReviewStatus.APPROVED
    assert updated.updated_at == NOW
    assert updated.version == 1
    assert repository.updated == [updated]


def test_review_rejects_missing_recommendation_without_updating_repository() -> None:
    repository = FakeRecommendationRepository()
    review = ReviewRecommendation(repository, clock=lambda: NOW)

    with pytest.raises(RecommendationNotFoundError):
        review.execute(UUID(int=404), ReviewPatch(edited_comment="댓글"))

    assert not repository.updated


def test_review_maps_stale_version_to_stable_application_error() -> None:
    generate, _, repository, _ = build_generation_use_case()
    recommendation = generate.execute(post=captured_post(), idempotency_key=KEY).recommendation
    repository.fail_version = True

    with pytest.raises(ConcurrentReviewError) as error:
        ReviewRecommendation(repository, clock=lambda: NOW).execute(
            recommendation.id,
            ReviewPatch(edited_comment="충돌하는 수정"),
        )

    assert isinstance(error.value.__cause__, RecommendationVersionConflictError)


def test_idempotency_reservation_rejects_replay_without_snapshot() -> None:
    with pytest.raises(ValueError, match="response snapshot"):
        IdempotencyReservation(IdempotencyOutcome.REPLAY)


@pytest.mark.parametrize("outcome", [IdempotencyOutcome.CONFLICT, IdempotencyOutcome.IN_PROGRESS])
def test_idempotency_reservation_rejects_snapshot_for_non_replay(
    outcome: IdempotencyOutcome,
) -> None:
    generate, _, _, _ = build_generation_use_case()
    snapshot = generate.execute(post=captured_post(), idempotency_key=UUID(int=998)).recommendation

    with pytest.raises(ValueError, match="carry no payload"):
        IdempotencyReservation(outcome, snapshot)


def test_started_idempotency_reservation_requires_only_attempt_id() -> None:
    assert IdempotencyReservation(
        IdempotencyOutcome.STARTED, attempt_id=UUID(int=779)
    ).attempt_id == UUID(int=779)
    with pytest.raises(ValueError, match="attempt id"):
        IdempotencyReservation(IdempotencyOutcome.STARTED)
    with pytest.raises(ValueError, match="attempt id"):
        IdempotencyReservation(
            IdempotencyOutcome.STARTED,
            response_snapshot=build_generation_use_case()[0]
            .execute(post=captured_post(), idempotency_key=UUID(int=777))
            .recommendation,
            attempt_id=UUID(int=778),
        )


@pytest.mark.parametrize(
    "outcome",
    [IdempotencyOutcome.REPLAY, IdempotencyOutcome.CONFLICT, IdempotencyOutcome.IN_PROGRESS],
)
def test_non_started_idempotency_reservation_rejects_attempt_id(
    outcome: IdempotencyOutcome,
) -> None:
    snapshot = (
        build_generation_use_case()[0]
        .execute(post=captured_post(), idempotency_key=UUID(int=780))
        .recommendation
        if outcome is IdempotencyOutcome.REPLAY
        else None
    )
    with pytest.raises(ValueError):
        IdempotencyReservation(outcome, snapshot, attempt_id=UUID(int=781))
