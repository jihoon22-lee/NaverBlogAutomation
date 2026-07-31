"""Collect the author's own categories and post metadata through the browser session.

The probes only read the rendered page, so a sync is a navigation plus two evaluations. A blog that
does not belong to the configured owner is refused before anything is stored.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any, Protocol

from naver_blog_assistant.application.automation.errors import AutomationError
from naver_blog_assistant.application.automation.session import BrowserSessionManager
from naver_blog_assistant.domain.blog import (
    DEFAULT_REFERENCE_POST_COUNT,
    MAX_REFERENCE_POST_COUNT,
    BlogCategory,
    ReferencePost,
    reference_category_numbers,
)
from naver_blog_assistant.infrastructure.browser.page_scripts import PageScriptRunner
from naver_blog_assistant.ports.browser import BrowserOperationError, PageHandle

CATEGORY_URL = "https://blog.naver.com/{blog_id}"
POST_LIST_URL = "https://blog.naver.com/PostList.naver?blogId={blog_id}&categoryNo={category_no}"
NAVIGATION_TIMEOUT_SECONDS = 20.0


class BlogCatalogStore(Protocol):
    """The subset of the catalog repository this use case needs."""

    def replace_categories(
        self, categories: Sequence[BlogCategory]
    ) -> tuple[BlogCategory, ...]: ...

    def categories(self) -> tuple[BlogCategory, ...]: ...

    def upsert_posts(self, posts: Sequence[ReferencePost]) -> tuple[ReferencePost, ...]: ...

    def posts_for(
        self, category_numbers: Sequence[int], *, limit: int
    ) -> tuple[ReferencePost, ...]: ...


class BlogCatalogFailedError(AutomationError):
    """Raised with a stable code when a sync cannot complete."""

    CODES = frozenset({"blog_id_missing", "no_categories", "navigation_failed", "probe_failed"})

    def __init__(self, code: str) -> None:
        if code not in self.CODES:
            raise ValueError(f"{code} is not a known catalog failure code")
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class CatalogSync:
    """What one sync observed."""

    categories: tuple[BlogCategory, ...]
    posts: tuple[ReferencePost, ...]


class CollectReferencePosts:
    """Read the owner's categories and recent posts, then cache the metadata."""

    def __init__(
        self,
        sessions: BrowserSessionManager,
        store: BlogCatalogStore,
        *,
        scripts: PageScriptRunner | None = None,
    ) -> None:
        self._sessions = sessions
        self._store = store
        self._scripts = scripts if scripts is not None else PageScriptRunner()

    async def sync(self, blog_id: str, *, posts_per_category: int = 20) -> CatalogSync:
        """Refresh the cached categories and the newest posts of each category."""
        owner = blog_id.strip()
        if not owner:
            raise BlogCatalogFailedError("blog_id_missing")
        page = await self._sessions.primary_page()
        await self._goto(page, CATEGORY_URL.format(blog_id=owner))
        observed = await self._probe(page, "probeMyBlogCategories")
        categories = _categories(observed)
        if not categories:
            raise BlogCatalogFailedError("no_categories")
        stored = self._store.replace_categories(categories)

        collected: list[ReferencePost] = []
        for category in stored:
            await self._goto(
                page,
                POST_LIST_URL.format(blog_id=owner, category_no=category.category_no),
            )
            listing = await self._probe(page, "probeCategoryPostList")
            collected.extend(_posts(listing, category.category_no)[:posts_per_category])
        return CatalogSync(categories=stored, posts=self._store.upsert_posts(collected))

    def cached_categories(self) -> tuple[BlogCategory, ...]:
        """Return the cached category snapshot without contacting the browser."""
        return self._store.categories()

    def references(
        self, category_no: int, *, limit: int = DEFAULT_REFERENCE_POST_COUNT
    ) -> tuple[ReferencePost, ...]:
        """Return cached posts from the target category and its closest relatives."""
        bounded = max(1, min(limit, MAX_REFERENCE_POST_COUNT))
        categories = self._store.categories()
        target = next(
            (category for category in categories if category.category_no == category_no), None
        )
        if target is None:
            return ()
        numbers = reference_category_numbers(target, categories)
        return self._store.posts_for(numbers, limit=bounded)

    async def _goto(self, page: PageHandle, url: str) -> None:
        try:
            await page.goto(url, timeout_seconds=NAVIGATION_TIMEOUT_SECONDS)
        except BrowserOperationError as error:
            raise BlogCatalogFailedError("navigation_failed") from error

    async def _probe(self, page: PageHandle, name: str) -> Any:
        try:
            result = await self._scripts.call(page, name)
        except BrowserOperationError as error:
            raise BlogCatalogFailedError("probe_failed") from error
        return result if result is not None else {}


def _categories(observed: Any) -> tuple[BlogCategory, ...]:
    entries = observed.get("categories") if isinstance(observed, dict) else None
    if not isinstance(entries, list):
        return ()
    categories: list[BlogCategory] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        number = _as_int(entry.get("categoryNo"))
        name = entry.get("name")
        if number is None or not isinstance(name, str) or not name.strip():
            continue
        categories.append(
            BlogCategory(
                category_no=number,
                name=name.strip()[:120],
                post_count=_as_int(entry.get("postCount")),
            )
        )
    return tuple(categories)


def _posts(observed: Any, category_no: int) -> tuple[ReferencePost, ...]:
    entries = observed.get("posts") if isinstance(observed, dict) else None
    if not isinstance(entries, list):
        return ()
    posts: list[ReferencePost] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        title = entry.get("title")
        if not isinstance(url, str) or not url.strip():
            continue
        if not isinstance(title, str) or not title.strip():
            continue
        posts.append(
            ReferencePost(
                category_no=category_no,
                source_url=url.strip(),
                title=title.strip()[:300],
                published_at=_as_date(entry.get("publishedAt")),
            )
        )
    return tuple(posts)


def _as_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value >= 0 else None


def _as_date(value: object) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None
