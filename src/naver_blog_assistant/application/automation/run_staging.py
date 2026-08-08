"""Run one staging job and stream its step progress.

The stream lifecycle follows the same rules as engagement runs: an unknown run yields nothing, a
finished run yields one snapshot, an idle stream sends keepalives, and every stream stops at a
deadline. A leftover running step becomes unconfirmed before any new action.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID

from naver_blog_assistant.application.automation.run_engagement import RunChannel, RunEvent
from naver_blog_assistant.application.automation.stage_post import (
    StagePost,
    StagingBlockedError,
    StagingRequest,
    staging_request,
)
from naver_blog_assistant.domain.publishing import PublishRun, PublishStepName, PublishStepState
from naver_blog_assistant.domain.writing import DraftStatus, PostDraft, body_tags

logger = logging.getLogger("naver_blog_assistant.api")
INTERRUPTED_RESULT_CODE = "interrupted_before_confirmation"
KEEPALIVE_SECONDS = 15.0
STREAM_DEADLINE_SECONDS = 900.0
RETAINED_CHANNELS = 8


class PublishRunStore(Protocol):
    """The subset of the staging repository this orchestrator needs."""

    def start(self, *, draft_id: UUID, revision_id: UUID) -> PublishRun: ...

    def for_revision(self, draft_id: UUID, revision_id: UUID) -> PublishRun | None: ...

    def get(self, run_id: UUID) -> PublishRun: ...

    def transition_step(
        self,
        run_id: UUID,
        name: PublishStepName,
        state: PublishStepState,
        *,
        result_code: str | None = None,
    ) -> PublishRun: ...

    def resolve_interrupted(self, run_id: UUID, *, result_code: str) -> PublishRun: ...


class DraftReader(Protocol):
    """Read one draft and record its status."""

    def get(self, draft_id: UUID) -> PostDraft: ...

    def update_draft(
        self,
        draft_id: UUID,
        *,
        title: str | None = None,
        category_no: int | None = None,
        status: DraftStatus | None = None,
        use_image_vision: bool | None = None,
    ) -> PostDraft: ...


def run_snapshot(run: PublishRun) -> dict[str, Any]:
    """Return the current state of one staging run as a streamable payload."""
    return {
        "run_id": str(run.id),
        "draft_id": str(run.draft_id),
        "state": run.state.value,
        "steps": [
            {"step": step.name.value, "state": step.state.value, "result_code": step.result_code}
            for step in run.steps
        ],
    }


@dataclass(frozen=True, slots=True)
class StagingApproval:
    """One persisted run plus the request it will execute."""

    run: PublishRun
    request: StagingRequest


class StagePostService:
    """Start, execute, and stream one staging run."""

    def __init__(
        self,
        *,
        runs: PublishRunStore,
        drafts: DraftReader,
        stage: StagePost,
        owner_blog_id: Callable[[], str],
        media_root: Path,
        body_tag_cap: Callable[[], int],
        keepalive_seconds: float = KEEPALIVE_SECONDS,
        stream_deadline_seconds: float = STREAM_DEADLINE_SECONDS,
        retained_channels: int = RETAINED_CHANNELS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if keepalive_seconds <= 0 or stream_deadline_seconds <= 0 or retained_channels < 1:
            raise ValueError("stream timing and retention settings must be positive")
        self._runs = runs
        self._drafts = drafts
        self._stage = stage
        self._owner_blog_id = owner_blog_id
        self._media_root = media_root
        self._body_tag_cap = body_tag_cap
        self._keepalive_seconds = keepalive_seconds
        self._stream_deadline_seconds = stream_deadline_seconds
        self._retained_channels = retained_channels
        self._monotonic = monotonic
        self._channels: dict[UUID, RunChannel] = {}
        self._retired: list[UUID] = []
        self._tasks: set[asyncio.Task[None]] = set()

    def prepare(self, draft_id: UUID) -> StagingApproval:
        """Validate the draft and return the persisted run plus its request."""
        draft = self._drafts.get(draft_id)
        revision = draft.active_revision
        if revision is None:
            raise StagingBlockedError("no_active_revision")
        request = staging_request(
            draft,
            blog_id=self._owner_blog_id(),
            tags=body_tags(draft.tags, cap=max(0, self._body_tag_cap())),
            media_root=self._media_root,
        )
        run = self._runs.start(draft_id=draft_id, revision_id=revision.id)
        run = self._runs.resolve_interrupted(run.id, result_code=INTERRUPTED_RESULT_CODE)
        request.steps = run.pending_steps
        self._drafts.update_draft(draft_id, status=DraftStatus.STAGING)
        return StagingApproval(run=run, request=request)

    def run_id_for(self, draft_id: UUID) -> UUID | None:
        """Return the run bound to the draft's active revision, or None."""
        try:
            draft = self._drafts.get(draft_id)
        except LookupError:
            return None
        revision = draft.active_revision
        if revision is None:
            return None
        existing = self._runs.for_revision(draft_id, revision.id)
        return None if existing is None else existing.id

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
        """Yield events for one run, always terminating."""
        try:
            run = self._runs.get(run_id)
        except LookupError:
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

    async def run(self, run_id: UUID, request: StagingRequest) -> PublishRun | None:
        """Execute the run, publishing one event per step."""
        channel = self.open_channel(run_id)
        try:
            if not request.steps:
                channel.publish(
                    RunEvent("run_skipped", {"run_id": str(run_id), "code": "no_pending_steps"})
                )
                return self._runs.get(run_id)
            channel.publish(RunEvent("run_started", {"run_id": str(run_id)}))

            async def on_start(name: PublishStepName) -> None:
                self._runs.transition_step(run_id, name, PublishStepState.RUNNING)

            async def on_step(name: PublishStepName, outcome: Any) -> None:
                self._runs.transition_step(
                    run_id, name, outcome.state, result_code=outcome.result_code
                )
                payload: dict[str, Any] = {
                    "run_id": str(run_id),
                    "step": name.value,
                    "state": outcome.state.value,
                    "result_code": outcome.result_code,
                }
                if outcome.detail is not None:
                    payload["detail"] = outcome.detail
                channel.publish(
                    RunEvent(
                        "step_completed",
                        payload,
                    )
                )

            await self._stage.execute(request, on_start=on_start, on_step=on_step)
            run = self._runs.get(run_id)
            if run.state.value == "succeeded":
                self._drafts.update_draft(run.draft_id, status=DraftStatus.STAGED)
            channel.publish(
                RunEvent("run_finished", {"run_id": str(run_id), "state": run.state.value})
            )
            return run
        except StagingBlockedError as error:
            channel.publish(RunEvent("run_failed", {"run_id": str(run_id), "code": error.code}))
            return self._safe_get(run_id)
        except Exception:  # noqa: BLE001 - the stream must always close
            logger.exception("staging_run_failed")
            channel.publish(
                RunEvent("run_failed", {"run_id": str(run_id), "code": "internal_error"})
            )
            return self._safe_get(run_id)
        finally:
            channel.close()
            self._retire(run_id)

    def start_background(self, run_id: UUID, request: StagingRequest) -> None:
        """Execute one run without blocking the request that approved it."""
        self.open_channel(run_id)
        task = asyncio.create_task(self._background(run_id, request))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def has_active_tasks(self) -> bool:
        """Report whether a staging coroutine is still using the automation browser."""
        return any(not task.done() for task in self._tasks)

    async def _background(self, run_id: UUID, request: StagingRequest) -> None:
        await self.run(run_id, request)

    def _safe_get(self, run_id: UUID) -> PublishRun | None:
        try:
            return self._runs.get(run_id)
        except LookupError:  # pragma: no cover - the run exists by construction
            return None

    def _retire(self, run_id: UUID) -> None:
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
