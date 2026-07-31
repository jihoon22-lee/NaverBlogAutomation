"""Own-blog catalog endpoints for the local web app.

A sync reads only the public rendering of the owner's blog through the existing browser session. The
service refuses to sync a blog that is not the configured owner.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, Query

from naver_blog_assistant.api.errors import ApiError
from naver_blog_assistant.api.models import (
    BlogCategoriesResponse,
    BlogCategorySyncRequest,
    ReferencePostsResponse,
)
from naver_blog_assistant.api.routers.automation import to_api_error
from naver_blog_assistant.application.automation import (
    BlogCatalogFailedError,
    BrowserSessionNotRunningError,
    BrowserSessionOperationFailedError,
    CollectReferencePosts,
)
from naver_blog_assistant.domain import DEFAULT_REFERENCE_POST_COUNT, MAX_REFERENCE_POST_COUNT
from naver_blog_assistant.infrastructure.browser import PageBundleMissingError

CATALOG_DETAILS: dict[str, str] = {
    "blog_id_missing": "설정에서 내 블로그 ID를 먼저 저장하세요.",
    "no_categories": "카테고리를 찾지 못했습니다. 블로그 ID와 공개 설정을 확인하세요.",
    "navigation_failed": "블로그 페이지를 열지 못했습니다.",
    "probe_failed": "페이지에서 카테고리 정보를 읽지 못했습니다.",
}


def register_blog_routes(
    app: FastAPI,
    *,
    catalog: CollectReferencePosts,
    owner_blog_id: Callable[[], str],
    problem_metadata: Callable[..., dict[str, Any]],
) -> None:
    """Add the own-blog catalog endpoints to ``app``."""

    @app.get(
        "/api/v1/blog/categories",
        response_model=BlogCategoriesResponse,
        tags=["Blog"],
        operation_id="listBlogCategories",
    )
    async def list_blog_categories() -> BlogCategoriesResponse:
        return BlogCategoriesResponse.from_domain(catalog.cached_categories())

    @app.post(
        "/api/v1/blog/categories/sync",
        response_model=BlogCategoriesResponse,
        responses={
            403: problem_metadata("The requested blog is not the configured owner."),
            409: problem_metadata("The browser session is not running."),
            422: problem_metadata("The catalog could not be read."),
            502: problem_metadata("A browser operation failed."),
            503: problem_metadata("The page bundle is unavailable."),
        },
        tags=["Blog"],
        operation_id="syncBlogCategories",
    )
    async def sync_blog_categories(
        payload: BlogCategorySyncRequest | None = None,
    ) -> BlogCategoriesResponse:
        owner = owner_blog_id()
        requested = None if payload is None else payload.blog_id
        if requested is not None and owner and requested.strip().lower() != owner.strip().lower():
            raise ApiError(
                status=403,
                code="not_blog_owner",
                title="Not the blog owner",
                detail="설정에 저장한 내 블로그만 동기화할 수 있습니다.",
            )
        try:
            result = await catalog.sync(requested or owner)
        except PageBundleMissingError as error:
            raise ApiError(
                status=503,
                code="browser_unavailable",
                title="Browser unavailable",
                detail="page bundle이 없어 페이지를 읽을 수 없습니다. client build를 실행하세요.",
            ) from error
        except BlogCatalogFailedError as error:
            raise ApiError(
                status=422,
                code=error.code,
                title="Blog catalog failed",
                detail=CATALOG_DETAILS[error.code],
            ) from error
        except (BrowserSessionNotRunningError, BrowserSessionOperationFailedError) as error:
            raise to_api_error(error) from error
        return BlogCategoriesResponse.from_domain(result.categories)

    @app.get(
        "/api/v1/blog/reference-posts",
        response_model=ReferencePostsResponse,
        responses={422: problem_metadata("The request parameters are invalid.")},
        tags=["Blog"],
        operation_id="listReferencePosts",
    )
    async def list_reference_posts(
        category_no: int = Query(ge=0),
        limit: int = Query(default=DEFAULT_REFERENCE_POST_COUNT, ge=1, le=MAX_REFERENCE_POST_COUNT),
    ) -> ReferencePostsResponse:
        return ReferencePostsResponse.from_domain(catalog.references(category_no, limit=limit))
