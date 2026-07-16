"""Tests for the initial Streamlit application shell."""

from pathlib import Path
from unittest.mock import patch

from streamlit.testing.v1 import AppTest

from naver_blog_assistant import app as app_module

APP_PATH = Path(__file__).parents[2] / "src" / "naver_blog_assistant" / "app.py"


def test_app_renders_comment_assistant_form() -> None:
    app = AppTest.from_file(APP_PATH, default_timeout=10).run()

    assert not app.exception
    assert app.title[0].value == "Naver Blog AI 댓글 작성 보조 도구"
    assert "네이버 등록은 사용자가 직접 수행합니다" in app.info[0].value
    assert app.text_input[0].label == "네이버 블로그 글 URL"
    assert app.text_area[0].label == "분석할 글 본문"
    assert app.button[0].label == "댓글 후보 생성"
    assert app.button[0].disabled


def test_app_entrypoint_builds_expected_widgets() -> None:
    with (
        patch.object(app_module.st, "set_page_config") as set_page_config,
        patch.object(app_module.st, "title") as title,
        patch.object(app_module.st, "info") as info,
        patch.object(app_module.st, "text_input") as text_input,
        patch.object(app_module.st, "text_area") as text_area,
        patch.object(app_module.st, "button") as button,
    ):
        app_module.main()

    set_page_config.assert_called_once_with(page_title="Naver Blog Assistant", page_icon="💬")
    title.assert_called_once_with("Naver Blog AI 댓글 작성 보조 도구")
    info.assert_called_once()
    text_input.assert_called_once()
    text_area.assert_called_once()
    button.assert_called_once_with(
        "댓글 후보 생성",
        disabled=True,
        help="다음 개발 단계에서 활성화됩니다.",
    )
