"""Editor staging: step order, confirmation, and fail-closed refusals."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4

import pytest

from naver_blog_assistant.application.automation import BrowserSessionManager
from naver_blog_assistant.application.automation.stage_post import (
    StagePost,
    StagingBlockedError,
    StagingRequest,
    body_text,
    staging_request,
    tag_text,
)
from naver_blog_assistant.domain.publishing import PublishStepName, PublishStepState
from naver_blog_assistant.domain.writing import (
    BlockKind,
    BodyBlock,
    DraftImage,
    DraftRevision,
    DraftTag,
    DraftWorkingCopy,
    PostDraft,
    RevisionKind,
)
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver, PageScriptRunner
from naver_blog_assistant.infrastructure.browser.fake import FakePage

DRAFT_ID = UUID("11111111-1111-4111-8111-111111111111")
IMAGE_ID = UUID("22222222-2222-4222-8222-222222222222")
PROFILE = Path("/tmp/naver-blog-assistant-staging-profile")

READY = {
    "stage": "ready",
    "titleSelector": "#title",
    "bodySelector": "#body",
    "editorRootSelector": "#editor-root",
    "imageInputSelector": "#file",
    "imageCaptionSelector": "#caption",
    "saveSelector": "#save",
    "tagInputSelector": "#tags",
    "restoreCancelSelector": None,
    "blockActionSelectors": {
        "heading": "#heading",
        "quote": "#quote",
        "ordered_list": "#ordered-list",
        "unordered_list": "#unordered-list",
        "divider": "#divider",
    },
}


def blocks(*, with_image: bool = False) -> tuple[BodyBlock, ...]:
    body = (
        BodyBlock(kind=BlockKind.HEADING, text="첫 구역"),
        BodyBlock(kind=BlockKind.PARAGRAPH, text="문단입니다."),
        BodyBlock(kind=BlockKind.QUOTE, text="인용입니다."),
    )
    if not with_image:
        return body
    return (*body, BodyBlock(kind=BlockKind.IMAGE, image_id=IMAGE_ID, caption="사진 설명"))


def supported_blocks() -> tuple[BodyBlock, ...]:
    return (
        BodyBlock(kind=BlockKind.PARAGRAPH, text="도입 문단"),
        BodyBlock(kind=BlockKind.HEADING, text="소제목"),
        BodyBlock(kind=BlockKind.QUOTE, text="인용문"),
        BodyBlock(kind=BlockKind.ORDERED_LIST, items=("첫째", "둘째")),
        BodyBlock(kind=BlockKind.UNORDERED_LIST, items=("항목",)),
        BodyBlock(kind=BlockKind.DIVIDER),
    )


def snapshot(body: tuple[BodyBlock, ...]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for block in body:
        if block.kind is BlockKind.IMAGE:
            result.append({"type": "image", "caption": block.caption})
        elif block.kind in {BlockKind.ORDERED_LIST, BlockKind.UNORDERED_LIST}:
            result.append({"type": block.kind.value, "items": list(block.items)})
        elif block.kind is BlockKind.DIVIDER:
            result.append({"type": "divider"})
        else:
            result.append({"type": block.kind.value, "text": block.text})
    return result


def prefix_snapshots(body: tuple[BodyBlock, ...]) -> list[list[dict[str, Any]]]:
    return [snapshot(body[: index + 1]) for index in range(len(body))]


def image(root: Path) -> DraftImage:
    relative = f"drafts/{DRAFT_ID}/{IMAGE_ID}.png"
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"\x89PNG\r\n\x1a\n")
    return DraftImage(
        id=IMAGE_ID,
        draft_id=DRAFT_ID,
        ordinal=0,
        stored_path=relative,
        original_filename="a.png",
        byte_size=8,
        mime="image/png",
    )


def request(
    root: Path,
    *,
    with_image: bool = False,
    tags: tuple[str, ...] = (),
    steps: tuple[PublishStepName, ...] | None = None,
) -> StagingRequest:
    return StagingRequest(
        blog_id="example",
        title="합성 제목",
        blocks=blocks(with_image=with_image),
        images=(image(root),) if with_image else (),
        tags=tags,
        media_root=root,
        steps=steps if steps is not None else tuple(PublishStepName),
    )


def engine(script: dict[str, Any]) -> tuple[StagePost, FakePage]:
    driver = FakeBrowserDriver(page_probe_results=dict(script))
    sessions = BrowserSessionManager(driver=driver, profile_dir=PROFILE, headless=True)

    async def prepared() -> FakePage:
        await sessions.launch()
        return cast(FakePage, await sessions.primary_page())

    page = asyncio.run(prepared())
    return StagePost(sessions, scripts=PageScriptRunner(), pause=_no_pause), page


async def _no_pause(_seconds: float) -> None:
    return None


def run(stage: StagePost, staging: StagingRequest) -> list[tuple[PublishStepName, Any]]:
    async def scenario() -> list[tuple[PublishStepName, Any]]:
        async with asyncio.timeout(10):
            progress = await stage.execute(staging)
            return progress.outcomes

    return asyncio.run(scenario())


def codes(outcomes: list[tuple[PublishStepName, Any]]) -> dict[str, str]:
    return {name.value: outcome.result_code for name, outcome in outcomes}


class TestRendering:
    def test_the_body_keeps_block_order_and_marks_quotes(self) -> None:
        text = body_text(blocks(with_image=True))

        assert text.splitlines()[0] == "첫 구역"
        assert "“인용입니다.”" in text
        assert "사진 설명" in text

    def test_an_image_without_a_caption_adds_nothing(self) -> None:
        text = body_text((BodyBlock(kind=BlockKind.IMAGE, image_id=IMAGE_ID),))

        assert text == ""

    def test_tags_are_rendered_for_the_body_input(self) -> None:
        assert tag_text(("전시", "기록")) == "\n\n#전시 #기록"


class TestStagingRequest:
    def draft(self, **overrides: Any) -> PostDraft:
        revision = DraftRevision(
            id=uuid4(),
            draft_id=DRAFT_ID,
            round_no=1,
            kind=RevisionKind.COMPOSED,
            title="합성 제목",
            blocks=blocks(),
            is_active=True,
            created_at=datetime(2026, 7, 31, tzinfo=UTC),
        )
        payload: dict[str, Any] = {
            "id": DRAFT_ID,
            "title": "초안",
            "revisions": (revision,),
            "tags": (DraftTag(tag="전시", ordinal=0),),
        }
        payload.update(overrides)
        return PostDraft(**payload)

    def test_it_uses_the_active_revision(self, tmp_path: Path) -> None:
        staging = staging_request(
            self.draft(), blog_id="example", tags=("전시",), media_root=tmp_path
        )

        assert staging.title == "합성 제목"
        assert staging.tags == ("전시",)

    def test_it_stages_the_latest_working_copy(self, tmp_path: Path) -> None:
        staging = staging_request(
            self.draft(
                working_copy=DraftWorkingCopy(
                    title="자동 저장 제목",
                    blocks=(BodyBlock(kind=BlockKind.PARAGRAPH, text="자동 저장 본문"),),
                    content_version=3,
                )
            ),
            blog_id="example",
            tags=(),
            media_root=tmp_path,
        )

        assert staging.title == "자동 저장 제목"
        assert staging.blocks[0].text == "자동 저장 본문"

    def test_a_missing_blog_id_is_refused(self, tmp_path: Path) -> None:
        with pytest.raises(StagingBlockedError) as error:
            staging_request(self.draft(), blog_id="  ", tags=(), media_root=tmp_path)
        assert error.value.code == "blog_id_missing"

    def test_a_draft_without_a_body_is_refused(self, tmp_path: Path) -> None:
        with pytest.raises(StagingBlockedError) as error:
            staging_request(
                self.draft(revisions=()), blog_id="example", tags=(), media_root=tmp_path
            )
        assert error.value.code == "no_active_revision"

    def test_an_unknown_block_code_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="not a known staging block code"):
            StagingBlockedError("unknown")


class TestExecution:
    def script(self, **overrides: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "probeEditor": READY,
            "readEditorText": "합성 제목",
            "readEditorBlocks": prefix_snapshots(blocks()),
            "probeEditorSave": [
                {"saved": False, "savedCount": 2, "diagnosis": None},
                {"saved": True, "savedCount": 3, "diagnosis": None},
            ],
        }
        base.update(overrides)
        return base

    def test_every_step_runs_in_the_documented_order(self, tmp_path: Path) -> None:
        stage, page = engine(
            self.script(
                readEditorText=[
                    "합성 제목",
                ],
                readEditorBlocks=prefix_snapshots(blocks(with_image=True)),
            )
        )

        outcomes = run(stage, request(tmp_path, with_image=True, tags=("전시",)))

        assert [name.value for name, _ in outcomes] == [
            "title",
            "body",
            "images",
            "tags",
            "save",
        ]
        assert codes(outcomes)["save"] == "draft_saved"
        assert dict(outcomes)[PublishStepName.IMAGES].state is PublishStepState.SUCCEEDED
        assert dict(outcomes)[PublishStepName.BODY].detail == {
            "requested_range_start": 1,
            "requested_range_end": 4,
            "observed_prefix_count": 4,
        }
        assert page.attachments[0][0] == "#file"
        assert page.appended[:3] == [
            ("#body", "첫 구역"),
            ("#body", "문단입니다."),
            ("#body", "인용입니다."),
        ]
        assert "#body" not in page.clicks
        assert page.pressed[:3] == [("#body", "Enter")] * 3

    def test_every_supported_text_block_uses_its_action_before_prefix_verification(
        self, tmp_path: Path
    ) -> None:
        body = supported_blocks()
        stage, page = engine(self.script(readEditorBlocks=prefix_snapshots(body)))
        staging = request(tmp_path)
        staging.blocks = body

        outcomes = run(stage, staging)

        assert codes(outcomes)["body"] == "blocks_staged_6"
        assert [selector for selector in page.clicks if selector != "#save"] == [
            "#heading",
            "#quote",
            "#ordered-list",
            "#unordered-list",
            "#divider",
        ]
        assert page.appended == [
            ("#body", "도입 문단"),
            ("#body", "소제목"),
            ("#body", "인용문"),
            ("#body", "첫째\n둘째"),
            ("#body", "항목"),
        ]
        assert [action for action in page.actions if action[1] == "#body"] == [
            ("type", "#body"),
            ("append", "#body"),
            ("press", "#body"),
            ("append", "#body"),
            ("press", "#body"),
            ("append", "#body"),
            ("press", "#body"),
            ("append", "#body"),
            ("press", "#body"),
            ("append", "#body"),
            ("press", "#body"),
        ]

    @pytest.mark.parametrize(
        ("body", "expected_actions"),
        [
            (
                (
                    BodyBlock(kind=BlockKind.IMAGE, image_id=IMAGE_ID),
                    BodyBlock(kind=BlockKind.PARAGRAPH, text="뒤 문단"),
                ),
                [("type", "#body"), ("files", "#file"), ("press", "#body"), ("append", "#body")],
            ),
            (
                (
                    BodyBlock(kind=BlockKind.PARAGRAPH, text="앞 문단"),
                    BodyBlock(kind=BlockKind.IMAGE, image_id=IMAGE_ID),
                    BodyBlock(kind=BlockKind.PARAGRAPH, text="뒤 문단"),
                ),
                [
                    ("type", "#body"),
                    ("append", "#body"),
                    ("press", "#body"),
                    ("files", "#file"),
                    ("press", "#body"),
                    ("append", "#body"),
                ],
            ),
            (
                (
                    BodyBlock(kind=BlockKind.PARAGRAPH, text="앞 문단"),
                    BodyBlock(kind=BlockKind.IMAGE, image_id=IMAGE_ID),
                ),
                [("type", "#body"), ("append", "#body"), ("press", "#body"), ("files", "#file")],
            ),
        ],
        ids=("before_text", "between_text", "after_text"),
    )
    def test_an_image_stays_at_its_requested_block_position(
        self,
        tmp_path: Path,
        body: tuple[BodyBlock, ...],
        expected_actions: list[tuple[str, str]],
    ) -> None:
        stage, page = engine(self.script(readEditorBlocks=prefix_snapshots(body)))
        staging = request(tmp_path, with_image=True)
        staging.blocks = body

        outcomes = run(stage, staging)

        assert codes(outcomes)["body"] == f"blocks_staged_{len(body)}"
        assert page.attachments == [
            ("#file", (str((tmp_path / staging.images[0].stored_path).resolve()),))
        ]
        assert [
            action for action in page.actions if action[1] in {"#body", "#file"}
        ] == expected_actions

    def test_it_skips_images_when_the_body_references_none(self, tmp_path: Path) -> None:
        stage, page = engine(self.script())

        outcomes = run(stage, request(tmp_path))

        assert codes(outcomes)["images"] == "no_images"
        assert page.attachments == []

    def test_a_missing_image_file_stops_the_run(self, tmp_path: Path) -> None:
        stage, _ = engine(
            self.script(readEditorText=["합성 제목", body_text(blocks(with_image=True))])
        )
        staging = request(tmp_path, with_image=True)
        (tmp_path / staging.images[0].stored_path).unlink()

        outcomes = run(stage, staging)

        assert codes(outcomes)["body"] == "image_file_missing"
        assert dict(outcomes)[PublishStepName.BODY].detail == {
            "requested_range_start": 1,
            "requested_range_end": 4,
            "observed_prefix_count": 0,
        }
        assert "save" not in codes(outcomes)

    def test_it_skips_tags_when_there_are_none(self, tmp_path: Path) -> None:
        stage, _ = engine(self.script())

        outcomes = run(stage, request(tmp_path))

        assert codes(outcomes)["tags"] == "no_tags"

    def test_a_title_that_does_not_stick_is_unconfirmed(self, tmp_path: Path) -> None:
        stage, _ = engine(self.script(readEditorText=["다른 값"]))

        outcomes = run(stage, request(tmp_path))

        assert codes(outcomes)["title"] == "title_unconfirmed"
        assert len(outcomes) == 1

    def test_a_save_that_never_confirms_is_unconfirmed(self, tmp_path: Path) -> None:
        stage, page = engine(
            self.script(probeEditorSave={"saved": False, "savedCount": 2, "diagnosis": None})
        )

        outcomes = run(stage, request(tmp_path))

        assert codes(outcomes)["save"] == "save_unconfirmed"
        assert page.clicks.count("#save") == 1

    def test_a_captcha_after_save_fails_closed(self, tmp_path: Path) -> None:
        stage, _ = engine(
            self.script(
                probeEditorSave=[
                    {"saved": False, "savedCount": 1, "diagnosis": None},
                    {"saved": False, "savedCount": 1, "diagnosis": "captcha_required"},
                ]
            )
        )

        outcomes = run(stage, request(tmp_path))

        assert codes(outcomes)["save"] == "captcha_required"

    def test_the_restore_prompt_is_cancelled_once(self, tmp_path: Path) -> None:
        stage, page = engine(
            self.script(
                probeEditor=[
                    {**READY, "stage": "restore_prompt", "restoreCancelSelector": "#cancel"},
                    READY,
                ]
            )
        )

        run(stage, request(tmp_path))

        assert page.clicks[0] == "#cancel"

    def test_a_restore_prompt_without_a_cancel_control_stops(self, tmp_path: Path) -> None:
        stage, _ = engine(
            self.script(
                probeEditor={**READY, "stage": "restore_prompt", "restoreCancelSelector": None}
            )
        )

        with pytest.raises(StagingBlockedError) as error:
            run(stage, request(tmp_path))
        assert error.value.code == "restore_prompt_unresolved"

    @pytest.mark.parametrize(
        ("stage_name", "code"),
        [
            ("login_required", "login_required"),
            ("ambiguous", "editor_ambiguous"),
            ("not_found", "editor_not_found"),
        ],
    )
    def test_an_unusable_editor_stops_the_run(
        self, tmp_path: Path, stage_name: str, code: str
    ) -> None:
        stage, _ = engine(self.script(probeEditor={**READY, "stage": stage_name}))

        with pytest.raises(StagingBlockedError) as error:
            run(stage, request(tmp_path))
        assert error.value.code == code

    def test_only_the_requested_steps_run(self, tmp_path: Path) -> None:
        stage, _ = engine(self.script())

        outcomes = run(stage, request(tmp_path, steps=(PublishStepName.SAVE,)))

        assert [name for name, _ in outcomes] == [PublishStepName.SAVE]

    def test_a_navigation_failure_stops_before_any_step(self, tmp_path: Path) -> None:
        driver = FakeBrowserDriver(page_navigation_failure="net::ERR")
        sessions = BrowserSessionManager(driver=driver, profile_dir=PROFILE, headless=True)
        asyncio.run(sessions.launch())
        stage = StagePost(sessions, scripts=PageScriptRunner(), pause=_no_pause)

        with pytest.raises(StagingBlockedError) as error:
            run(stage, request(tmp_path))
        assert error.value.code == "navigation_failed"

    def test_a_browser_failure_is_reported_as_a_step_result(self, tmp_path: Path) -> None:
        stage, page = engine(self.script())
        page.action_failures["#title"] = "detached node"

        outcomes = run(stage, request(tmp_path))

        assert codes(outcomes)["title"] == "browser_operation_failed"

    def test_an_image_only_body_reports_that_no_text_block_was_required(
        self, tmp_path: Path
    ) -> None:
        stage, _ = engine(
            self.script(
                readEditorText="합성 제목",
                readEditorBlocks=prefix_snapshots(
                    (BodyBlock(kind=BlockKind.IMAGE, image_id=IMAGE_ID),)
                ),
            )
        )
        staging = request(tmp_path, with_image=True)
        staging.blocks = (BodyBlock(kind=BlockKind.IMAGE, image_id=IMAGE_ID),)

        outcomes = run(stage, staging)

        assert codes(outcomes)["body"] == "blocks_staged_1"

    def test_a_plain_text_editor_result_is_not_silently_saved(self, tmp_path: Path) -> None:
        script = self.script(readEditorBlocks=[[{"type": "paragraph", "text": "첫 구역"}]])
        stage, _ = engine(script)

        outcomes = run(stage, request(tmp_path))

        assert codes(outcomes)["body"] == "block_1_order_unconfirmed"
        assert "save" not in codes(outcomes)

    def test_a_missing_block_control_stops_before_save(self, tmp_path: Path) -> None:
        stage, _ = engine(
            self.script(probeEditor={**READY, "blockActionSelectors": {"quote": "#quote"}})
        )

        outcomes = run(stage, request(tmp_path))

        assert codes(outcomes)["body"] == "block_heading_control_not_found"
        assert "save" not in codes(outcomes)

    def test_a_captioned_image_requires_a_confirmed_caption_control(self, tmp_path: Path) -> None:
        stage, _ = engine(
            self.script(
                probeEditor=[READY, {**READY, "imageCaptionSelector": None}],
                readEditorBlocks=prefix_snapshots(blocks(with_image=True)),
            )
        )

        outcomes = run(stage, request(tmp_path, with_image=True))

        assert codes(outcomes)["body"] == "image_caption_control_not_found"
        assert "save" not in codes(outcomes)

    def test_an_editor_without_a_semantic_snapshot_stops_before_save(self, tmp_path: Path) -> None:
        stage, _ = engine(self.script(readEditorBlocks=None))

        outcomes = run(stage, request(tmp_path))

        assert codes(outcomes)["body"] == "block_1_unsupported_editor_structure"
        assert "save" not in codes(outcomes)


def test_the_documented_step_states_exist() -> None:
    assert {state.value for state in PublishStepState} == {
        "pending",
        "running",
        "succeeded",
        "skipped",
        "failed",
        "unconfirmed",
    }
