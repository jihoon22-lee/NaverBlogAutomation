"""Explicitly opt-in Naver editor signature smoke; never runs in normal CI."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

from naver_blog_assistant.application.automation import (
    BrowserSessionManager,
    StagePost,
    StagingRequest,
)
from naver_blog_assistant.domain import BrowserLoginState
from naver_blog_assistant.domain.writing import BlockKind, BodyBlock
from naver_blog_assistant.infrastructure.browser import create_browser_driver, resolve_profile_dir


@pytest.mark.live_naver
def test_live_naver_editor_signature_stages_without_publishing(tmp_path: Path) -> None:
    """Stage one synthetic body and stop before any publish action.

    Required opt-in environment:

    - ``RUN_LIVE_NAVER=1``
    - ``NAVER_LIVE_BLOG_ID``: a disposable test account's blog id
    - ``AUTOMATION_PROFILE_DIR``: a dedicated persistent profile already signed in to Naver

    The test intentionally does not print page content, credentials, cookies, or screenshots.
    A successful run creates a private draft in the selected test blog; the user must remove it
    manually after reviewing the observed block order.
    """
    if os.getenv("RUN_LIVE_NAVER") != "1":
        pytest.skip("set RUN_LIVE_NAVER=1 to make a real Naver editor request")
    blog_id = os.environ.get("NAVER_LIVE_BLOG_ID", "").strip()
    if not blog_id:
        pytest.fail("NAVER_LIVE_BLOG_ID is required for the opt-in smoke")
    configured_profile = os.environ.get("AUTOMATION_PROFILE_DIR", "").strip()
    if not configured_profile:
        pytest.fail("AUTOMATION_PROFILE_DIR must point to the dedicated signed-in profile")

    driver_name = os.getenv("AUTOMATION_DRIVER", "patchright")
    channel = os.getenv("AUTOMATION_BROWSER_CHANNEL", "").strip() or None
    profile = resolve_profile_dir(
        configured=configured_profile,
        platform=sys.platform,
        environment=os.environ,
        home=Path.home(),
    )
    sessions = BrowserSessionManager(
        create_browser_driver(driver_name),
        profile_dir=profile,
        headless=os.getenv("LIVE_NAVER_HEADLESS", "0") == "1",
        channel=channel,
        login_probe_url=f"https://blog.naver.com/{blog_id}",
    )
    request = StagingRequest(
        blog_id=blog_id,
        title="웹앱 block editor signature smoke",
        blocks=(
            BodyBlock(kind=BlockKind.PARAGRAPH, text="첫 번째 합성 문단입니다."),
            BodyBlock(kind=BlockKind.HEADING, text="합성 소제목"),
            BodyBlock(kind=BlockKind.QUOTE, text="검증용 인용 블록입니다."),
            BodyBlock(kind=BlockKind.ORDERED_LIST, items=("첫째", "둘째")),
            BodyBlock(kind=BlockKind.UNORDERED_LIST, items=("항목",)),
            BodyBlock(kind=BlockKind.DIVIDER),
        ),
        images=(),
        tags=(),
        media_root=tmp_path,
    )

    async def run() -> tuple[BrowserLoginState, list[tuple[str, str, str]]]:
        status = await sessions.launch()
        try:
            if status.login is not BrowserLoginState.AUTHENTICATED:
                pytest.fail("the dedicated Naver profile is not authenticated")
            progress = await StagePost(sessions).execute(request)
            outcomes = [
                (name.value, outcome.state.value, outcome.result_code)
                for name, outcome in progress.outcomes
            ]
            return status.login, outcomes
        finally:
            await sessions.shutdown()

    login, outcomes = asyncio.run(run())
    assert login is BrowserLoginState.AUTHENTICATED
    assert outcomes[0] == ("title", "succeeded", "title_filled")
    assert outcomes[1][0:2] == ("body", "succeeded")
    assert outcomes[-1] == ("save", "succeeded", "draft_saved")
