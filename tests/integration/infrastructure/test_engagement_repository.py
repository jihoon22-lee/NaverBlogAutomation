"""Integration coverage for persisted one-post engagement execution."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import select

from naver_blog_assistant.domain import (
    DEFAULT_GENERATION_PREFERENCES,
    CandidateTone,
    CommentCandidate,
    DiscoverySource,
    EngagementRunState,
    EngagementStepName,
    EngagementStepState,
    ImportedDiscoveryPost,
    Recommendation,
    ReviewPatch,
    ReviewStatus,
)
from naver_blog_assistant.infrastructure.database import (
    SqliteDiscoveryRepository,
    SqliteEngagementRepository,
    SqliteRepository,
    create_sqlite_engine,
)
from naver_blog_assistant.infrastructure.database.schema import discovered_posts
from naver_blog_assistant.ports import IdempotencyOutcome

ROOT = Path(__file__).parents[3]
NOW = datetime(2026, 7, 28, 9, 0, tzinfo=UTC)
RECOMMENDATION_ID = UUID("00000000-0000-4000-8000-000000000010")


def recommendation(source_url: str, *, approved: bool = True) -> Recommendation:
    drafted = Recommendation(
        id=RECOMMENDATION_ID,
        source_url=source_url,
        title="합성 교류 글",
        content_hash="b" * 64,
        excerpt="합성 교류 글의 일부",
        summary="합성 교류 글 요약",
        topics=("교류",),
        candidates=tuple(
            CommentCandidate(
                id=UUID(f"00000000-0000-4000-8000-{index:012d}"),
                tone=tone,
                comment=f"{tone.value} 댓글",
                referenced_detail=f"{tone.value} 근거",
            )
            for index, tone in enumerate(CandidateTone, start=20)
        ),
        review_status=ReviewStatus.DRAFTED,
        created_at=NOW,
        preferences=DEFAULT_GENERATION_PREFERENCES,
    )
    return (
        drafted.apply_review(
            ReviewPatch(selected_candidate_index=0, review_status=ReviewStatus.APPROVED),
            reviewed_at=NOW,
        )
        if approved
        else drafted
    )


def persist_recommendation(repository: SqliteRepository, item: Recommendation) -> None:
    key = UUID("00000000-0000-4000-8000-000000000001")
    reservation = repository.reserve(key, "a" * 64)
    assert reservation.outcome is IdempotencyOutcome.STARTED
    assert reservation.attempt_id is not None
    repository.mark_generation_started(key, reservation.attempt_id)
    drafted = (
        item
        if item.review_status is ReviewStatus.DRAFTED
        else recommendation(item.source_url, approved=False)
    )
    repository.commit_generation(
        key,
        reservation.attempt_id,
        recommendation=drafted,
    )
    if item.review_status is ReviewStatus.APPROVED:
        repository.update(item)


@pytest.fixture
def repositories(tmp_path: Path):
    url = f"sqlite:///{tmp_path / 'engagement.db'}"
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "head")
    engine = create_sqlite_engine(url)
    clock = [NOW]
    yield (
        engine,
        SqliteRepository(engine, clock=lambda: clock[0]),
        SqliteDiscoveryRepository(engine, clock=lambda: clock[0]),
        SqliteEngagementRepository(engine, clock=lambda: clock[0]),
        clock,
    )
    engine.dispose()


def create_post(
    discovery: SqliteDiscoveryRepository,
    *,
    source: DiscoverySource,
    source_url: str,
) -> UUID:
    if source is DiscoverySource.NEIGHBOR:
        neighbor = discovery.save_neighbor(
            name="합성 이웃",
            blog_url="https://blog.naver.com/candidate",
            blog_id="candidate",
        )
        discovery.import_posts(
            source=source,
            neighbor_id=neighbor.id,
            posts=(ImportedDiscoveryPost(source_url=source_url, title="합성 교류 글"),),
        )
    else:
        search = discovery.save_search(query="합성 검색", excluded_terms=(), freshness_days=14)
        discovery.import_posts(
            source=source,
            search_id=search.id,
            posts=(
                ImportedDiscoveryPost(
                    source_url=source_url,
                    title="합성 교류 글",
                    publisher_blog_id="candidate",
                ),
            ),
        )
    return discovery.list_posts(source)[0].id


def test_neighbor_run_completes_recommendation_and_discovery_post(repositories) -> None:
    engine, recommendations, discovery, engagement, clock = repositories
    source_url = "https://blog.naver.com/candidate/123"
    item = recommendation(source_url)
    persist_recommendation(recommendations, item)
    post_id = create_post(discovery, source=DiscoverySource.NEIGHBOR, source_url=source_url)
    approval_id = UUID("00000000-0000-4000-8000-000000000030")

    started = engagement.start(
        approval_id=approval_id,
        discovery_post_id=post_id,
        recommendation_id=item.id,
    )
    assert started.created
    assert [step.name for step in started.run.steps] == [
        EngagementStepName.LIKE,
        EngagementStepName.COMMENT,
    ]
    replay = engagement.start(
        approval_id=approval_id,
        discovery_post_id=post_id,
        recommendation_id=item.id,
    )
    assert not replay.created
    assert replay.run.id == started.run.id

    with pytest.raises(ValueError, match="order"):
        engagement.transition_step(
            started.run.id, EngagementStepName.COMMENT, EngagementStepState.RUNNING
        )
    engagement.transition_step(started.run.id, EngagementStepName.LIKE, EngagementStepState.RUNNING)
    clock[0] += timedelta(seconds=1)
    engagement.transition_step(
        started.run.id,
        EngagementStepName.LIKE,
        EngagementStepState.SUCCEEDED,
        result_code="clicked",
    )
    engagement.transition_step(
        started.run.id, EngagementStepName.COMMENT, EngagementStepState.RUNNING
    )
    completed = engagement.transition_step(
        started.run.id,
        EngagementStepName.COMMENT,
        EngagementStepState.SUCCEEDED,
        result_code="submitted",
    )

    assert completed.state is EngagementRunState.SUCCEEDED
    assert recommendations.get(item.id).review_status is ReviewStatus.COMPLETED  # type: ignore[union-attr]
    with engine.connect() as connection:
        assert (
            connection.execute(
                select(discovered_posts.c.state).where(discovered_posts.c.id == str(post_id))
            ).scalar_one()
            == "completed"
        )


def test_start_accepts_equivalent_naver_post_url_shapes(repositories) -> None:
    _, recommendations, discovery, engagement, _ = repositories
    recommendation_url = (
        "https://blog.naver.com/PostView.naver?blogId=candidate&logNo=124&redirect=Dlog"
    )
    item = recommendation(recommendation_url)
    persist_recommendation(recommendations, item)
    post_id = create_post(
        discovery,
        source=DiscoverySource.NEIGHBOR,
        source_url="https://blog.naver.com/candidate/124?trackingCode=feed",
    )

    started = engagement.start(
        approval_id=UUID("00000000-0000-4000-8000-000000000043"),
        discovery_post_id=post_id,
        recommendation_id=item.id,
    )

    assert started.created
    assert started.run.discovery_post_id == post_id


def test_search_run_retries_only_failed_step_and_stops_unconfirmed(repositories) -> None:
    _, recommendations, discovery, engagement, _ = repositories
    source_url = "https://blog.naver.com/candidate/456"
    item = recommendation(source_url)
    persist_recommendation(recommendations, item)
    post_id = create_post(discovery, source=DiscoverySource.SEARCH, source_url=source_url)
    run = engagement.start(
        approval_id=UUID("00000000-0000-4000-8000-000000000031"),
        discovery_post_id=post_id,
        recommendation_id=item.id,
    ).run

    engagement.transition_step(run.id, EngagementStepName.LIKE, EngagementStepState.RUNNING)
    engagement.transition_step(
        run.id,
        EngagementStepName.LIKE,
        EngagementStepState.SKIPPED,
        result_code="already_liked",
    )
    engagement.transition_step(run.id, EngagementStepName.COMMENT, EngagementStepState.RUNNING)
    engagement.transition_step(
        run.id,
        EngagementStepName.COMMENT,
        EngagementStepState.SUCCEEDED,
        result_code="submitted",
    )
    engagement.transition_step(
        run.id, EngagementStepName.MUTUAL_NEIGHBOR, EngagementStepState.RUNNING
    )
    failed = engagement.transition_step(
        run.id,
        EngagementStepName.MUTUAL_NEIGHBOR,
        EngagementStepState.FAILED,
        result_code="request_unavailable",
    )
    assert failed.state is EngagementRunState.FAILED
    assert failed.steps[0].state is EngagementStepState.SKIPPED
    assert failed.steps[1].state is EngagementStepState.SUCCEEDED

    engagement.transition_step(
        run.id, EngagementStepName.MUTUAL_NEIGHBOR, EngagementStepState.RUNNING
    )
    succeeded = engagement.transition_step(
        run.id,
        EngagementStepName.MUTUAL_NEIGHBOR,
        EngagementStepState.SUCCEEDED,
        result_code="requested",
    )
    assert succeeded.state is EngagementRunState.SUCCEEDED


def test_unconfirmed_step_cannot_be_retried_and_history_is_bounded(repositories) -> None:
    _, recommendations, discovery, engagement, _ = repositories
    source_url = "https://blog.naver.com/candidate/999"
    item = recommendation(source_url)
    persist_recommendation(recommendations, item)
    post_id = create_post(discovery, source=DiscoverySource.NEIGHBOR, source_url=source_url)
    run = engagement.start(
        approval_id=UUID("00000000-0000-4000-8000-000000000032"),
        discovery_post_id=post_id,
        recommendation_id=item.id,
    ).run
    engagement.transition_step(run.id, EngagementStepName.LIKE, EngagementStepState.RUNNING)
    stopped = engagement.transition_step(
        run.id,
        EngagementStepName.LIKE,
        EngagementStepState.UNCONFIRMED,
        result_code="state_unknown",
    )

    assert stopped.state is EngagementRunState.UNCONFIRMED
    with pytest.raises(ValueError, match="pending or failed"):
        engagement.transition_step(run.id, EngagementStepName.LIKE, EngagementStepState.RUNNING)
    assert engagement.list_recent(20) == (stopped,)
    for limit in (0, 51):
        with pytest.raises(ValueError, match="limit"):
            engagement.list_recent(limit)


def test_manual_completion_finishes_failed_run_and_today_queue(repositories) -> None:
    engine, recommendations, discovery, engagement, _ = repositories
    source_url = "https://blog.naver.com/candidate/998"
    item = recommendation(source_url)
    persist_recommendation(recommendations, item)
    post_id = create_post(discovery, source=DiscoverySource.NEIGHBOR, source_url=source_url)
    run = engagement.start(
        approval_id=UUID("00000000-0000-4000-8000-000000000033"),
        discovery_post_id=post_id,
        recommendation_id=item.id,
    ).run
    engagement.transition_step(run.id, EngagementStepName.LIKE, EngagementStepState.RUNNING)
    engagement.transition_step(
        run.id,
        EngagementStepName.LIKE,
        EngagementStepState.FAILED,
        result_code="not_found",
    )

    finalized = engagement.complete_manually(
        run.id,
        completed_steps=(EngagementStepName.LIKE, EngagementStepName.COMMENT),
    )

    assert finalized.state is EngagementRunState.SUCCEEDED
    assert [step.result_code for step in finalized.steps] == [
        "manual_confirmed",
        "manual_confirmed",
    ]
    assert recommendations.get(item.id).review_status is ReviewStatus.COMPLETED  # type: ignore[union-attr]
    with engine.connect() as connection:
        assert (
            connection.execute(
                select(discovered_posts.c.state).where(discovered_posts.c.id == str(post_id))
            ).scalar_one()
            == "completed"
        )


def test_manual_comment_completion_keeps_pending_mutual_neighbor_for_later_approval(
    repositories,
) -> None:
    engine, recommendations, discovery, engagement, _ = repositories
    source_url = "https://blog.naver.com/candidate/997"
    item = recommendation(source_url)
    persist_recommendation(recommendations, item)
    post_id = create_post(discovery, source=DiscoverySource.SEARCH, source_url=source_url)
    run = engagement.start(
        approval_id=UUID("00000000-0000-4000-8000-000000000034"),
        discovery_post_id=post_id,
        recommendation_id=item.id,
    ).run
    engagement.transition_step(run.id, EngagementStepName.LIKE, EngagementStepState.RUNNING)
    engagement.transition_step(
        run.id,
        EngagementStepName.LIKE,
        EngagementStepState.SUCCEEDED,
        result_code="clicked",
    )
    engagement.transition_step(run.id, EngagementStepName.COMMENT, EngagementStepState.RUNNING)
    engagement.transition_step(
        run.id,
        EngagementStepName.COMMENT,
        EngagementStepState.FAILED,
        result_code="occupied",
    )

    resumed = engagement.complete_manually(
        run.id,
        completed_steps=(EngagementStepName.COMMENT,),
    )

    assert resumed.state is EngagementRunState.RUNNING
    assert [(step.name, step.state, step.result_code) for step in resumed.steps] == [
        (EngagementStepName.LIKE, EngagementStepState.SUCCEEDED, "clicked"),
        (EngagementStepName.COMMENT, EngagementStepState.SUCCEEDED, "manual_confirmed"),
        (EngagementStepName.MUTUAL_NEIGHBOR, EngagementStepState.PENDING, None),
    ]
    assert recommendations.get(item.id).review_status is ReviewStatus.COMPLETED  # type: ignore[union-attr]
    assert (
        engagement.start(
            approval_id=UUID("00000000-0000-4000-8000-000000000035"),
            discovery_post_id=post_id,
            recommendation_id=item.id,
        ).run
        == resumed
    )
    with engine.connect() as connection:
        assert (
            connection.execute(
                select(discovered_posts.c.state).where(discovered_posts.c.id == str(post_id))
            ).scalar_one()
            == "queued"
        )


def test_start_rejects_unapproved_or_mismatched_sources(repositories) -> None:
    _, recommendations, discovery, engagement, _ = repositories
    source_url = "https://blog.naver.com/candidate/321"
    drafted = recommendation(source_url, approved=False)
    persist_recommendation(recommendations, drafted)
    post_id = create_post(discovery, source=DiscoverySource.NEIGHBOR, source_url=source_url)

    with pytest.raises(ValueError, match="approved"):
        engagement.start(
            approval_id=UUID(int=40),
            discovery_post_id=post_id,
            recommendation_id=drafted.id,
        )
    with pytest.raises(LookupError, match="not found"):
        engagement.start(
            approval_id=UUID(int=41),
            discovery_post_id=UUID(int=999),
            recommendation_id=drafted.id,
        )


def test_completed_recommendation_cannot_start_a_new_run(repositories) -> None:
    _, recommendations, discovery, engagement, _ = repositories
    source_url = "https://blog.naver.com/candidate/654"
    approved = recommendation(source_url)
    persist_recommendation(recommendations, approved)
    stored = recommendations.get(approved.id)
    assert stored is not None
    completed = stored.apply_review(
        ReviewPatch(review_status=ReviewStatus.COMPLETED),
        reviewed_at=NOW + timedelta(seconds=1),
    )
    recommendations.update(completed)
    post_id = create_post(discovery, source=DiscoverySource.NEIGHBOR, source_url=source_url)

    with pytest.raises(ValueError, match="approved"):
        engagement.start(
            approval_id=UUID(int=42),
            discovery_post_id=post_id,
            recommendation_id=completed.id,
        )
