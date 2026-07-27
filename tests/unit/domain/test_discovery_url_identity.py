"""Tests for safe Naver discovery URL identity matching."""

from naver_blog_assistant.domain import same_naver_post_url


def test_same_naver_post_url_matches_path_and_post_view_shapes() -> None:
    assert same_naver_post_url(
        "https://blog.naver.com/Candidate/123?trackingCode=feed",
        "https://m.blog.naver.com/PostView.naver?blogId=candidate&logNo=123&redirect=Dlog",
    )


def test_same_naver_post_url_rejects_different_or_unsupported_posts() -> None:
    assert not same_naver_post_url(
        "https://blog.naver.com/candidate/123",
        "https://blog.naver.com/PostView.naver?blogId=candidate&logNo=999",
    )
    assert not same_naver_post_url(
        "https://example.test/candidate/123",
        "https://blog.naver.com/candidate/123",
    )
