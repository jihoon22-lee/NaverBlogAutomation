"""Scenario coverage for the single-post engagement engine.

Every action is verified twice: the probe result decides the outcome code, and the recorded trusted
input proves the engine clicked or typed exactly what the probe reported.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from naver_blog_assistant.application.automation import (
    BrowserSessionManager,
    EngagementBlockedError,
    EngagementRequest,
    ExecuteEngagement,
    StepOutcome,
)
from naver_blog_assistant.domain import EngagementStepName, EngagementStepState
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver, PageScriptRunner
from naver_blog_assistant.infrastructure.browser.fake import FakePage
from naver_blog_assistant.infrastructure.browser.page_scripts import _CALL_EXPRESSION

POST_URL = "https://blog.naver.com/example/223456789012"
COMMENT = "합성 댓글입니다."
MESSAGE = "합성 서로이웃 신청 메시지입니다."
BUNDLE = "globalThis.__nbaPage = { version: 1 };"

LIKE_READY = {"code": "ready", "selector": "#like", "optionSelector": None, "liked": False}
LIKE_DONE = {"code": "already_liked", "selector": "#like", "optionSelector": None, "liked": True}
COMMENT_READY = {
    "code": "ready",
    "editorSelector": "#editor",
    "submitSelector": "#submit",
    "openerSelector": None,
    "state": "empty",
}
CLEAN_DIAGNOSIS = {"blocked": False, "captcha": False, "loginRequired": False}
NEIGHBOR_CAN_REQUEST = {"state": "can_request", "entrySelector": "#entry", "candidateCount": 1}
NEIGHBOR_OPTION_READY = {
    "code": "ready",
    "optionSelector": "#mutual",
    "nextSelector": "#next1",
    "mutualSelected": False,
}
NEIGHBOR_APPLICATION_READY = {
    "code": "ready",
    "groupKind": "none",
    "groupNeedsSelection": False,
    "groupOptionValue": None,
    "groupSelector": None,
    "messageSelector": "#message",
    "nextSelector": "#next2",
}
NEIGHBOR_CONFIRMED = {"confirmed": True, "closeSelector": "#close", "diagnosis": None}
NEIGHBOR_PENDING = {"confirmed": False, "closeSelector": None, "diagnosis": None}


class ScriptedPage(FakePage):
    """Fake page whose probe answers can change per call."""

    def __init__(self, script: dict[str, list[Any]]) -> None:
        super().__init__()
        self.script = script
        self.probe_calls: list[tuple[str, tuple[Any, ...]]] = []

    async def evaluate(self, expression: str, argument: Any = None) -> Any:
        if expression == _CALL_EXPRESSION and isinstance(argument, dict):
            name = str(argument["name"])
            args = tuple(argument["args"])
            self.probe_calls.append((name, args))
            answers = self.script.get(name)
            if answers is None:
                return {"installed": True, "value": None}
            value = answers[0] if len(answers) == 1 else answers.pop(0)
            return {"installed": True, "value": value}
        return await super().evaluate(expression, argument)


def engine(script: dict[str, list[Any]]) -> tuple[ExecuteEngagement, ScriptedPage]:
    """Return an engine whose session serves one scripted page."""
    page = ScriptedPage(script)
    driver = FakeBrowserDriver()
    sessions = BrowserSessionManager(driver, profile_dir=Path("/profiles"), headless=True)

    async def prepared() -> ExecuteEngagement:
        await sessions.launch()
        context = driver.contexts[0]
        context.open_tabs.clear()
        context.open_tabs.append(page)
        return ExecuteEngagement(
            sessions, scripts=PageScriptRunner(BUNDLE), pause=lambda _: asyncio.sleep(0)
        )

    return asyncio.run(prepared()), page


def run(
    script: dict[str, list[Any]],
    *,
    steps: tuple[EngagementStepName, ...] = (
        EngagementStepName.LIKE,
        EngagementStepName.COMMENT,
    ),
    comment: str = COMMENT,
    message: str = "",
    url: str = POST_URL,
    blog_id: str | None = None,
) -> tuple[list[tuple[EngagementStepName, StepOutcome]], ScriptedPage]:
    execute, page = engine(script)
    request = EngagementRequest(
        url=url, comment=comment, blog_id=blog_id, neighbor_message=message, steps=steps
    )
    progress = asyncio.run(execute.execute(request))
    return progress.outcomes, page


def codes(outcomes: list[tuple[EngagementStepName, StepOutcome]]) -> list[str]:
    return [outcome.result_code for _, outcome in outcomes]


def states(outcomes: list[tuple[EngagementStepName, StepOutcome]]) -> list[EngagementStepState]:
    return [outcome.state for _, outcome in outcomes]


def successful_script(**overrides: list[Any]) -> dict[str, list[Any]]:
    script: dict[str, list[Any]] = {
        "probeLike": [LIKE_READY, LIKE_DONE],
        "probeComment": [COMMENT_READY],
        "countMatchingComments": [0, 1],
        "commentStillPending": [True],
        "captchaVisible": [False],
        "diagnoseCommentPage": [CLEAN_DIAGNOSIS],
    }
    script.update(overrides)
    return script


class TestPreconditions:
    @pytest.mark.parametrize(
        "url", ["https://cafe.naver.com/example/1", "http://blog.naver.com/x/1", "not-a-url"]
    )
    def test_an_unsupported_url_blocks_the_run(self, url: str) -> None:
        with pytest.raises(EngagementBlockedError) as error:
            run(successful_script(), url=url)
        assert error.value.code == "unsupported_url"

    @pytest.mark.parametrize("comment", ["", "   "])
    def test_a_blank_comment_blocks_the_run(self, comment: str) -> None:
        with pytest.raises(EngagementBlockedError) as error:
            run(successful_script(), comment=comment)
        assert error.value.code == "comment_missing"

    def test_a_navigation_failure_blocks_the_run(self) -> None:
        execute, page = engine(successful_script())
        page.navigation_failure = "net::ERR_ABORTED"

        with pytest.raises(EngagementBlockedError) as error:
            asyncio.run(execute.execute(EngagementRequest(url=POST_URL, comment=COMMENT)))
        assert error.value.code == "navigation_failed"

    def test_unknown_block_codes_are_rejected(self) -> None:
        with pytest.raises(ValueError, match="not a known engagement block code"):
            EngagementBlockedError("nope")


class TestLike:
    def test_a_ready_control_is_clicked_and_confirmed(self) -> None:
        outcomes, page = run(successful_script())

        assert codes(outcomes)[0] == "liked"
        assert states(outcomes)[0] is EngagementStepState.SUCCEEDED
        assert page.clicks[0] == "#like"

    def test_an_already_liked_post_is_skipped_without_clicking(self) -> None:
        outcomes, page = run(successful_script(probeLike=[LIKE_DONE]))

        assert codes(outcomes)[0] == "already_liked"
        assert states(outcomes)[0] is EngagementStepState.SKIPPED
        assert "#like" not in page.clicks

    @pytest.mark.parametrize(
        ("code", "expected"),
        [
            ("ambiguous", "ambiguous"),
            ("not_found", "not_found"),
            ("state_unknown", "state_unknown"),
        ],
    )
    def test_unclear_controls_fail_closed(self, code: str, expected: str) -> None:
        outcomes, page = run(successful_script(probeLike=[{"code": code, "selector": None}]))

        assert codes(outcomes) == [expected]
        assert page.clicks == []

    def test_a_missing_selector_fails_closed(self) -> None:
        outcomes, page = run(successful_script(probeLike=[{"code": "ready", "selector": None}]))

        assert codes(outcomes) == ["not_found"]
        assert page.clicks == []

    def test_a_reaction_layer_default_option_is_selected_once(self) -> None:
        script = successful_script(
            probeLike=[
                {"code": "ready", "selector": "#like", "optionSelector": "#option"},
                {"code": "ready", "selector": "#like", "optionSelector": "#option"},
                LIKE_DONE,
            ]
        )

        outcomes, page = run(script)

        assert codes(outcomes)[0] == "liked"
        assert page.clicks.count("#option") == 1

    def test_a_control_that_never_confirms_is_unconfirmed(self) -> None:
        outcomes, page = run(successful_script(probeLike=[LIKE_READY]))

        assert codes(outcomes) == ["like_unconfirmed"]
        assert states(outcomes) == [EngagementStepState.UNCONFIRMED]
        assert page.clicks.count("#like") == 1

    def test_a_blocked_like_stops_the_run_before_the_comment(self) -> None:
        outcomes, page = run(successful_script(probeLike=[{"code": "ambiguous"}]))

        assert len(outcomes) == 1
        assert page.typed == []

    def test_a_trusted_click_failure_is_reported(self) -> None:
        execute, page = engine(successful_script())
        page.action_failures["#like"] = "element detached"

        progress = asyncio.run(execute.execute(EngagementRequest(url=POST_URL, comment=COMMENT)))

        assert codes(progress.outcomes) == ["browser_operation_failed"]


class TestComment:
    def test_the_approved_comment_is_typed_and_submitted(self) -> None:
        outcomes, page = run(successful_script())

        assert codes(outcomes)[1] == "comment_published"
        assert page.typed == [("#editor", COMMENT)]
        assert "#submit" in page.clicks

    def test_a_closed_editor_is_opened_first(self) -> None:
        script = successful_script(
            probeComment=[
                {"code": "needs_open", "openerSelector": "#open", "editorSelector": None},
                COMMENT_READY,
            ]
        )

        outcomes, page = run(script)

        assert codes(outcomes)[1] == "comment_published"
        assert page.clicks.count("#open") == 1

    def test_a_missing_opener_fails_closed(self) -> None:
        script = successful_script(probeComment=[{"code": "needs_open", "openerSelector": None}])

        outcomes, _ = run(script)

        assert codes(outcomes)[1] == "not_found"

    def test_an_already_filled_editor_is_not_retyped(self) -> None:
        script = successful_script(
            probeComment=[{**COMMENT_READY, "code": "already_filled", "state": "matching"}]
        )

        outcomes, page = run(script)

        assert codes(outcomes)[1] == "comment_published"
        assert page.typed == []

    def test_an_occupied_editor_fails_closed(self) -> None:
        script = successful_script(
            probeComment=[{**COMMENT_READY, "code": "occupied", "state": "occupied"}]
        )

        outcomes, page = run(script)

        assert codes(outcomes)[1] == "comment_field_occupied"
        assert page.typed == []

    def test_an_ambiguous_editor_fails_closed(self) -> None:
        outcomes, _ = run(successful_script(probeComment=[{"code": "ambiguous"}]))

        assert codes(outcomes)[1] == "ambiguous"

    def test_a_missing_submit_control_fails_closed(self) -> None:
        script = successful_script(probeComment=[{**COMMENT_READY, "submitSelector": None}])

        outcomes, _ = run(script)

        assert codes(outcomes)[1] == "not_found"

    def test_a_captcha_page_is_reported_instead_of_not_found(self) -> None:
        script = successful_script(
            probeComment=[{"code": "not_found"}],
            diagnoseCommentPage=[{**CLEAN_DIAGNOSIS, "captcha": True}],
        )

        outcomes, _ = run(script)

        assert codes(outcomes)[1] == "captcha_required"

    def test_a_login_page_is_reported_instead_of_not_found(self) -> None:
        script = successful_script(
            probeComment=[{"code": "not_found"}],
            diagnoseCommentPage=[{**CLEAN_DIAGNOSIS, "loginRequired": True}],
        )

        outcomes, _ = run(script)

        assert codes(outcomes)[1] == "login_required"

    def test_a_comment_block_notice_is_reported(self) -> None:
        script = successful_script(
            probeComment=[{"code": "not_found"}],
            diagnoseCommentPage=[{**CLEAN_DIAGNOSIS, "blocked": True}],
        )

        outcomes, _ = run(script)

        assert codes(outcomes)[1] == "comment_blocked"

    def test_a_cleared_editor_counts_as_published(self) -> None:
        script = successful_script(countMatchingComments=[0, 0], commentStillPending=[False])

        outcomes, _ = run(script)

        assert codes(outcomes)[1] == "comment_published"

    def test_a_rendered_captcha_after_submit_fails_closed(self) -> None:
        script = successful_script(
            countMatchingComments=[0, 0],
            commentStillPending=[True],
            captchaVisible=[True],
        )

        outcomes, _ = run(script)

        assert codes(outcomes)[1] == "captcha_required"

    def test_a_zero_sized_captcha_placeholder_does_not_fail_the_step(self) -> None:
        script = successful_script(countMatchingComments=[0, 1], captchaVisible=[False])

        outcomes, _ = run(script)

        assert codes(outcomes)[1] == "comment_published"

    def test_an_unconfirmed_submit_is_not_clicked_again(self) -> None:
        script = successful_script(
            countMatchingComments=[0, 0], commentStillPending=[True], captchaVisible=[False]
        )

        outcomes, page = run(script)

        assert codes(outcomes)[1] == "comment_unconfirmed"
        assert page.clicks.count("#submit") == 1


class TestMutualNeighbor:
    def default_steps(self) -> tuple[EngagementStepName, ...]:
        return (
            EngagementStepName.LIKE,
            EngagementStepName.COMMENT,
            EngagementStepName.MUTUAL_NEIGHBOR,
        )

    def neighbor_script(self, **overrides: list[Any]) -> dict[str, list[Any]]:
        script = successful_script(
            probeNeighborRelationship=[NEIGHBOR_CAN_REQUEST],
            probeNeighborOption=[NEIGHBOR_OPTION_READY],
            probeNeighborApplication=[NEIGHBOR_APPLICATION_READY],
            probeNeighborConfirmation=[NEIGHBOR_CONFIRMED],
        )
        script.update(overrides)
        return script

    def test_the_full_popup_flow_is_completed(self) -> None:
        outcomes, page = run(self.neighbor_script(), steps=self.default_steps(), message=MESSAGE)

        assert codes(outcomes)[2] == "neighbor_requested"
        assert page.typed[-1] == ("#message", MESSAGE)
        for selector in ("#entry", "#mutual", "#next1", "#next2", "#close"):
            assert selector in page.clicks

    def test_a_missing_message_fails_before_any_click(self) -> None:
        outcomes, page = run(self.neighbor_script(), steps=self.default_steps(), message="  ")

        assert codes(outcomes)[2] == "neighbor_message_missing"
        assert "#entry" not in page.clicks

    def test_a_different_author_fails_before_any_click(self) -> None:
        script = self.neighbor_script(
            probeNeighborRelationship=[{**NEIGHBOR_CAN_REQUEST, "blogId": "someone_else"}]
        )

        outcomes, page = run(script, steps=self.default_steps(), message=MESSAGE, blog_id="example")

        assert codes(outcomes)[2] == "author_mismatch"
        assert "#entry" not in page.clicks

    def test_the_expected_author_is_matched_case_insensitively(self) -> None:
        script = self.neighbor_script(
            probeNeighborRelationship=[{**NEIGHBOR_CAN_REQUEST, "blogId": "Example"}]
        )

        outcomes, _ = run(script, steps=self.default_steps(), message=MESSAGE, blog_id=" example ")

        assert codes(outcomes)[2] == "neighbor_requested"

    def test_an_unreported_author_does_not_block_the_request(self) -> None:
        script = self.neighbor_script(
            probeNeighborRelationship=[{**NEIGHBOR_CAN_REQUEST, "blogId": None}]
        )

        outcomes, _ = run(script, steps=self.default_steps(), message=MESSAGE, blog_id="example")

        assert codes(outcomes)[2] == "neighbor_requested"

    @pytest.mark.parametrize(
        ("state", "expected", "expected_state"),
        [
            ("already_mutual", "already_mutual", EngagementStepState.SKIPPED),
            ("already_neighbor", "already_neighbor", EngagementStepState.SKIPPED),
            ("request_pending", "request_pending", EngagementStepState.SKIPPED),
            ("request_unavailable", "request_unavailable", EngagementStepState.FAILED),
            ("state_unknown", "state_unknown", EngagementStepState.FAILED),
        ],
    )
    def test_existing_relationships_skip_or_fail(
        self, state: str, expected: str, expected_state: EngagementStepState
    ) -> None:
        outcomes, page = run(
            self.neighbor_script(probeNeighborRelationship=[{"state": state}]),
            steps=self.default_steps(),
            message=MESSAGE,
        )

        assert codes(outcomes)[2] == expected
        assert states(outcomes)[2] is expected_state
        assert "#entry" not in page.clicks

    def test_a_missing_entry_selector_fails_closed(self) -> None:
        outcomes, _ = run(
            self.neighbor_script(
                probeNeighborRelationship=[{"state": "can_request", "entrySelector": None}]
            ),
            steps=self.default_steps(),
            message=MESSAGE,
        )

        assert codes(outcomes)[2] == "state_unknown"

    @pytest.mark.parametrize(
        "code", ["ambiguous", "not_found", "captcha_required", "login_required", "state_unknown"]
    )
    def test_stage_one_failures_are_reported(self, code: str) -> None:
        outcomes, page = run(
            self.neighbor_script(probeNeighborOption=[{"code": code}]),
            steps=self.default_steps(),
            message=MESSAGE,
        )

        assert codes(outcomes)[2] == code
        assert "#next1" not in page.clicks

    def test_an_already_selected_option_is_not_clicked_again(self) -> None:
        outcomes, page = run(
            self.neighbor_script(
                probeNeighborOption=[
                    {**NEIGHBOR_OPTION_READY, "code": "already_selected", "mutualSelected": True}
                ]
            ),
            steps=self.default_steps(),
            message=MESSAGE,
        )

        assert codes(outcomes)[2] == "neighbor_requested"
        assert "#mutual" not in page.clicks

    def test_an_occupied_message_fails_closed(self) -> None:
        outcomes, page = run(
            self.neighbor_script(
                probeNeighborApplication=[
                    {**NEIGHBOR_APPLICATION_READY, "code": "message_occupied"}
                ]
            ),
            steps=self.default_steps(),
            message=MESSAGE,
        )

        assert codes(outcomes)[2] == "message_occupied"
        assert page.typed[-1] != ("#message", MESSAGE)

    def test_a_select_group_is_chosen_by_value(self) -> None:
        outcomes, page = run(
            self.neighbor_script(
                probeNeighborApplication=[
                    {
                        **NEIGHBOR_APPLICATION_READY,
                        "groupKind": "select",
                        "groupNeedsSelection": True,
                        "groupOptionValue": "1",
                        "groupSelector": "#group",
                    }
                ]
            ),
            steps=self.default_steps(),
            message=MESSAGE,
        )

        assert codes(outcomes)[2] == "neighbor_requested"
        assert page.selected == [("#group", "1")]

    def test_a_custom_group_is_clicked(self) -> None:
        outcomes, page = run(
            self.neighbor_script(
                probeNeighborApplication=[
                    {
                        **NEIGHBOR_APPLICATION_READY,
                        "groupKind": "custom",
                        "groupNeedsSelection": True,
                        "groupSelector": "#group",
                    }
                ]
            ),
            steps=self.default_steps(),
            message=MESSAGE,
        )

        assert codes(outcomes)[2] == "neighbor_requested"
        assert "#group" in page.clicks
        assert page.selected == []

    def test_an_already_selected_group_is_left_alone(self) -> None:
        outcomes, page = run(
            self.neighbor_script(
                probeNeighborApplication=[
                    {
                        **NEIGHBOR_APPLICATION_READY,
                        "groupKind": "select",
                        "groupNeedsSelection": False,
                        "groupSelector": "#group",
                    }
                ]
            ),
            steps=self.default_steps(),
            message=MESSAGE,
        )

        assert codes(outcomes)[2] == "neighbor_requested"
        assert page.selected == []
        assert "#group" not in page.clicks

    def test_a_request_that_never_confirms_is_unconfirmed(self) -> None:
        outcomes, page = run(
            self.neighbor_script(probeNeighborConfirmation=[NEIGHBOR_PENDING]),
            steps=self.default_steps(),
            message=MESSAGE,
        )

        assert codes(outcomes)[2] == "neighbor_unconfirmed"
        assert states(outcomes)[2] is EngagementStepState.UNCONFIRMED
        assert "#close" not in page.clicks

    @pytest.mark.parametrize("diagnosis", ["captcha_required", "login_required"])
    def test_a_diagnosed_confirmation_fails_closed(self, diagnosis: str) -> None:
        outcomes, _ = run(
            self.neighbor_script(
                probeNeighborConfirmation=[{**NEIGHBOR_PENDING, "diagnosis": diagnosis}]
            ),
            steps=self.default_steps(),
            message=MESSAGE,
        )

        assert codes(outcomes)[2] == diagnosis

    def test_a_confirmation_without_a_close_control_still_succeeds(self) -> None:
        outcomes, page = run(
            self.neighbor_script(
                probeNeighborConfirmation=[{**NEIGHBOR_CONFIRMED, "closeSelector": None}]
            ),
            steps=self.default_steps(),
            message=MESSAGE,
        )

        assert codes(outcomes)[2] == "neighbor_requested"
        assert "#close" not in page.clicks


class TestOrdering:
    def test_steps_run_in_the_documented_order(self) -> None:
        outcomes, _ = run(successful_script())

        assert [name for name, _ in outcomes] == [
            EngagementStepName.LIKE,
            EngagementStepName.COMMENT,
        ]

    def test_a_failed_comment_stops_before_the_neighbor_step(self) -> None:
        outcomes, page = run(
            successful_script(probeComment=[{"code": "ambiguous"}]),
            steps=(
                EngagementStepName.LIKE,
                EngagementStepName.COMMENT,
                EngagementStepName.MUTUAL_NEIGHBOR,
            ),
            message=MESSAGE,
        )

        assert len(outcomes) == 2
        assert "#entry" not in page.clicks

    def test_a_skipped_like_does_not_stop_the_run(self) -> None:
        outcomes, _ = run(successful_script(probeLike=[LIKE_DONE]))

        assert len(outcomes) == 2
        assert codes(outcomes) == ["already_liked", "comment_published"]

    def test_progress_is_reported_per_step(self) -> None:
        execute, _ = engine(successful_script())
        seen: list[str] = []

        async def scenario() -> None:
            async def on_step(name: EngagementStepName, outcome: StepOutcome) -> None:
                seen.append(f"{name.value}:{outcome.result_code}")

            await execute.execute(EngagementRequest(url=POST_URL, comment=COMMENT), on_step=on_step)

        asyncio.run(scenario())

        assert seen == ["like:liked", "comment:comment_published"]

    def test_only_the_requested_steps_run(self) -> None:
        outcomes, page = run(successful_script(), steps=(EngagementStepName.COMMENT,))

        assert [name for name, _ in outcomes] == [EngagementStepName.COMMENT]
        assert "#like" not in page.clicks
