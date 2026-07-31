"""Execute one approved engagement: like, comment, then optionally mutual neighbor.

Every action follows the same shape. A read-only probe locates the target and reports its state, and
the driver then acts with trusted browser input. Ambiguous, occupied, captcha, login, and unknown
states fail closed, and an unconfirmed submit is never clicked again automatically.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Final

from naver_blog_assistant.application.automation.errors import EngagementBlockedError
from naver_blog_assistant.application.automation.extract_article import (
    parse_supported_article_url,
)
from naver_blog_assistant.application.automation.session import BrowserSessionManager
from naver_blog_assistant.domain import EngagementStepName, EngagementStepState
from naver_blog_assistant.infrastructure.browser.page_scripts import PageScriptRunner
from naver_blog_assistant.ports.browser import BrowserOperationError, PageHandle

CONFIRMATION_ATTEMPTS: Final = 20
CONFIRMATION_INTERVAL_SECONDS: Final = 0.25
NAVIGATION_TIMEOUT_SECONDS: Final = 20.0


@dataclass(frozen=True, slots=True)
class StepOutcome:
    """Terminal state and stable result code for one external action."""

    state: EngagementStepState
    result_code: str

    @property
    def blocking(self) -> bool:
        """Return whether the run must stop after this step."""
        return self.state in {EngagementStepState.FAILED, EngagementStepState.UNCONFIRMED}


@dataclass(slots=True)
class EngagementRequest:
    """One approved post with the exact text the user reviewed."""

    url: str
    comment: str
    blog_id: str | None = None
    neighbor_message: str = ""
    steps: tuple[EngagementStepName, ...] = (
        EngagementStepName.LIKE,
        EngagementStepName.COMMENT,
    )


@dataclass(slots=True)
class EngagementProgress:
    """Ordered step outcomes observed during one run."""

    outcomes: list[tuple[EngagementStepName, StepOutcome]] = field(default_factory=list)

    def record(self, name: EngagementStepName, outcome: StepOutcome) -> None:
        """Append one terminal outcome."""
        self.outcomes.append((name, outcome))


LIKE_CODES: Final[dict[str, StepOutcome]] = {
    "already_liked": StepOutcome(EngagementStepState.SKIPPED, "already_liked"),
    "ambiguous": StepOutcome(EngagementStepState.FAILED, "ambiguous"),
    "not_found": StepOutcome(EngagementStepState.FAILED, "not_found"),
    "state_unknown": StepOutcome(EngagementStepState.FAILED, "state_unknown"),
}

COMMENT_CODES: Final[dict[str, StepOutcome]] = {
    "ambiguous": StepOutcome(EngagementStepState.FAILED, "ambiguous"),
    "not_found": StepOutcome(EngagementStepState.FAILED, "not_found"),
    "occupied": StepOutcome(EngagementStepState.FAILED, "comment_field_occupied"),
}

NEIGHBOR_RELATIONSHIP_CODES: Final[dict[str, StepOutcome]] = {
    "already_mutual": StepOutcome(EngagementStepState.SKIPPED, "already_mutual"),
    "already_neighbor": StepOutcome(EngagementStepState.SKIPPED, "already_neighbor"),
    "request_pending": StepOutcome(EngagementStepState.SKIPPED, "request_pending"),
    "request_unavailable": StepOutcome(EngagementStepState.FAILED, "request_unavailable"),
    "state_unknown": StepOutcome(EngagementStepState.FAILED, "state_unknown"),
}

STAGE_FAILURES: Final[dict[str, StepOutcome]] = {
    "ambiguous": StepOutcome(EngagementStepState.FAILED, "ambiguous"),
    "not_found": StepOutcome(EngagementStepState.FAILED, "not_found"),
    "captcha_required": StepOutcome(EngagementStepState.FAILED, "captcha_required"),
    "login_required": StepOutcome(EngagementStepState.FAILED, "login_required"),
    "state_unknown": StepOutcome(EngagementStepState.FAILED, "state_unknown"),
    "message_occupied": StepOutcome(EngagementStepState.FAILED, "message_occupied"),
}


class ExecuteEngagement:
    """Run the ordered external actions for one reviewed post."""

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
        request: EngagementRequest,
        *,
        on_start: Callable[[EngagementStepName], Awaitable[None]] | None = None,
        on_step: Callable[[EngagementStepName, StepOutcome], Awaitable[None]] | None = None,
    ) -> EngagementProgress:
        """Open the post and run each approved step until one blocks the run."""
        url = parse_supported_article_url(request.url)
        if url is None:
            raise EngagementBlockedError("unsupported_url")
        if not request.comment.strip():
            raise EngagementBlockedError("comment_missing")
        page = await self._sessions.primary_page()
        try:
            await page.goto(url, timeout_seconds=NAVIGATION_TIMEOUT_SECONDS)
        except BrowserOperationError as error:
            raise EngagementBlockedError("navigation_failed") from error

        progress = EngagementProgress()
        for name in request.steps:
            if on_start is not None:
                await on_start(name)
            outcome = await self._run_step(page, name, request)
            progress.record(name, outcome)
            if on_step is not None:
                await on_step(name, outcome)
            if outcome.blocking:
                break
        return progress

    async def _run_step(
        self, page: PageHandle, name: EngagementStepName, request: EngagementRequest
    ) -> StepOutcome:
        try:
            if name is EngagementStepName.LIKE:
                return await self._like(page)
            if name is EngagementStepName.COMMENT:
                return await self._comment(page, request.comment)
            return await self._mutual_neighbor(page, request)
        except BrowserOperationError:
            return StepOutcome(EngagementStepState.FAILED, "browser_operation_failed")

    async def _like(self, page: PageHandle) -> StepOutcome:
        probe = await self._probe(page, "probeLike")
        code = str(probe.get("code"))
        mapped = LIKE_CODES.get(code)
        if mapped is not None:
            return mapped
        selector = probe.get("selector")
        if not isinstance(selector, str):
            return StepOutcome(EngagementStepState.FAILED, "not_found")
        await page.click(selector)
        option = probe.get("optionSelector")
        selected_default = False
        for _ in range(CONFIRMATION_ATTEMPTS):
            confirmation = await self._probe(page, "probeLike")
            if confirmation.get("code") == "already_liked":
                return StepOutcome(EngagementStepState.SUCCEEDED, "liked")
            if not selected_default:
                layer = confirmation.get("optionSelector") or option
                if isinstance(layer, str):
                    await page.click(layer)
                    selected_default = True
            await self._sleep(page, CONFIRMATION_INTERVAL_SECONDS)
        return StepOutcome(EngagementStepState.UNCONFIRMED, "like_unconfirmed")

    async def _comment(self, page: PageHandle, comment: str) -> StepOutcome:
        probe = await self._probe(page, "probeComment", comment)
        code = str(probe.get("code"))
        if code == "needs_open":
            opener = probe.get("openerSelector")
            if not isinstance(opener, str):
                return StepOutcome(EngagementStepState.FAILED, "not_found")
            await page.click(opener)
            await self._sleep(page, CONFIRMATION_INTERVAL_SECONDS)
            probe = await self._probe(page, "probeComment", comment)
            code = str(probe.get("code"))
        mapped = COMMENT_CODES.get(code)
        if mapped is not None:
            return await self._diagnose_comment(page, mapped)
        editor = probe.get("editorSelector")
        submit = probe.get("submitSelector")
        if not isinstance(editor, str) or not isinstance(submit, str):
            return StepOutcome(EngagementStepState.FAILED, "not_found")
        if code == "ready":
            await page.type_text(editor, comment)
        before = await self._probe(page, "countMatchingComments", comment)
        await page.click(submit)
        return await self._confirm_comment(page, editor, comment, _as_int(before))

    async def _confirm_comment(
        self, page: PageHandle, editor: str, comment: str, before: int
    ) -> StepOutcome:
        for _ in range(CONFIRMATION_ATTEMPTS):
            published = _as_int(await self._probe(page, "countMatchingComments", comment))
            if published > before:
                return StepOutcome(EngagementStepState.SUCCEEDED, "comment_published")
            pending = await self._probe(page, "commentStillPending", editor, comment)
            if pending is False:
                return StepOutcome(EngagementStepState.SUCCEEDED, "comment_published")
            if await self._probe(page, "captchaVisible") is True:
                return StepOutcome(EngagementStepState.FAILED, "captcha_required")
            await self._sleep(page, CONFIRMATION_INTERVAL_SECONDS)
        return StepOutcome(EngagementStepState.UNCONFIRMED, "comment_unconfirmed")

    async def _diagnose_comment(self, page: PageHandle, mapped: StepOutcome) -> StepOutcome:
        if mapped.result_code not in {"not_found", "ambiguous"}:
            return mapped
        diagnosis = await self._probe(page, "diagnoseCommentPage")
        if diagnosis.get("captcha") is True:
            return StepOutcome(EngagementStepState.FAILED, "captcha_required")
        if diagnosis.get("loginRequired") is True:
            return StepOutcome(EngagementStepState.FAILED, "login_required")
        if diagnosis.get("blocked") is True:
            return StepOutcome(EngagementStepState.FAILED, "comment_blocked")
        return mapped

    async def _mutual_neighbor(self, page: PageHandle, request: EngagementRequest) -> StepOutcome:
        message = request.neighbor_message.strip()
        if not message:
            return StepOutcome(EngagementStepState.FAILED, "neighbor_message_missing")
        relationship = await self._probe(page, "probeNeighborRelationship")
        state = str(relationship.get("state"))
        mapped = NEIGHBOR_RELATIONSHIP_CODES.get(state)
        if mapped is not None:
            return mapped
        author = relationship.get("blogId")
        expected = (request.blog_id or "").strip().lower()
        if expected and isinstance(author, str) and author.strip().lower() != expected:
            return StepOutcome(EngagementStepState.FAILED, "author_mismatch")
        entry = relationship.get("entrySelector")
        if state != "can_request" or not isinstance(entry, str):
            return StepOutcome(EngagementStepState.FAILED, "state_unknown")
        await page.click(entry)
        await self._sleep(page, CONFIRMATION_INTERVAL_SECONDS)

        option = await self._probe(page, "probeNeighborOption")
        option_code = str(option.get("code"))
        failure = STAGE_FAILURES.get(option_code)
        if failure is not None:
            return failure
        option_selector = option.get("optionSelector")
        next_selector = option.get("nextSelector")
        if not isinstance(next_selector, str):
            return StepOutcome(EngagementStepState.FAILED, "not_found")
        if option_code == "ready" and isinstance(option_selector, str):
            await page.click(option_selector)
        await page.click(next_selector)
        await self._sleep(page, CONFIRMATION_INTERVAL_SECONDS)

        application = await self._probe(page, "probeNeighborApplication", message)
        application_code = str(application.get("code"))
        failure = STAGE_FAILURES.get(application_code)
        if failure is not None:
            return failure
        if application_code != "ready":
            return StepOutcome(EngagementStepState.FAILED, "state_unknown")
        group_selector = application.get("groupSelector")
        if application.get("groupNeedsSelection") is True and isinstance(group_selector, str):
            option_value = application.get("groupOptionValue")
            if application.get("groupKind") == "select" and isinstance(option_value, str):
                await page.select_option(group_selector, option_value)
            else:
                await page.click(group_selector)
        message_selector = application.get("messageSelector")
        submit_selector = application.get("nextSelector")
        if not isinstance(message_selector, str) or not isinstance(submit_selector, str):
            return StepOutcome(EngagementStepState.FAILED, "not_found")
        await page.type_text(message_selector, message)
        await page.click(submit_selector)
        return await self._confirm_neighbor(page)

    async def _confirm_neighbor(self, page: PageHandle) -> StepOutcome:
        for _ in range(CONFIRMATION_ATTEMPTS):
            confirmation = await self._probe(page, "probeNeighborConfirmation")
            diagnosis = confirmation.get("diagnosis")
            if isinstance(diagnosis, str):
                return StepOutcome(EngagementStepState.FAILED, diagnosis)
            if confirmation.get("confirmed") is True:
                close = confirmation.get("closeSelector")
                if isinstance(close, str):
                    await page.click(close)
                return StepOutcome(EngagementStepState.SUCCEEDED, "neighbor_requested")
            await self._sleep(page, CONFIRMATION_INTERVAL_SECONDS)
        return StepOutcome(EngagementStepState.UNCONFIRMED, "neighbor_unconfirmed")

    async def _probe(self, page: PageHandle, name: str, *args: Any) -> Any:
        result = await self._scripts.call(page, name, *args)
        return result if result is not None else {}

    async def _sleep(self, page: PageHandle, seconds: float) -> None:
        if self._pause is not None:
            await self._pause(seconds)
            return
        await page.wait(seconds)


def _as_int(value: object) -> int:
    """Return a non-negative integer for an untrusted page value."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return max(value, 0)
    return 0
