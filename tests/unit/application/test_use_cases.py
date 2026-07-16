"""Tests for generation, retrieval, and review application use cases."""

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

import pytest

from naver_blog_assistant.application import (
    GenerateRecommendation,
    GenerationInProgressError,
    GetRecommendation,
    IdempotencyConflictError,
    RecommendationNotFoundError,
    ReviewRecommendation,
)
from naver_blog_assistant.domain import (
    CandidateTone,
    CapturedPost,
    GeneratedComment,
    GenerationOutput,
    Recommendation,
    ReviewPatch,
    ReviewStatus,
)
from naver_blog_assistant.ports import IdempotencyOutcome, IdempotencyReservation

KEY = UUID("00000000-0000-0000-0000-000000000010")
IDS = iter(UUID(f"00000000-0000-0000-0000-{value:012d}") for value in range(20, 100))
NOW = datetime(2026, 7, 16, 10, tzinfo=UTC)


@dataclass
class FakeGenerator:
    output: GenerationOutput
    error: Exception | None = None
    calls: int = 0
    received_post: CapturedPost | None = None

    def generate(self, post: CapturedPost) -> GenerationOutput:
        self.calls += 1
        self.received_post = post
        if self.error is not None:
            raise self.error
        return self.output


class FakeRecommendationRepository:
    def __init__(self) -> None:
        self.items: dict[UUID, Recommendation] = {}
        self.updated: list[Recommendation] = []

    def get(self, recommendation_id: UUID) -> Recommendation | None:
        return self.items.get(recommendation_id)

    def update(self, recommendation: Recommendation) -> None:
        self.items[recommendation.id] = recommendation
        self.updated.append(recommendation)


class FakeIdempotencyRepository:
    def __init__(self, recommendations: FakeRecommendationRepository) -> None:
        self._recommendations = recommendations
        self.records: dict[UUID, tuple[str, Recommendation | None]] = {}
        self.in_progress: set[UUID] = set()
        self.released: list[UUID] = []
        self.fail_commit = False

    def reserve(self, key: UUID, request_hash: str) -> IdempotencyReservation:
        record = self.records.get(key)
        if record is not None:
            prior_hash, response_snapshot = record
            if prior_hash != request_hash:
                return IdempotencyReservation(IdempotencyOutcome.CONFLICT)
            if response_snapshot is not None:
                return IdempotencyReservation(IdempotencyOutcome.REPLAY, response_snapshot)
        if key in self.in_progress:
            return IdempotencyReservation(IdempotencyOutcome.IN_PROGRESS)
        self.records[key] = (request_hash, None)
        self.in_progress.add(key)
        return IdempotencyReservation(IdempotencyOutcome.STARTED)

    def commit_generation(
        self,
        key: UUID,
        *,
        recommendation: Recommendation,
        response_snapshot: Recommendation,
    ) -> None:
        if self.fail_commit:
            raise RuntimeError("synthetic atomic commit failure")
        request_hash, _ = self.records[key]
        self._recommendations.items[recommendation.id] = recommendation
        self.records[key] = (request_hash, response_snapshot)
        self.in_progress.remove(key)

    def release(self, key: UUID) -> None:
        self.records.pop(key, None)
        self.in_progress.discard(key)
        self.released.append(key)


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
    assert {candidate.tone for candidate in result.recommendation.candidates} == set(CandidateTone)
    assert result.recommendation.content_hash == post.content_hash
    assert result.recommendation.excerpt == post.excerpt
    assert not hasattr(result.recommendation, "body")
    assert generator.received_post is post
    assert recommendations.items == {result.recommendation.id: result.recommendation}
    assert idempotency.records[KEY][1] is result.recommendation


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
    failure = RuntimeError("synthetic generator failure")
    use_case, _, _, idempotency = build_generation_use_case(error=failure)

    with pytest.raises(RuntimeError, match="synthetic"):
        use_case.execute(post=captured_post(), idempotency_key=KEY)

    assert idempotency.released == [KEY]
    assert KEY not in idempotency.records


def test_generate_rejects_invalid_generator_candidate_count_and_releases_key() -> None:
    output = generation_output()
    invalid = GenerationOutput(output.summary, output.topics, output.candidates[:2])
    use_case, _, recommendations, idempotency = build_generation_use_case(output=invalid)

    with pytest.raises(ValueError, match="exactly three"):
        use_case.execute(post=captured_post(), idempotency_key=KEY)

    assert not recommendations.items
    assert idempotency.released == [KEY]


def test_generate_atomic_commit_failure_persists_neither_canonical_nor_snapshot() -> None:
    use_case, _, recommendations, idempotency = build_generation_use_case()
    idempotency.fail_commit = True

    with pytest.raises(RuntimeError, match="atomic commit"):
        use_case.execute(post=captured_post(), idempotency_key=KEY)

    assert not recommendations.items
    assert KEY not in idempotency.records
    assert KEY not in idempotency.in_progress
    assert idempotency.released == [KEY]


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
    assert repository.updated == [updated]


def test_review_rejects_missing_recommendation_without_updating_repository() -> None:
    repository = FakeRecommendationRepository()
    review = ReviewRecommendation(repository, clock=lambda: NOW)

    with pytest.raises(RecommendationNotFoundError):
        review.execute(UUID(int=404), ReviewPatch(edited_comment="댓글"))

    assert not repository.updated


def test_idempotency_reservation_rejects_replay_without_snapshot() -> None:
    with pytest.raises(ValueError, match="only replay"):
        IdempotencyReservation(IdempotencyOutcome.REPLAY)


@pytest.mark.parametrize("outcome", [IdempotencyOutcome.STARTED, IdempotencyOutcome.CONFLICT])
def test_idempotency_reservation_rejects_snapshot_for_non_replay(
    outcome: IdempotencyOutcome,
) -> None:
    generate, _, _, _ = build_generation_use_case()
    snapshot = generate.execute(post=captured_post(), idempotency_key=UUID(int=998)).recommendation

    with pytest.raises(ValueError, match="only replay"):
        IdempotencyReservation(outcome, snapshot)
