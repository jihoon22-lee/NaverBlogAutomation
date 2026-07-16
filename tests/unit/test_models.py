"""Tests for domain-model validation."""

import pytest
from pydantic import ValidationError

from naver_blog_assistant.domain.models import CommentDraft, DraftStatus


def test_comment_draft_defaults_to_drafted() -> None:
    draft = CommentDraft(post_url="https://blog.naver.com/example/1", comment="잘 읽었습니다!")

    assert draft.status is DraftStatus.DRAFTED


def test_comment_draft_rejects_empty_comment() -> None:
    with pytest.raises(ValidationError):
        CommentDraft(post_url="https://blog.naver.com/example/1", comment="")
