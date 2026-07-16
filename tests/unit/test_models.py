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


def test_comment_draft_rejects_invalid_url() -> None:
    with pytest.raises(ValidationError):
        CommentDraft(post_url="not-a-url", comment="잘 읽었습니다!")


def test_comment_draft_rejects_comment_over_limit() -> None:
    with pytest.raises(ValidationError):
        CommentDraft(post_url="https://blog.naver.com/example/1", comment="가" * 501)


def test_comment_draft_accepts_explicit_status() -> None:
    draft = CommentDraft(
        post_url="https://blog.naver.com/example/1",
        comment="좋은 글 감사합니다!",
        status=DraftStatus.APPROVED,
    )

    assert draft.status is DraftStatus.APPROVED
