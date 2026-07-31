"""Own-blog catalog collection and the deterministic similar-category rule."""

from __future__ import annotations

import asyncio
from datetime import date
from pathlib import Path
from typing import Any, cast

import pytest

from naver_blog_assistant.application.automation import BrowserSessionManager
from naver_blog_assistant.application.automation.collect_reference_posts import (
    BlogCatalogFailedError,
    CollectReferencePosts,
)
from naver_blog_assistant.domain import (
    BlogCategory,
    DomainValidationError,
    ReferencePost,
    rank_similar_categories,
    reference_category_numbers,
    similarity,
)
from naver_blog_assistant.infrastructure.browser import FakeBrowserDriver, PageScriptRunner
from naver_blog_assistant.infrastructure.browser.fake import FakePage

CATEGORY_PROBE = {
    "categories": [
        {"categoryNo": 7, "name": "전시 후기", "postCount": 12},
        {"categoryNo": 8, "name": "전시 기록", "postCount": 4},
        {"categoryNo": 9, "name": "요리", "postCount": None},
        {"categoryNo": None, "name": "잘못된 항목", "postCount": 1},
        {"categoryNo": 10, "name": "   ", "postCount": 1},
        "문자열 항목",
    ]
}
POST_PROBE = {
    "categoryNo": 7,
    "posts": [
        {
            "logNo": "1",
            "title": "첫 전시",
            "publishedAt": "2026-07-20",
            "url": "https://blog.naver.com/example/1",
        },
        {
            "logNo": "2",
            "title": "두 번째 전시",
            "publishedAt": "잘못된 날짜",
            "url": "https://blog.naver.com/example/2",
        },
        {"logNo": "3", "title": "  ", "url": "https://blog.naver.com/example/3"},
        {"logNo": "4", "title": "URL 없음", "url": "   "},
        123,
    ],
}


class _Store:
    """In-memory catalog store."""

    def __init__(self, categories: tuple[BlogCategory, ...] = ()) -> None:
        self._categories = categories
        self._posts: list[ReferencePost] = []
        self.replaced: list[tuple[BlogCategory, ...]] = []

    def replace_categories(self, categories: Any) -> tuple[BlogCategory, ...]:
        self._categories = tuple(categories)
        self.replaced.append(self._categories)
        return self._categories

    def categories(self) -> tuple[BlogCategory, ...]:
        return self._categories

    def upsert_posts(self, posts: Any) -> tuple[ReferencePost, ...]:
        self._posts = list(posts)
        return tuple(self._posts)

    def posts_for(self, category_numbers: Any, *, limit: int) -> tuple[ReferencePost, ...]:
        wanted = set(category_numbers)
        return tuple(post for post in self._posts if post.category_no in wanted)[:limit]


PROFILE = Path("/tmp/naver-blog-assistant-test-profile")


def collector(
    probes: dict[str, Any], store: _Store | None = None
) -> tuple[CollectReferencePosts, _Store, FakePage]:
    driver = FakeBrowserDriver(page_probe_results=dict(probes))
    sessions = BrowserSessionManager(driver=driver, profile_dir=PROFILE, headless=True)
    page = asyncio.run(_prepared(sessions))
    catalog_store = store or _Store()
    catalog = CollectReferencePosts(sessions, catalog_store, scripts=PageScriptRunner())
    return catalog, catalog_store, page


async def _prepared(sessions: BrowserSessionManager) -> FakePage:
    await sessions.launch()
    return cast(FakePage, await sessions.primary_page())


class TestSimilarity:
    def test_identical_names_score_one(self) -> None:
        assert similarity("전시 후기", "전시 후기") == 1.0

    def test_unrelated_names_score_zero_or_low(self) -> None:
        assert similarity("전시 후기", "자동차 정비") < 0.2

    def test_a_shared_token_scores_higher_than_none(self) -> None:
        assert similarity("전시 후기", "전시 기록") > similarity("전시 후기", "요리")

    def test_it_ignores_case_and_separators(self) -> None:
        assert similarity("Travel Log", "travel-log") == 1.0

    def test_an_empty_name_scores_zero(self) -> None:
        assert similarity("", "전시") == 0.0

    def test_it_is_symmetric(self) -> None:
        assert similarity("전시 후기", "기록 전시") == similarity("기록 전시", "전시 후기")


class TestRanking:
    def categories(self) -> tuple[BlogCategory, ...]:
        return (
            BlogCategory(category_no=7, name="전시 후기"),
            BlogCategory(category_no=8, name="전시 기록"),
            BlogCategory(category_no=9, name="요리"),
            BlogCategory(category_no=10, name="전시 기록"),
        )

    def test_it_excludes_the_target_and_orders_by_score(self) -> None:
        target = BlogCategory(category_no=7, name="전시 후기")

        ranked = rank_similar_categories(target, self.categories())

        assert [match.category.category_no for match in ranked][:2] == [8, 10]
        assert ranked[-1].category.category_no == 9

    def test_a_tie_breaks_by_category_number(self) -> None:
        target = BlogCategory(category_no=7, name="전시 후기")

        ranked = rank_similar_categories(target, self.categories())

        assert ranked[0].score == ranked[1].score
        assert ranked[0].category.category_no < ranked[1].category.category_no

    def test_reference_numbers_start_with_the_target(self) -> None:
        target = BlogCategory(category_no=7, name="전시 후기")

        numbers = reference_category_numbers(target, self.categories())

        assert numbers[0] == 7
        assert 9 not in numbers

    def test_an_unrelated_catalog_yields_only_the_target(self) -> None:
        target = BlogCategory(category_no=1, name="자동차")
        numbers = reference_category_numbers(
            target, (target, BlogCategory(category_no=2, name="요리"))
        )

        assert numbers == (1,)

    def test_a_negative_limit_is_rejected(self) -> None:
        target = BlogCategory(category_no=1, name="자동차")

        with pytest.raises(DomainValidationError):
            reference_category_numbers(target, (target,), limit=-1)


class TestDomainValidation:
    @pytest.mark.parametrize(
        "kwargs",
        [
            {"category_no": -1, "name": "전시"},
            {"category_no": 1, "name": "   "},
            {"category_no": 1, "name": "가" * 121},
            {"category_no": 1, "name": " 전시 "},
            {"category_no": 1, "name": "전시", "post_count": -1},
        ],
    )
    def test_it_rejects_an_unusable_category(self, kwargs: dict[str, Any]) -> None:
        with pytest.raises(DomainValidationError):
            BlogCategory(**kwargs)

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"category_no": -1, "source_url": "https://x", "title": "글"},
            {"category_no": 1, "source_url": "  ", "title": "글"},
            {"category_no": 1, "source_url": "https://x", "title": " "},
            {"category_no": 1, "source_url": "https://x", "title": "가" * 301},
        ],
    )
    def test_it_rejects_an_unusable_reference(self, kwargs: dict[str, Any]) -> None:
        with pytest.raises(DomainValidationError):
            ReferencePost(**kwargs)


class TestCollection:
    def test_it_stores_only_usable_categories_and_posts(self) -> None:
        catalog, store, _ = collector(
            {"probeMyBlogCategories": CATEGORY_PROBE, "probeCategoryPostList": POST_PROBE}
        )

        result = asyncio.run(catalog.sync("example"))

        assert [category.category_no for category in result.categories] == [7, 8, 9]
        assert {post.title for post in result.posts} == {"첫 전시", "두 번째 전시"}
        assert store.replaced[0] == result.categories

    def test_an_unparsable_date_becomes_none(self) -> None:
        catalog, _, _ = collector(
            {"probeMyBlogCategories": CATEGORY_PROBE, "probeCategoryPostList": POST_PROBE}
        )

        posts = asyncio.run(catalog.sync("example")).posts

        dated = {post.title: post.published_at for post in posts}
        assert dated["첫 전시"] == date(2026, 7, 20)
        assert dated["두 번째 전시"] is None

    def test_a_missing_blog_id_is_refused_before_any_navigation(self) -> None:
        catalog, _, page = collector({})
        before = list(page.navigations)

        with pytest.raises(BlogCatalogFailedError) as error:
            asyncio.run(catalog.sync("   "))
        assert error.value.code == "blog_id_missing"
        assert page.navigations == before

    def test_an_empty_category_tree_is_refused(self) -> None:
        catalog, store, _ = collector({"probeMyBlogCategories": {"categories": []}})

        with pytest.raises(BlogCatalogFailedError) as error:
            asyncio.run(catalog.sync("example"))
        assert error.value.code == "no_categories"
        assert store.replaced == []

    def test_a_navigation_failure_is_reported(self) -> None:
        driver = FakeBrowserDriver(page_navigation_failure="net::ERR")
        sessions = BrowserSessionManager(driver=driver, profile_dir=PROFILE, headless=True)
        asyncio.run(_prepared(sessions))
        catalog = CollectReferencePosts(sessions, _Store(), scripts=PageScriptRunner())

        with pytest.raises(BlogCatalogFailedError) as error:
            asyncio.run(catalog.sync("example"))
        assert error.value.code == "navigation_failed"

    def test_references_use_the_target_and_related_categories(self) -> None:
        catalog, _, _ = collector(
            {"probeMyBlogCategories": CATEGORY_PROBE, "probeCategoryPostList": POST_PROBE}
        )
        asyncio.run(catalog.sync("example"))

        references = catalog.references(7, limit=1)

        assert len(references) == 1
        assert references[0].category_no in {7, 8}

    def test_an_unknown_category_has_no_references(self) -> None:
        catalog, _, _ = collector(
            {"probeMyBlogCategories": CATEGORY_PROBE, "probeCategoryPostList": POST_PROBE}
        )
        asyncio.run(catalog.sync("example"))

        assert catalog.references(999) == ()

    def test_an_unknown_failure_code_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="not a known catalog failure code"):
            BlogCatalogFailedError("unknown")
