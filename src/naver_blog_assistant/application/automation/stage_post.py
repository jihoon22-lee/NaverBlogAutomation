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
    detail: dict[str, int] | None = None

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
    # A revision is an intentional checkpoint.  The canvas, however, saves its
    # current blocks independently so staging must use that newest confirmed
    # working copy rather than silently reverting to the last checkpoint.
    working_copy = draft.working_copy
    return StagingRequest(
        blog_id=owner,
        title=working_copy.title if working_copy is not None else revision.title,
        blocks=working_copy.blocks if working_copy is not None else revision.blocks,
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
            return _body_outcome(PublishStepState.FAILED, "not_found", request)
        root_selector = probe.get("editorRootSelector", selector)
        if not isinstance(root_selector, str):
            return _body_outcome(PublishStepState.FAILED, "editor_root_not_found", request)
        if not request.blocks:
            return _body_outcome(PublishStepState.FAILED, "no_body_blocks", request)

        # Resolve every image before mutating the editor.  A broken media reference must not leave
        # a partial document behind merely because it happened late in the requested block order.
        images = {image.id: image for image in request.images}
        referenced_images = [block for block in request.blocks if block.kind is BlockKind.IMAGE]
        if len(images) != len(request.images):
            return _body_outcome(PublishStepState.FAILED, "duplicate_image_reference", request)
        for block in referenced_images:
            if block.image_id not in images:
                return _body_outcome(PublishStepState.FAILED, "image_reference_missing", request)
            image = images[block.image_id]
            path = (request.media_root / image.stored_path).resolve()
            if not path.is_file() or request.media_root.resolve() not in path.parents:
                return _body_outcome(PublishStepState.FAILED, "image_file_missing", request)

        # Clear exactly once, then use toolbar click + trusted key input for every individual block.
        # This is intentionally not a text rendering fallback: absence of the required control stops
        # the run before Save, even if the editor would happen to display similar plain text.
        await page.type_text(selector, "")
        expected: list[BodyBlock] = []
        for index, block in enumerate(request.blocks):
            if index > 0:
                await page.press_key(selector, "Enter")
            outcome = await self._append_block(
                page, probe, selector, block, images, request.media_root.resolve()
            )
            if outcome is not None:
                return _body_outcome(
                    outcome.state, outcome.result_code, request, observed_prefix_count=len(expected)
                )
            expected.append(block)
            observed = await self._probe(page, "readEditorBlocks", root_selector)
            if not isinstance(observed, list):
                return _body_outcome(
                    PublishStepState.FAILED,
                    f"block_{index + 1}_unsupported_editor_structure",
                    request,
                    observed_prefix_count=len(expected),
                )
            if not _blocks_match(tuple(expected), observed):
                return _body_outcome(
                    PublishStepState.UNCONFIRMED,
                    f"block_{index + 1}_order_unconfirmed",
                    request,
                    observed_prefix_count=index,
                )
        return _body_outcome(
            PublishStepState.SUCCEEDED,
            f"blocks_staged_{len(expected)}",
            request,
            observed_prefix_count=len(expected),
        )

    async def _append_block(
        self,
        page: PageHandle,
        probe: dict[str, Any],
        body_selector: str,
        block: BodyBlock,
        images: dict[Any, DraftImage],
        media_root: Path,
    ) -> StepOutcome | None:
        """Perform the one trusted action sequence for one canonical body block."""
        if block.kind is BlockKind.IMAGE:
            input_selector = probe.get("imageInputSelector")
            if not isinstance(input_selector, str):
                return StepOutcome(PublishStepState.FAILED, "image_input_not_found")
            image = images.get(block.image_id)
            if image is None:
                return StepOutcome(PublishStepState.FAILED, "image_reference_missing")
            # The current caret belongs to the preceding block action.  Do not click the editor
            # root here: a click can move the caret to a visually convenient but semantically wrong
            # location.  The subsequent semantic prefix check proves the attachment's position.
            image_path = str((media_root / image.stored_path).resolve())
            await page.set_input_files(input_selector, [image_path])
            await self._sleep(page, CONFIRMATION_INTERVAL_SECONDS)
            if block.caption:
                refreshed = await self._probe(page, "probeEditor")
                caption_selector = (
                    refreshed.get("imageCaptionSelector") if isinstance(refreshed, dict) else None
                )
                if not isinstance(caption_selector, str):
                    return StepOutcome(PublishStepState.FAILED, "image_caption_control_not_found")
                await page.type_text(caption_selector, block.caption)
            return None

        if block.kind is not BlockKind.PARAGRAPH:
            actions = probe.get("blockActionSelectors")
            selector = actions.get(block.kind.value) if isinstance(actions, dict) else None
            if not isinstance(selector, str):
                return StepOutcome(
                    PublishStepState.FAILED, f"block_{block.kind.value}_control_not_found"
                )
            await page.click(selector)

        if block.kind is BlockKind.DIVIDER:
            return None
        if block.kind in {BlockKind.ORDERED_LIST, BlockKind.UNORDERED_LIST}:
            await page.append_text(body_selector, "\n".join(block.items))
            return None
        await page.append_text(body_selector, block.text)
        return None

    async def _images(
        self, page: PageHandle, probe: dict[str, Any], request: StagingRequest
    ) -> StepOutcome:
        del page, probe
        if not any(block.kind is BlockKind.IMAGE for block in request.blocks):
            return StepOutcome(PublishStepState.SKIPPED, "no_images")
        # Image attachment happens at its requested body index inside `_body`; separating it into
        # a later append-only pass would destroy that ordering guarantee.
        return StepOutcome(PublishStepState.SUCCEEDED, "images_staged_with_blocks")

    async def _tags(
        self, page: PageHandle, probe: dict[str, Any], request: StagingRequest
    ) -> StepOutcome:
        if not request.tags:
            return StepOutcome(PublishStepState.SKIPPED, "no_tags")
        selector = probe.get("tagInputSelector")
        if not isinstance(selector, str):
            return StepOutcome(PublishStepState.FAILED, "tag_input_not_found")
        for tag in request.tags:
            await page.append_text(selector, tag)
            await page.press_key(selector, "Enter")
        return StepOutcome(PublishStepState.SUCCEEDED, "tags_staged")

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


def _body_outcome(
    state: PublishStepState,
    result_code: str,
    request: StagingRequest,
    *,
    observed_prefix_count: int = 0,
) -> StepOutcome:
    """Describe body verification without exposing block text or image identifiers to SSE."""
    return StepOutcome(
        state,
        result_code,
        detail={
            "requested_range_start": 1,
            "requested_range_end": len(request.blocks),
            "observed_prefix_count": max(0, observed_prefix_count),
        },
    )


def _blocks_match(expected: tuple[BodyBlock, ...], observed: list[Any]) -> bool:
    """Compare only explicit semantic fields, never guessed presentation details."""
    if len(expected) != len(observed):
        return False
    for block, snapshot in zip(expected, observed, strict=True):
        if not isinstance(snapshot, dict) or snapshot.get("type") != block.kind.value:
            return False
        if block.kind in {BlockKind.HEADING, BlockKind.PARAGRAPH, BlockKind.QUOTE}:
            if snapshot.get("text") != block.text:
                return False
        elif block.kind in {BlockKind.ORDERED_LIST, BlockKind.UNORDERED_LIST}:
            if snapshot.get("items") != list(block.items):
                return False
        elif block.kind is BlockKind.IMAGE and snapshot.get("caption", "") != block.caption:
            # The Naver DOM does not expose our private image UUID.  Position and caption still
            # prove that the requested image block survived at this point in the sequence.
            return False
    return True


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
