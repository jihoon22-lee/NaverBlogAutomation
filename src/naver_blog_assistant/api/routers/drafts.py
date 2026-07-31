"""Post draft endpoints for the local web app.

Uploaded bytes are validated before they reach disk and never appear in a response. Composition,
refinement, and tagging each take one explicit provider selection.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import FastAPI, File, Form, Query, UploadFile

from naver_blog_assistant.api.draft_models import (
    DraftCreateRequest,
    DraftGenerationRequest,
    DraftListResponse,
    DraftPatchRequest,
    DraftResponse,
    DraftTagPatchRequest,
)
from naver_blog_assistant.api.errors import ApiError
from naver_blog_assistant.application.writing import (
    ComposePost,
    ReferenceBody,
    WritingOptions,
    WritingRefusedError,
)
from naver_blog_assistant.domain import DomainValidationError, LlmProvider, ModelSelection
from naver_blog_assistant.domain.writing import (
    MAX_IMAGES,
    DraftImage,
    DraftStatus,
    TagSource,
    normalize_tag,
    normalize_tags,
)
from naver_blog_assistant.infrastructure.database.post_draft_repository import DraftNotFoundError
from naver_blog_assistant.infrastructure.storage import DraftImageStore

WRITING_DETAILS: dict[str, str] = {
    "seed_text_missing": "초안 text가 비어 있습니다.",
    "no_active_revision": "먼저 본문을 생성하세요.",
    "unknown_image_reference": "생성 결과가 없는 이미지를 참조했습니다.",
    "duplicate_image_reference": "생성 결과가 같은 이미지를 두 번 사용했습니다.",
    "no_usable_tags": "사용할 수 있는 태그를 만들지 못했습니다.",
}


def register_draft_routes(  # noqa: C901 - one closure per documented endpoint
    app: FastAPI,
    *,
    drafts: Any,
    compose: ComposePost,
    images: DraftImageStore,
    references: Callable[[int | None, int], tuple[ReferenceBody, ...]],
    client_for: Callable[[ModelSelection], Any],
    problem_metadata: Callable[..., dict[str, Any]],
) -> None:
    """Add the draft endpoints to ``app``."""

    def _draft(draft_id: UUID) -> Any:
        try:
            return drafts.get(draft_id)
        except DraftNotFoundError as error:
            raise _not_found() from error

    def _selection(payload: DraftGenerationRequest) -> ModelSelection:
        try:
            return ModelSelection(
                provider=LlmProvider(payload.provider),
                model=payload.model or _default_model(payload.provider),
            )
        except (DomainValidationError, ValueError) as error:
            raise ApiError(
                status=422,
                code="invalid_provider_selection",
                title="Invalid provider selection",
                detail="provider 또는 model 값이 유효하지 않습니다.",
            ) from error

    def _default_model(provider: str) -> str:
        from naver_blog_assistant.domain.llm import DEFAULT_MODELS  # noqa: PLC0415

        return DEFAULT_MODELS[LlmProvider(provider)]

    @app.post(
        "/api/v1/drafts",
        response_model=DraftResponse,
        status_code=201,
        responses={422: problem_metadata("The draft could not be created.")},
        tags=["Writing"],
        operation_id="createPostDraft",
    )
    async def create_draft(payload: DraftCreateRequest) -> DraftResponse:
        return DraftResponse.from_domain(
            drafts.create(
                draft_id=uuid4(),
                title=payload.title.strip(),
                seed_text=payload.seed_text,
                category_no=payload.category_no,
                use_image_vision=payload.use_image_vision,
            )
        )

    @app.get(
        "/api/v1/drafts",
        response_model=DraftListResponse,
        responses={422: problem_metadata("The request parameters are invalid.")},
        tags=["Writing"],
        operation_id="listPostDrafts",
    )
    async def list_drafts(
        limit: Annotated[int, Query(ge=1, le=50)] = 20,
    ) -> DraftListResponse:
        return DraftListResponse.from_domain(drafts.list(limit=limit))

    @app.get(
        "/api/v1/drafts/{draft_id}",
        response_model=DraftResponse,
        responses={
            404: problem_metadata("The draft does not exist."),
            422: problem_metadata("The draft identifier is invalid."),
        },
        tags=["Writing"],
        operation_id="getPostDraft",
    )
    async def get_draft(draft_id: UUID) -> DraftResponse:
        return DraftResponse.from_domain(_draft(draft_id))

    @app.patch(
        "/api/v1/drafts/{draft_id}",
        response_model=DraftResponse,
        responses={
            404: problem_metadata("The draft or revision does not exist."),
            422: problem_metadata("The request changes nothing usable."),
        },
        tags=["Writing"],
        operation_id="updatePostDraft",
    )
    async def update_draft(draft_id: UUID, payload: DraftPatchRequest) -> DraftResponse:
        _draft(draft_id)
        try:
            if payload.active_revision_id is not None:
                drafts.activate_revision(draft_id, payload.active_revision_id)
            updated = drafts.update_draft(
                draft_id,
                title=None if payload.title is None else payload.title.strip(),
                category_no=payload.category_no,
                use_image_vision=payload.use_image_vision,
            )
        except DraftNotFoundError as error:
            raise _not_found() from error
        return DraftResponse.from_domain(updated)

    @app.delete(
        "/api/v1/drafts/{draft_id}",
        status_code=204,
        responses={
            404: problem_metadata("The draft does not exist."),
            422: problem_metadata("The draft identifier is invalid."),
        },
        tags=["Writing"],
        operation_id="deletePostDraft",
    )
    async def delete_draft(draft_id: UUID) -> None:
        try:
            drafts.delete(draft_id)
        except DraftNotFoundError as error:
            raise _not_found() from error
        images.delete_draft(draft_id)

    @app.post(
        "/api/v1/drafts/{draft_id}/images",
        response_model=DraftResponse,
        status_code=201,
        responses={
            404: problem_metadata("The draft does not exist."),
            409: problem_metadata("The draft already holds the maximum number of images."),
            422: problem_metadata("The upload is not an allowed image."),
        },
        tags=["Writing"],
        operation_id="uploadDraftImage",
    )
    async def upload_image(
        draft_id: UUID,
        file: Annotated[UploadFile, File()],
        alt_text: Annotated[str, Form()] = "",
    ) -> DraftResponse:
        draft = _draft(draft_id)
        if len(draft.images) >= MAX_IMAGES:
            raise ApiError(
                status=409,
                code="image_limit_reached",
                title="Image limit reached",
                detail=f"한 글에는 이미지를 {MAX_IMAGES}장까지 올릴 수 있습니다.",
            )
        content = await file.read()
        try:
            stored = images.save(
                draft_id=draft_id,
                content=content,
                mime=file.content_type or "",
                original_filename=file.filename or "image",
            )
            updated = drafts.add_image(
                DraftImage(
                    id=stored.id,
                    draft_id=draft_id,
                    ordinal=drafts.next_image_ordinal(draft_id),
                    stored_path=stored.relative_path,
                    original_filename=stored.original_filename,
                    byte_size=stored.byte_size,
                    mime=stored.mime,
                    alt_text=alt_text.strip()[:300],
                )
            )
        except DomainValidationError as error:
            raise ApiError(
                status=422,
                code="invalid_image",
                title="Invalid image",
                detail=str(error),
            ) from error
        return DraftResponse.from_domain(updated)

    @app.delete(
        "/api/v1/drafts/{draft_id}/images/{image_id}",
        response_model=DraftResponse,
        responses={
            404: problem_metadata("The draft or image does not exist."),
            422: problem_metadata("An identifier is invalid."),
        },
        tags=["Writing"],
        operation_id="deleteDraftImage",
    )
    async def delete_image(draft_id: UUID, image_id: UUID) -> DraftResponse:
        try:
            updated, path = drafts.remove_image(draft_id, image_id)
        except DraftNotFoundError as error:
            raise _not_found() from error
        if path is not None:
            images.delete(path)
        return DraftResponse.from_domain(updated)

    @app.post(
        "/api/v1/drafts/{draft_id}/compose",
        response_model=DraftResponse,
        responses={
            404: problem_metadata("The draft does not exist."),
            422: problem_metadata("The draft or the generated body is unusable."),
            502: problem_metadata("Generation failed."),
            503: problem_metadata("The provider is not configured."),
        },
        tags=["Writing"],
        operation_id="composePostDraft",
    )
    async def compose_draft(draft_id: UUID, payload: DraftGenerationRequest) -> DraftResponse:
        draft = _draft(draft_id)
        client = _resolve_client(client_for, _selection(payload))
        try:
            updated = await compose.compose(
                draft_id=draft_id,
                client=client,
                references=references(draft.category_no, payload.reference_limit),
                options=WritingOptions(
                    length=payload.length, tone=payload.tone, structure=payload.structure
                ),
            )
        except WritingRefusedError as error:
            raise _writing_error(error) from error
        return DraftResponse.from_domain(updated)

    @app.post(
        "/api/v1/drafts/{draft_id}/refine",
        response_model=DraftResponse,
        responses={
            404: problem_metadata("The draft does not exist."),
            422: problem_metadata("The draft has no body to refine."),
            502: problem_metadata("Generation failed."),
            503: problem_metadata("The provider is not configured."),
        },
        tags=["Writing"],
        operation_id="refinePostDraft",
    )
    async def refine_draft(draft_id: UUID, payload: DraftGenerationRequest) -> DraftResponse:
        _draft(draft_id)
        client = _resolve_client(client_for, _selection(payload))
        try:
            updated = await compose.refine(
                draft_id=draft_id, client=client, request=payload.request
            )
        except WritingRefusedError as error:
            raise _writing_error(error) from error
        return DraftResponse.from_domain(updated)

    @app.post(
        "/api/v1/drafts/{draft_id}/tags",
        response_model=DraftResponse,
        responses={
            404: problem_metadata("The draft does not exist."),
            422: problem_metadata("No usable tag could be generated."),
            502: problem_metadata("Generation failed."),
            503: problem_metadata("The provider is not configured."),
        },
        tags=["Writing"],
        operation_id="generateDraftTags",
    )
    async def generate_tags(draft_id: UUID, payload: DraftGenerationRequest) -> DraftResponse:
        _draft(draft_id)
        client = _resolve_client(client_for, _selection(payload))
        try:
            updated = await compose.generate_tags(draft_id=draft_id, client=client)
        except WritingRefusedError as error:
            raise _writing_error(error) from error
        return DraftResponse.from_domain(drafts.update_draft(updated.id, status=DraftStatus.TAGGED))

    @app.patch(
        "/api/v1/drafts/{draft_id}/tags",
        response_model=DraftResponse,
        responses={
            404: problem_metadata("The draft does not exist."),
            422: problem_metadata("The tag selection is unusable."),
        },
        tags=["Writing"],
        operation_id="updateDraftTags",
    )
    async def update_tags(draft_id: UUID, payload: DraftTagPatchRequest) -> DraftResponse:
        draft = _draft(draft_id)
        wanted = (
            None
            if payload.selected is None
            else {normalize_tag(value).casefold() for value in payload.selected}
        )
        kept = [
            type(tag)(
                tag=tag.tag,
                ordinal=index,
                source=tag.source,
                selected=tag.selected if wanted is None else tag.tag.casefold() in wanted,
            )
            for index, tag in enumerate(draft.tags)
        ]
        existing = {tag.tag.casefold() for tag in kept}
        for tag in normalize_tags(payload.added or [], source=TagSource.USER):
            if tag.tag.casefold() in existing or len(kept) >= 50:
                continue
            existing.add(tag.tag.casefold())
            kept.append(type(tag)(tag=tag.tag, ordinal=len(kept), source=TagSource.USER))
        return DraftResponse.from_domain(drafts.replace_tags(draft_id, kept))


def _resolve_client(client_for: Callable[[ModelSelection], Any], selection: ModelSelection) -> Any:
    try:
        return client_for(selection)
    except Exception as error:  # noqa: BLE001 - the registry reports one refusal type
        raise ApiError(
            status=503,
            code="generation_unavailable",
            title="Generation unavailable",
            detail="선택한 provider가 구성되지 않았습니다.",
        ) from error


def _writing_error(error: WritingRefusedError) -> ApiError:
    return ApiError(
        status=422,
        code=error.code,
        title="Draft not usable",
        detail=WRITING_DETAILS[error.code],
    )


def _not_found() -> ApiError:
    return ApiError(
        status=404,
        code="draft_not_found",
        title="Draft not found",
        detail="해당 초안을 찾을 수 없습니다.",
    )
