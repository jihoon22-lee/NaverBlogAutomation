"""Event stream lifecycle for one engagement run.

Every scenario is bounded: an unknown run yields nothing, a finished run yields one snapshot, an
idle live stream emits a keepalive, and a stream that outlives its deadline stops on its own. The
clock is injected so none of these tests wait on real time.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest

from naver_blog_assistant.application.automation.errors import (
    EngagementBlockedError,
    EngagementNotAllowedError,
)
from naver_blog_assistant.application.automation.execute_engagement import EngagementRequest
from naver_blog_assistant.application.automation.run_engagement import (
    EngagementRunService,
    RunEvent,
    run_snapshot,
)
from naver_blog_assistant.domain import (
    DEFAULT_GENERATION_PREFERENCES,
    AppSettingKind,
    CandidateTone,
    CommentCandidate,
    DiscoveredPost,
    DiscoverySource,
    DiscoveryState,
    EngagementRun,
    EngagementRunState,
    EngagementStep,
    EngagementStepName,
    EngagementStepState,
    Recommendation,
    ReviewPatch,
    ReviewStatus,
)

RUN_ID = UUID("11111111-1111-1111-1111-111111111111")


def _run(state: EngagementRunState = EngagementRunState.RUNNING) -> EngagementRun:
    now = datetime(2026, 7, 31, 10, 0, tzinfo=UTC)
    return EngagementRun(
        id=RUN_ID,
        approval_id=uuid4(),
        discovery_post_id=uuid4(),
        recommendation_id=uuid4(),
        source=DiscoverySource.NEIGHBOR,
        state=state,
        steps=(
            EngagementStep(
                name=EngagementStepName.LIKE,
                position=0,
                state=EngagementStepState.SKIPPED,
                result_code="already_liked",
                updated_at=now,
            ),
            EngagementStep(
                name=EngagementStepName.COMMENT,
                position=1,
                state=EngagementStepState.PENDING,
                result_code=None,
                updated_at=now,
            ),
        ),
        created_at=now,
        updated_at=now,
    )


class _Engagements:
    """Records step transitions and answers `get` with the stored run."""

    def __init__(self, run: EngagementRun | None) -> None:
        self.run = run
        self.transitions: list[tuple[EngagementStepName, EngagementStepState, str | None]] = []

    def start(self, **_: Any) -> Any:  # pragma: no cover - unused by these tests
        raise AssertionError("start is not used")

    def transition_step(
        self,
        run_id: UUID,
        step_name: EngagementStepName,
        state: EngagementStepState,
        *,
        result_code: str | None = None,
    ) -> EngagementRun:
        del run_id
        self.transitions.append((step_name, state, result_code))
        if self.run is None:  # pragma: no cover - guarded by the tests that use this
            raise AssertionError("no run is stored")
        return self.run

    def get(self, run_id: UUID) -> EngagementRun | None:
        return self.run if self.run is not None and self.run.id == run_id else None


class _Clock:
    """A monotonic clock that advances by a fixed step on every read."""

    def __init__(self, step: float = 0.0) -> None:
        self.now = 0.0
        self.step = step

    def __call__(self) -> float:
        current = self.now
        self.now += self.step
        return current


class _Discovery:
    """These tests never resolve a queued post."""

    def get_post(self, post_id: UUID) -> None:  # pragma: no cover - unused by these tests
        del post_id
        return None


class _Recommendations:
    """These tests never read a recommendation."""

    def execute(self, recommendation_id: UUID) -> Any:  # pragma: no cover - unused
        raise AssertionError(f"recommendation {recommendation_id} must not be read")


class _Executor:
    """These tests never execute browser actions."""

    async def execute(self, request: Any, **_: Any) -> Any:  # pragma: no cover - unused
        raise AssertionError(f"{request} must not be executed")


def _service(
    run: EngagementRun | None,
    *,
    keepalive_seconds: float = 0.01,
    stream_deadline_seconds: float = 60.0,
    retained_channels: int = 2,
    monotonic: _Clock | None = None,
) -> EngagementRunService:
    return EngagementRunService(
        engagements=_Engagements(run),
        discovery=_Discovery(),
        recommendations=_Recommendations(),
        execute=_Executor(),
        read_setting=lambda _kind: None,
        keepalive_seconds=keepalive_seconds,
        stream_deadline_seconds=stream_deadline_seconds,
        retained_channels=retained_channels,
        monotonic=monotonic or _Clock(),
    )


async def _collect(service: EngagementRunService, run_id: UUID, limit: int = 20) -> list[RunEvent]:
    events: list[RunEvent] = []
    async for event in service.events(run_id):
        events.append(event)
        if len(events) >= limit:
            break
    return events


def test_invalid_stream_timing_is_rejected() -> None:
    with pytest.raises(ValueError, match="positive"):
        _service(_run(), keepalive_seconds=0)
    with pytest.raises(ValueError, match="positive"):
        _service(_run(), stream_deadline_seconds=0)
    with pytest.raises(ValueError, match="positive"):
        _service(_run(), retained_channels=0)


def test_an_unknown_run_yields_no_events() -> None:
    service = _service(None)

    events = asyncio.run(_collect(service, uuid4()))

    assert events == []


def test_subscribing_to_an_unknown_run_does_not_create_a_channel() -> None:
    service = _service(None)

    asyncio.run(_collect(service, RUN_ID))

    assert service.live_channel(RUN_ID) is None


def test_a_run_without_a_channel_yields_one_snapshot() -> None:
    run = _run()
    service = _service(run)

    events = asyncio.run(_collect(service, RUN_ID))

    assert [event.event for event in events] == ["run_snapshot"]
    assert events[0].payload == run_snapshot(run)
    assert events[0].payload["steps"][0]["result_code"] == "already_liked"


def test_a_finished_channel_replays_its_history_and_closes() -> None:
    service = _service(_run())
    channel = service.open_channel(RUN_ID)
    channel.publish(RunEvent("run_started", {"run_id": str(RUN_ID)}))
    channel.publish(RunEvent("run_finished", {"run_id": str(RUN_ID)}))
    channel.close()

    events = asyncio.run(_collect(service, RUN_ID))

    assert [event.event for event in events] == ["run_started", "run_finished"]


def test_a_live_channel_delivers_events_published_after_subscribing() -> None:
    service = _service(_run())
    channel = service.open_channel(RUN_ID)

    async def scenario() -> list[RunEvent]:
        received: list[RunEvent] = []

        async def publish_then_close() -> None:
            await asyncio.sleep(0)
            channel.publish(RunEvent("step_completed", {"step": "comment"}))
            channel.close()

        task = asyncio.create_task(publish_then_close())
        async with asyncio.timeout(5):
            async for event in service.events(RUN_ID):
                received.append(event)
        await task
        return received

    events = asyncio.run(scenario())

    assert [event.event for event in events] == ["step_completed"]


def test_an_idle_live_stream_emits_a_keepalive() -> None:
    service = _service(_run(), keepalive_seconds=0.01)
    service.open_channel(RUN_ID)

    async def scenario() -> list[RunEvent]:
        received: list[RunEvent] = []
        async with asyncio.timeout(5):
            async for event in service.events(RUN_ID):
                received.append(event)
                if len(received) == 2:
                    break
        return received

    events = asyncio.run(scenario())

    assert [event.event for event in events] == ["keepalive", "keepalive"]


def test_a_stream_stops_at_its_deadline() -> None:
    clock = _Clock(step=6.0)
    service = _service(
        _run(), keepalive_seconds=0.01, stream_deadline_seconds=10.0, monotonic=clock
    )
    service.open_channel(RUN_ID)

    async def scenario() -> list[RunEvent]:
        async with asyncio.timeout(5):
            return [event async for event in service.events(RUN_ID)]

    events = asyncio.run(scenario())

    assert [event.event for event in events] == ["keepalive", "stream_deadline"]


def test_an_abandoned_stream_stops_receiving_events() -> None:
    service = _service(_run(), keepalive_seconds=0.01)
    channel = service.open_channel(RUN_ID)
    channel.publish(RunEvent("run_started", {}))

    async def scenario() -> int:
        stream = service.events(RUN_ID)
        async with asyncio.timeout(5):
            await anext(stream)
            await stream.aclose()
        return len(channel.queues)

    remaining = asyncio.run(scenario())

    assert remaining == 0


def test_reopening_a_channel_after_it_finished_drops_the_old_history() -> None:
    service = _service(_run())
    first = service.open_channel(RUN_ID)
    first.publish(RunEvent("run_started", {}))
    first.close()

    second = service.open_channel(RUN_ID)

    assert second is not first
    assert second.history == []


def test_retained_channels_are_evicted_in_order() -> None:
    service = _service(_run(), retained_channels=2)
    ids = [uuid4() for _ in range(3)]
    for run_id in ids:
        service.open_channel(run_id)
        service.open_channel(run_id).close()
        service._retire(run_id)  # noqa: SLF001 - retirement is internal to the service

    assert service.live_channel(ids[0]) is None
    assert service.live_channel(ids[1]) is not None
    assert service.live_channel(ids[2]) is not None


def test_shutdown_closes_every_open_channel() -> None:
    service = _service(_run())
    channel = service.open_channel(RUN_ID)

    asyncio.run(service.shutdown())

    assert channel.finished is True


class _FailingExecutor:
    """Raises the configured error instead of touching a browser."""

    def __init__(self, error: BaseException) -> None:
        self.error = error

    async def execute(self, request: Any, **_: Any) -> Any:
        del request
        raise self.error


def _service_with_executor(executor: Any, run: EngagementRun | None = None) -> EngagementRunService:
    return EngagementRunService(
        engagements=_Engagements(run if run is not None else _run()),
        discovery=_Discovery(),
        recommendations=_Recommendations(),
        execute=executor,
        read_setting=lambda _kind: None,
        keepalive_seconds=0.01,
        retained_channels=2,
    )


def _request() -> EngagementRequest:
    return EngagementRequest(url="https://blog.naver.com/example/223456789012", comment="댓글")


def test_a_blocked_run_reports_its_code_and_closes_the_stream() -> None:
    service = _service_with_executor(_FailingExecutor(EngagementBlockedError("navigation_failed")))

    async def scenario() -> tuple[list[RunEvent], bool]:
        async with asyncio.timeout(5):
            await service.run(RUN_ID, _request())
            events = [event async for event in service.events(RUN_ID)]
        channel = service.live_channel(RUN_ID)
        assert channel is not None
        return events, channel.finished

    events, finished = asyncio.run(scenario())

    assert [event.event for event in events] == ["run_started", "run_failed"]
    assert events[-1].payload["code"] == "navigation_failed"
    assert finished is True


def test_an_unexpected_error_closes_the_stream_with_an_internal_code() -> None:
    service = _service_with_executor(_FailingExecutor(RuntimeError("boom")))

    async def scenario() -> list[RunEvent]:
        async with asyncio.timeout(5):
            await service.run(RUN_ID, _request())
            return [event async for event in service.events(RUN_ID)]

    events = asyncio.run(scenario())

    assert [event.event for event in events] == ["run_started", "run_failed"]
    assert events[-1].payload["code"] == "internal_error"


def test_a_run_without_pending_steps_is_skipped_and_closed() -> None:
    service = _service_with_executor(_Executor())

    async def scenario() -> list[RunEvent]:
        async with asyncio.timeout(5):
            await service.run(RUN_ID, EngagementRequest(url="x", comment="c", steps=()))
            return [event async for event in service.events(RUN_ID)]

    events = asyncio.run(scenario())

    assert [event.event for event in events] == ["run_skipped"]
    assert events[0].payload["code"] == "no_pending_steps"


def test_a_background_run_closes_its_stream_by_shutdown() -> None:
    service = _service_with_executor(_FailingExecutor(EngagementBlockedError("comment_missing")))

    async def scenario() -> bool:
        async with asyncio.timeout(5):
            service.start_background(RUN_ID, _request())
            await service.shutdown()
        channel = service.live_channel(RUN_ID)
        assert channel is not None
        return channel.finished

    assert asyncio.run(scenario()) is True


def test_retiring_the_same_run_twice_keeps_one_entry() -> None:
    service = _service(_run(), retained_channels=1)
    other = uuid4()
    service.open_channel(RUN_ID)
    service._retire(RUN_ID)  # noqa: SLF001 - retirement is internal to the service
    service._retire(RUN_ID)  # noqa: SLF001 - retirement is internal to the service
    service.open_channel(other)
    service._retire(other)  # noqa: SLF001 - retirement is internal to the service

    assert service.live_channel(RUN_ID) is None
    assert service.live_channel(other) is not None


NOW = datetime(2026, 7, 31, 10, 0, tzinfo=UTC)
POST_ID = UUID("22222222-2222-4222-8222-222222222222")
RECOMMENDATION_ID = UUID("33333333-3333-4333-8333-333333333333")


def _post() -> DiscoveredPost:
    return DiscoveredPost(
        id=POST_ID,
        source=DiscoverySource.NEIGHBOR,
        state=DiscoveryState.QUEUED,
        source_url="https://blog.naver.com/example/223456789012",
        title="합성 전시 후기",
        publisher_name="합성 이웃",
        publisher_blog_id="example",
        published_at=NOW,
        neighbor_id=uuid4(),
        search_id=None,
        created_at=NOW,
        updated_at=NOW,
    )


def _recommendation(*, edited_comment: str | None) -> Recommendation:
    drafted = Recommendation(
        id=RECOMMENDATION_ID,
        source_url="https://blog.naver.com/example/223456789012",
        title="합성 전시 후기",
        content_hash="c" * 64,
        excerpt="합성 본문 일부",
        summary="합성 요약",
        topics=("전시",),
        candidates=tuple(
            CommentCandidate(
                id=UUID(f"00000000-0000-4000-8000-{index:012d}"),
                tone=tone,
                comment=f"{tone.value} 댓글",
                referenced_detail=f"{tone.value} 근거",
            )
            for index, tone in enumerate(CandidateTone, start=40)
        ),
        review_status=ReviewStatus.DRAFTED,
        created_at=NOW,
        preferences=DEFAULT_GENERATION_PREFERENCES,
    )
    approved = drafted.apply_review(
        ReviewPatch(selected_candidate_index=0, review_status=ReviewStatus.APPROVED),
        reviewed_at=NOW,
    )
    if edited_comment is None:
        return approved
    return approved.apply_review(ReviewPatch(edited_comment=edited_comment), reviewed_at=NOW)


@dataclass(frozen=True)
class _Setting:
    payload: dict[str, Any]


@dataclass(frozen=True)
class _Started:
    run: EngagementRun


class _PostReader:
    def get_post(self, post_id: UUID) -> DiscoveredPost | None:
        return _post() if post_id == POST_ID else None


class _StoredRecommendation:
    def __init__(self, item: Recommendation) -> None:
        self.item = item

    def execute(self, recommendation_id: UUID) -> Recommendation:
        assert recommendation_id == self.item.id
        return self.item


def _settings(kind: AppSettingKind) -> _Setting:
    if kind is AppSettingKind.AUTOMATION_CONSENT:
        return _Setting({"accepted": True, "consent_version": 1})
    return _Setting({"message": "서로이웃 신청합니다."})


class _StartingEngagements(_Engagements):
    def start(self, **_: Any) -> _Started:
        assert self.run is not None
        return _Started(run=self.run)


def _prepare_service(
    run: EngagementRun, recommendation: Recommendation
) -> tuple[EngagementRunService, _StartingEngagements]:
    engagements = _StartingEngagements(run)
    service = EngagementRunService(
        engagements=engagements,
        discovery=_PostReader(),
        recommendations=_StoredRecommendation(recommendation),
        execute=_Executor(),
        read_setting=_settings,
    )
    return service, engagements


def test_an_approved_recommendation_without_an_edited_comment_is_refused() -> None:
    service, _ = _prepare_service(_run(), _recommendation(edited_comment=None))

    with pytest.raises(EngagementNotAllowedError) as error:
        service.prepare(discovery_post_id=POST_ID, recommendation_id=RECOMMENDATION_ID)

    assert error.value.code == "comment_missing"


def test_a_leftover_running_step_becomes_unconfirmed_before_new_actions() -> None:
    interrupted = _run_with_running_like()
    service, engagements = _prepare_service(
        interrupted, _recommendation(edited_comment="합성 댓글입니다.")
    )

    _run_record, request = service.prepare(
        discovery_post_id=POST_ID, recommendation_id=RECOMMENDATION_ID
    )

    assert engagements.transitions == [
        (
            EngagementStepName.LIKE,
            EngagementStepState.UNCONFIRMED,
            "interrupted_before_confirmation",
        )
    ]
    assert request.steps == (EngagementStepName.COMMENT,)
    assert request.neighbor_message == "서로이웃 신청합니다."


def _run_with_running_like() -> EngagementRun:
    now = datetime(2026, 7, 31, 10, 0, tzinfo=UTC)
    return EngagementRun(
        id=RUN_ID,
        approval_id=uuid4(),
        discovery_post_id=POST_ID,
        recommendation_id=RECOMMENDATION_ID,
        source=DiscoverySource.NEIGHBOR,
        state=EngagementRunState.RUNNING,
        steps=(
            EngagementStep(
                name=EngagementStepName.LIKE,
                position=0,
                state=EngagementStepState.RUNNING,
                result_code=None,
                updated_at=now,
            ),
            EngagementStep(
                name=EngagementStepName.COMMENT,
                position=1,
                state=EngagementStepState.PENDING,
                result_code=None,
                updated_at=now,
            ),
        ),
        created_at=now,
        updated_at=now,
    )
