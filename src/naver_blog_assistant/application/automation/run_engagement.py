"""Persist and stream one approved engagement run.

The run reuses the existing `engagement_runs` records. A leftover `running` step from an
interrupted process is converted to `unconfirmed` before any new action, so an unknown external
result is never retried automatically.

Event streams never wait forever. Subscribing to a run that does not exist yields nothing, a run
that already finished yields one snapshot, an idle live stream emits keepalives, and every stream
stops at a deadline. Closed channels are retired so the process does not accumulate them.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Final, Protocol
from uuid import UUID, uuid4

from naver_blog_assistant.application.automation.errors import (
    EngagementBlockedError,
    EngagementNotAllowedError,
)
from naver_blog_assistant.application.automation.execute_engagement import (
    EngagementProgress,
    EngagementRequest,
    StepOutcome,
)
from naver_blog_assistant.domain import (
    AppSettingKind,
    DiscoveredPost,
    EngagementRun,
    EngagementStepName,
    EngagementStepState,
    Recommendation,
    ReviewStatus,
)

logger = logging.getLogger("naver_blog_assistant.api")
INTERRUPTED_RESULT_CODE: Final = "interrupted_before_confirmation"
KEEPALIVE_SECONDS: Final = 15.0
STREAM_DEADLINE_SECONDS: Final = 900.0
RETAINED_CHANNELS: Final = 8


class EngagementRepository(Protocol):
    """Subset of the engagement store this orchestrator needs."""

    def start(
        self, *, approval_id: UUID, discovery_post_id: UUID, recommendation_id: UUID
    ) -> Any: ...

    def transition_step(
        self,
        run_id: UUID,
        step_name: EngagementStepName,
        state: EngagementStepState,
        *,
        result_code: str | None = None,
    ) -> EngagementRun: ...

    def get(self, run_id: UUID) -> EngagementRun | None: ...


class DiscoveryReader(Protocol):
    """Subset of the discovery store this orchestrator needs."""

    def get_post(self, post_id: UUID) -> DiscoveredPost | None: ...


class RecommendationReader(Protocol):
    """Read one stored recommendation."""

    def execute(self, recommendation_id: UUID) -> Recommendation: ...


class EngagementExecutor(Protocol):
    """Run the approved external actions for one post."""

    async def execute(
        self,
        request: EngagementRequest,
        *,
        on_start: Callable[[EngagementStepName], Awaitable[None]] | None = None,
        on_step: Callable[[EngagementStepName, StepOutcome], Awaitable[None]] | None = None,
    ) -> EngagementProgress: ...


@dataclass(slots=True)
class RunEvent:
    """One streamed progress event."""

    event: str
    payload: dict[str, Any]


@dataclass(slots=True)
class RunChannel:
    """Fan-out queue for one run's events."""

    queues: list[asyncio.Queue[RunEvent | None]] = field(default_factory=list)
    history: list[RunEvent] = field(default_factory=list)
    finished: bool = False

    def subscribe(self) -> asyncio.Queue[RunEvent | None]:
        """Return a queue seeded with the events published so far."""
        queue: asyncio.Queue[RunEvent | None] = asyncio.Queue()
        for event in self.history:
            queue.put_nowait(event)
        if self.finished:
            queue.put_nowait(None)
        else:
            self.queues.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[RunEvent | None]) -> None:
        """Drop one subscriber so an abandoned stream stops receiving events."""
        if queue in self.queues:
            self.queues.remove(queue)

    def publish(self, event: RunEvent) -> None:
        """Record and forward one event."""
        self.history.append(event)
        for queue in self.queues:
            queue.put_nowait(event)

    def close(self) -> None:
        """Signal that no further events will arrive."""
        self.finished = True
        for queue in self.queues:
            queue.put_nowait(None)
        self.queues.clear()


def run_snapshot(run: EngagementRun) -> dict[str, Any]:
    """Return the current state of one run as a streamable payload."""
    return {
        "run_id": str(run.id),
        "state": run.state.value,
        "steps": [
            {
                "step": step.name.value,
                "state": step.state.value,
                "result_code": step.result_code,
            }
            for step in run.steps
        ],
    }


class EngagementRunService:
    """Start, execute, and stream one approved engagement run."""

    def __init__(
        self,
        *,
        engagements: EngagementRepository,
        discovery: DiscoveryReader,
        recommendations: RecommendationReader,
        execute: EngagementExecutor,
        read_setting: Callable[[AppSettingKind], Any],
        keepalive_seconds: float = KEEPALIVE_SECONDS,
        stream_deadline_seconds: float = STREAM_DEADLINE_SECONDS,
        retained_channels: int = RETAINED_CHANNELS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if keepalive_seconds <= 0 or stream_deadline_seconds <= 0 or retained_channels < 1:
            raise ValueError("stream timing and retention settings must be positive")
        self._engagements = engagements
        self._discovery = discovery
        self._recommendations = recommendations
        self._execute = execute
        self._read_setting = read_setting
        self._keepalive_seconds = keepalive_seconds
        self._stream_deadline_seconds = stream_deadline_seconds
        self._retained_channels = retained_channels
        self._monotonic = monotonic
        self._channels: dict[UUID, RunChannel] = {}
        self._retired: list[UUID] = []
        self._tasks: set[asyncio.Task[None]] = set()

    def open_channel(self, run_id: UUID) -> RunChannel:
        """Return a live channel for one run, replacing a finished one."""
        channel = self._channels.get(run_id)
        if channel is not None and not channel.finished:
            return channel
        if channel is not None:
            self._forget(run_id)
        fresh = RunChannel()
        self._channels[run_id] = fresh
        return fresh

    def live_channel(self, run_id: UUID) -> RunChannel | None:
        """Return the retained channel for one run without creating it."""
        return self._channels.get(run_id)

    async def events(self, run_id: UUID) -> AsyncGenerator[RunEvent]:
        """Yield events for one run, always terminating.

        An unknown run yields nothing. A run without a retained channel yields one snapshot. A
        live stream yields recorded and future events, a keepalive while idle, and stops at the
        stream deadline.
        """
        run = self._engagements.get(run_id)
        if run is None:
            return
        channel = self._channels.get(run_id)
        if channel is None:
            yield RunEvent("run_snapshot", run_snapshot(run))
            return
        queue = channel.subscribe()
        deadline = self._monotonic() + self._stream_deadline_seconds
        try:
            while True:
                if self._monotonic() >= deadline:
                    yield RunEvent("stream_deadline", {"run_id": str(run_id)})
                    return
                try:
                    async with asyncio.timeout(self._keepalive_seconds):
                        event = await queue.get()
                except TimeoutError:
                    yield RunEvent("keepalive", {"run_id": str(run_id)})
                    continue
                if event is None:
                    return
                yield event
        finally:
            channel.unsubscribe(queue)

    def prepare(
        self, *, discovery_post_id: UUID, recommendation_id: UUID
    ) -> tuple[EngagementRun, EngagementRequest]:
        """Validate the approval and return the persisted run plus the action request."""
        post = self._discovery.get_post(discovery_post_id)
        if post is None:
            raise EngagementNotAllowedError("post_not_found")
        recommendation = self._recommendations.execute(recommendation_id)
        if recommendation.review_status is ReviewStatus.DRAFTED:
            raise EngagementNotAllowedError("recommendation_not_approved")
        comment = recommendation.edited_comment or ""
        if not comment.strip():
            raise EngagementNotAllowedError("comment_missing")
        consent = self._read_setting(AppSettingKind.AUTOMATION_CONSENT).payload
        if consent.get("accepted") is not True:
            raise EngagementNotAllowedError("consent_missing")
        started = self._engagements.start(
            approval_id=uuid4(),
            discovery_post_id=discovery_post_id,
            recommendation_id=recommendation_id,
        )
        run = self._resolve_interrupted(started.run)
        message = str(
            self._read_setting(AppSettingKind.NEIGHBOR_MESSAGE).payload.get("message") or ""
        )
        request = EngagementRequest(
            url=post.source_url,
            comment=comment,
            blog_id=post.publisher_blog_id,
            neighbor_message=message,
            steps=self._pending_steps(run),
        )
        return run, request

    def _resolve_interrupted(self, run: EngagementRun) -> EngagementRun:
        current = run
        for step in run.steps:
            if step.state is EngagementStepState.RUNNING:
                current = self._engagements.transition_step(
                    run.id,
                    step.name,
                    EngagementStepState.UNCONFIRMED,
                    result_code=INTERRUPTED_RESULT_CODE,
                )
        return current

    def _pending_steps(self, run: EngagementRun) -> tuple[EngagementStepName, ...]:
        return tuple(step.name for step in run.steps if step.state is EngagementStepState.PENDING)

    async def run(self, run_id: UUID, request: EngagementRequest) -> EngagementRun | None:
        """Execute the run, publishing one event per step."""
        channel = self.open_channel(run_id)
        try:
            if not request.steps:
                channel.publish(
                    RunEvent("run_skipped", {"run_id": str(run_id), "code": "no_pending_steps"})
                )
                return self._engagements.get(run_id)
            channel.publish(RunEvent("run_started", {"run_id": str(run_id)}))

            async def on_step(name: EngagementStepName, outcome: StepOutcome) -> None:
                self._engagements.transition_step(
                    run_id, name, outcome.state, result_code=outcome.result_code
                )
                channel.publish(
                    RunEvent(
                        "step_completed",
                        {
                            "run_id": str(run_id),
                            "step": name.value,
                            "state": outcome.state.value,
                            "result_code": outcome.result_code,
                        },
                    )
                )

            async def on_start(name: EngagementStepName) -> None:
                self._engagements.transition_step(run_id, name, EngagementStepState.RUNNING)

            progress = await self._execute.execute(request, on_start=on_start, on_step=on_step)
            run = self._engagements.get(run_id)
            channel.publish(
                RunEvent(
                    "run_finished",
                    {
                        "run_id": str(run_id),
                        "state": "unknown" if run is None else run.state.value,
                        "steps": len(progress.outcomes),
                    },
                )
            )
            return run
        except EngagementBlockedError as error:
            channel.publish(RunEvent("run_failed", {"run_id": str(run_id), "code": error.code}))
            return self._engagements.get(run_id)
        except Exception:  # noqa: BLE001 - the stream must always close
            logger.exception("engagement_run_failed")
            channel.publish(
                RunEvent("run_failed", {"run_id": str(run_id), "code": "internal_error"})
            )
            return self._engagements.get(run_id)
        finally:
            channel.close()
            self._retire(run_id)

    def start_background(self, run_id: UUID, request: EngagementRequest) -> None:
        """Execute one run without blocking the request that approved it."""
        self.open_channel(run_id)
        task = asyncio.create_task(self._background(run_id, request))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _background(self, run_id: UUID, request: EngagementRequest) -> None:
        await self.run(run_id, request)

    def _retire(self, run_id: UUID) -> None:
        """Keep a bounded number of finished channels for late subscribers."""
        if run_id in self._retired:
            self._retired.remove(run_id)
        self._retired.append(run_id)
        while len(self._retired) > self._retained_channels:
            self._forget(self._retired[0])

    def _forget(self, run_id: UUID) -> None:
        self._channels.pop(run_id, None)
        if run_id in self._retired:
            self._retired.remove(run_id)

    async def shutdown(self) -> None:
        """Wait for in-flight runs and release every open stream."""
        if self._tasks:
            await asyncio.gather(*tuple(self._tasks), return_exceptions=True)
        for channel in tuple(self._channels.values()):
            channel.close()
