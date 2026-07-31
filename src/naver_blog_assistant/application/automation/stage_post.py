"""Stage one composed draft in the Naver editor and stop at the saved draft.

Probes locate the editor; every click, keystroke, and file attachment uses trusted browser input.
Publishing is never automated. The run finishes when the draft is saved and a person decides
whether to publish it.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from naver_blog_assistant.application.automation.errors import AutomationError
from naver_blog_assistant.application.automation.session import BrowserSessionManager
from naver_blog_assistant.domain.publishing import (
    PUBLISH_STEP_ORDER,
    PublishStepName,
    PublishStepState,
)
from naver_blog_assistant.domain.writing import BlockKind, BodyBlock, DraftImage, PostDraft
from naver_blog_assistant.infrastructure.browser.page_scripts import PageScriptRunner
from naver_blog_assistant.ports.browser import BrowserOperationError, PageHandle

EDITOR_URL = "https://blog.naver.com/{blog_id}?Redirect=Write"
NAVIGATION_TIMEOUT_SECONDS: Final = 30.0
CONFIRMATION_ATTEMPTS: Final = 20
CONFIRMATION_INTERVAL_SECONDS: Final = 0.25


class StagingBlockedError(AutomationError):
    """Raised with a stable code when a staging run cannot start at all."""

    CODES = frozenset(
        {
            "blog_id_missing",
            "no_active_revision",
            "navigation_failed",
            "editor_not_found",
            "editor_ambiguous",
            "login_required",
            "restore_prompt_unresolved",
        }
    )

    def __init__(self, code: str) -> None:
        if code not in self.CODES:
            raise ValueError(f"{code} is not a known staging block code")
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class StepOutcome:
    """Terminal state and stable code for one editor action."""

    state: PublishStepState
    result_code: str

    @property
    def blocking(self) -> bool:
        """Report whether the run must stop after this step."""
        return self.state in {PublishStepState.FAILED, PublishStepState.UNCONFIRMED}


@dataclass(slots=True)
class StagingRequest:
    """Everything one staging run needs, resolved before the browser opens."""

    blog_id: str
    title: str
    blocks: tuple[BodyBlock, ...]
    images: tuple[DraftImage, ...]
    tags: tuple[str, ...]
    media_root: Path
    steps: tuple[PublishStepName, ...] = PUBLISH_STEP_ORDER


@dataclass(slots=True)
class StagingProgress:
    """Ordered step outcomes observed during one run."""

    outcomes: list[tuple[PublishStepName, StepOutcome]]

    def record(self, name: PublishStepName, outcome: StepOutcome) -> None:
        """Append one terminal outcome."""
        self.outcomes.append((name, outcome))


def staging_request(
    draft: PostDraft, *, blog_id: str, tags: Sequence[str], media_root: Path
) -> StagingRequest:
    """Build the request for one draft, refusing a draft with nothing to stage."""
    owner = blog_id.strip()
    if not owner:
        raise StagingBlockedError("blog_id_missing")
    revision = draft.active_revision
    if revision is None:
        raise StagingBlockedError("no_active_revision")
    return StagingRequest(
        blog_id=owner,
        title=revision.title,
        blocks=revision.blocks,
        images=draft.images,
        tags=tuple(tags),
        media_root=media_root,
    )


class StagePost:
    """Fill the editor and save the draft, one step at a time."""

    def __init__(
        self,
        sessions: BrowserSessionManager,
        *,
        scripts: PageScriptRunner | None = None,
        pause: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        self._sessions = sessions
        self._scripts = scripts if scripts is not None else PageScriptRunner()
        self._pause = pause

    async def execute(
        self,
        request: StagingRequest,
        *,
        on_start: Callable[[PublishStepName], Awaitable[None]] | None = None,
        on_step: Callable[[PublishStepName, StepOutcome], Awaitable[None]] | None = None,
    ) -> StagingProgress:
        """Open the editor and run each step until one blocks the run."""
        page = await self._sessions.primary_page()
        try:
            await page.goto(
                EDITOR_URL.format(blog_id=request.blog_id),
                timeout_seconds=NAVIGATION_TIMEOUT_SECONDS,
            )
        except BrowserOperationError as error:
            raise StagingBlockedError("navigation_failed") from error
        probe = await self._ready_editor(page)

        progress = StagingProgress(outcomes=[])
        for name in request.steps:
            if on_start is not None:
                await on_start(name)
            outcome = await self._run_step(page, name, request, probe)
            progress.record(name, outcome)
            if on_step is not None:
                await on_step(name, outcome)
            if outcome.blocking:
                break
        return progress

    async def _ready_editor(self, page: PageHandle) -> dict[str, Any]:
        """Resolve the restore prompt once, then require a usable editor."""
        probe = await self._probe(page, "probeEditor")
        if str(probe.get("stage")) == "restore_prompt":
            cancel = probe.get("restoreCancelSelector")
            if not isinstance(cancel, str):
                raise StagingBlockedError("restore_prompt_unresolved")
            await page.click(cancel)
            await self._sleep(page, CONFIRMATION_INTERVAL_SECONDS)
            probe = await self._probe(page, "probeEditor")
        stage = str(probe.get("stage"))
        if stage == "ready":
            return probe
        if stage == "login_required":
            raise StagingBlockedError("login_required")
        if stage == "ambiguous":
            raise StagingBlockedError("editor_ambiguous")
        raise StagingBlockedError("editor_not_found")

    async def _run_step(
        self,
        page: PageHandle,
        name: PublishStepName,
        request: StagingRequest,
        probe: dict[str, Any],
    ) -> StepOutcome:
        try:
            if name is PublishStepName.TITLE:
                return await self._fill(page, probe.get("titleSelector"), request.title, "title")
            if name is PublishStepName.BODY:
                return await self._body(page, probe, request)
            if name is PublishStepName.IMAGES:
                return await self._images(page, probe, request)
            if name is PublishStepName.TAGS:
                return await self._tags(page, probe, request)
            return await self._save(page, probe)
        except BrowserOperationError:
            return StepOutcome(PublishStepState.FAILED, "browser_operation_failed")

    async def _fill(self, page: PageHandle, selector: Any, text: str, code: str) -> StepOutcome:
        if not isinstance(selector, str):
            return StepOutcome(PublishStepState.FAILED, "not_found")
        await page.type_text(selector, text)
        observed = await self._probe(page, "readEditorText", selector)
        if isinstance(observed, str) and observed.strip() == text.strip():
            return StepOutcome(PublishStepState.SUCCEEDED, f"{code}_filled")
        return StepOutcome(PublishStepState.UNCONFIRMED, f"{code}_unconfirmed")

    async def _body(
        self, page: PageHandle, probe: dict[str, Any], request: StagingRequest
    ) -> StepOutcome:
        selector = probe.get("bodySelector")
        if not isinstance(selector, str):
            return StepOutcome(PublishStepState.FAILED, "not_found")
        text = body_text(request.blocks)
        if not text:
            return StepOutcome(PublishStepState.FAILED, "body_empty")
        return await self._fill(page, selector, text, "body")

    async def _images(
        self, page: PageHandle, probe: dict[str, Any], request: StagingRequest
    ) -> StepOutcome:
        referenced = [
            image
            for image in request.images
            if any(block.image_id == image.id for block in request.blocks)
        ]
        if not referenced:
            return StepOutcome(PublishStepState.SKIPPED, "no_images")
        selector = probe.get("imageInputSelector")
        if not isinstance(selector, str):
            return StepOutcome(PublishStepState.FAILED, "image_input_not_found")
        paths: list[str] = []
        for image in referenced:
            path = (request.media_root / image.stored_path).resolve()
            if not path.is_file():
                return StepOutcome(PublishStepState.FAILED, "image_file_missing")
            paths.append(str(path))
        await page.set_input_files(selector, paths)
        await self._sleep(page, CONFIRMATION_INTERVAL_SECONDS)
        return StepOutcome(PublishStepState.SUCCEEDED, "images_attached")

    async def _tags(
        self, page: PageHandle, probe: dict[str, Any], request: StagingRequest
    ) -> StepOutcome:
        if not request.tags:
            return StepOutcome(PublishStepState.SKIPPED, "no_tags")
        selector = probe.get("bodySelector")
        if not isinstance(selector, str):
            return StepOutcome(PublishStepState.FAILED, "not_found")
        await page.type_text(selector, tag_text(request.tags))
        return StepOutcome(PublishStepState.SUCCEEDED, "tags_appended")

    async def _save(self, page: PageHandle, probe: dict[str, Any]) -> StepOutcome:
        selector = probe.get("saveSelector")
        if not isinstance(selector, str):
            return StepOutcome(PublishStepState.FAILED, "not_found")
        before = await self._probe(page, "probeEditorSave")
        baseline = _as_int(before.get("savedCount"))
        await page.click(selector)
        for _ in range(CONFIRMATION_ATTEMPTS):
            confirmation = await self._probe(page, "probeEditorSave")
            diagnosis = confirmation.get("diagnosis")
            if isinstance(diagnosis, str):
                return StepOutcome(PublishStepState.FAILED, diagnosis)
            observed = _as_int(confirmation.get("savedCount"))
            if observed > baseline:
                return StepOutcome(PublishStepState.SUCCEEDED, "draft_saved")
            await self._sleep(page, CONFIRMATION_INTERVAL_SECONDS)
        return StepOutcome(PublishStepState.UNCONFIRMED, "save_unconfirmed")

    async def _probe(self, page: PageHandle, name: str, *args: Any) -> Any:
        result = await self._scripts.call(page, name, *args)
        return result if result is not None else {}

    async def _sleep(self, page: PageHandle, seconds: float) -> None:
        if self._pause is not None:
            await self._pause(seconds)
            return
        await page.wait(seconds)


def body_text(blocks: tuple[BodyBlock, ...]) -> str:
    """Render the block body as the plain text the editor receives."""
    lines: list[str] = []
    for block in blocks:
        if block.kind is BlockKind.IMAGE:
            if block.caption:
                lines.append(block.caption)
            continue
        if block.kind is BlockKind.QUOTE:
            lines.append(f"“{block.text}”")
            continue
        lines.append(block.text)
    return "\n\n".join(line for line in lines if line)


def tag_text(tags: Sequence[str]) -> str:
    """Render the tags as the body tag input expects them."""
    return "\n\n" + " ".join(f"#{tag}" for tag in tags)


def _as_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(value, 0)


__all__ = [
    "StagePost",
    "StagingBlockedError",
    "StagingProgress",
    "StagingRequest",
    "StepOutcome",
    "body_text",
    "staging_request",
    "tag_text",
]
