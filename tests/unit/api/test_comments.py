"""Failure and cancellation contracts for the comment transport adapter."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from types import SimpleNamespace
from typing import cast
from uuid import uuid4

import pytest
from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient

from naver_blog_assistant.api.errors import ApiError, api_error_handler
from naver_blog_assistant.api.routers.comments import (
    _generate,
    _RefinementRequests,
    register_comment_routes,
)
from naver_blog_assistant.application import (
    GenerateRecommendation,
    GenerationIndeterminateError,
    GenerationInProgressError,
    GenerationInvalidError,
    GenerationRateLimitedError,
    GenerationRefusedError,
    GenerationResult,
    GenerationUnavailableError,
    GetRecommendation,
    IdempotencyConflictError,
    RecommendationNotFoundError,
    RefineComment,
    ReplayedGenerationFailure,
)
from naver_blog_assistant.application.automation import ExtractArticle, PlanGeneration
from naver_blog_assistant.application.llm import BudgetExceededError, FanOutGeneration
from naver_blog_assistant.application.refine_comment import RefinedComment
from naver_blog_assistant.domain import LlmProvider, ModelSelection
from naver_blog_assistant.infrastructure.browser import PageBundleMissingError
from naver_blog_assistant.ports import GenerationFailureSnapshot


def _plan() -> SimpleNamespace:
    """Provide only the fields consumed by the transport's generation adapter."""
    return SimpleNamespace(post=object(), preferences=object(), personalization_mode=object())


class _Extraction:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error

    async def execute(self, _url: str) -> object:
        if self.error is not None:
            raise self.error
        return object()


class _Planner:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error

    def execute(self, *_args: object) -> SimpleNamespace:
        if self.error is not None:
            raise self.error
        return SimpleNamespace(
            post=object(),
            request_hash="request-hash",
            preferences=object(),
            personalization_mode=object(),
        )

    def key_for(self, *_args: object) -> tuple[int, str]:
        return 1, str(uuid4())


class _Fanout:
    def __init__(self, result: object | None = None, error: Exception | None = None) -> None:
        self.result = result
        self.error = error

    async def execute(self, **_kwargs: object) -> object:
        if self.error is not None:
            raise self.error
        return self.result


def _metadata(*_args: object, **_kwargs: object) -> dict[str, object]:
    return {}


async def _handle_api_error(request: Request, error: Exception) -> Response:
    assert isinstance(error, ApiError)
    return await api_error_handler(request, error)


def _app(
    *,
    extractions: _Extraction | None = None,
    planner: _Planner | None = None,
    fanout: object | None = None,
    selection_for: Callable[[str, str | None], ModelSelection] | None = None,
    get: object | None = None,
    refiner: object | None = None,
    client_for: Callable[[ModelSelection], object] | None = None,
    timeout_seconds: float = 1,
) -> FastAPI:
    app = FastAPI()
    app.add_exception_handler(ApiError, _handle_api_error)

    def track(_task: asyncio.Task[GenerationResult]) -> None:
        return None

    register_comment_routes(
        app,
        extractions=cast(ExtractArticle, extractions or _Extraction()),
        generate=cast(GenerateRecommendation, _FailingGenerator(GenerationUnavailableError())),
        planner=cast(PlanGeneration, planner or _Planner()),
        problem_metadata=_metadata,
        timeout_seconds=timeout_seconds,
        track=track,
        fanout=cast(FanOutGeneration | None, fanout),
        selection_for=selection_for,
        client_for=client_for,
        get=cast(GetRecommendation | None, get),
        refiner=cast(RefineComment | None, refiner),
    )
    return app


def _fanout_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "url": "https://blog.naver.com/example/223456789012",
        "providers": [{"provider": "openai"}],
    }
    payload.update(overrides)
    return payload


def _refinement_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "current_comment": "현재 댓글입니다.",
        "preset": "natural",
        "provider": "openai",
    }
    payload.update(overrides)
    return payload


def _valid_selection(_provider: str, model: str | None) -> ModelSelection:
    return ModelSelection(provider=LlmProvider.OPENAI, model=model or "test")


def _invalid_selection(_provider: str, _model: str | None) -> ModelSelection:
    raise ValueError("invalid provider selection")


def _unavailable_client(_selection: ModelSelection) -> object:
    raise GenerationUnavailableError()


def test_comment_route_maps_missing_page_bundle_to_dependency_error() -> None:
    with TestClient(_app(extractions=_Extraction(PageBundleMissingError("missing")))) as client:
        response = client.post(
            "/api/v1/automation/comments",
            json={"url": "https://blog.naver.com/example/223456789012"},
        )

    assert response.status_code == 503
    assert response.json()["code"] == "browser_unavailable"


@pytest.mark.parametrize(
    ("configured", "planner", "selection", "fanout", "status", "code"),
    [
        (False, _Planner(), None, None, 503, "generation_unavailable"),
        (
            True,
            _Planner(ValueError("invalid options")),
            _valid_selection,
            _Fanout(),
            422,
            "invalid_generation_options",
        ),
        (True, _Planner(), _invalid_selection, _Fanout(), 422, "invalid_provider_selection"),
        (
            True,
            _Planner(),
            _valid_selection,
            _Fanout(error=BudgetExceededError("daily_cap_exceeded", limit=2, observed=2)),
            402,
            "daily_cap_exceeded",
        ),
        (
            True,
            _Planner(),
            _valid_selection,
            _Fanout(result=SimpleNamespace(succeeded=())),
            502,
            "fanout_all_failed",
        ),
    ],
)
def test_fanout_route_preserves_dependency_and_partial_failure_contracts(
    configured: bool,
    planner: _Planner,
    selection: Callable[[str, str | None], ModelSelection] | None,
    fanout: _Fanout | None,
    status: int,
    code: str,
) -> None:
    with TestClient(
        _app(
            planner=planner,
            fanout=fanout if configured else None,
            selection_for=selection if configured else None,
        )
    ) as client:
        response = client.post(
            "/api/v1/automation/comments/fanout",
            json=_fanout_payload(),
        )

    assert response.status_code == status
    assert response.json()["code"] == code


class _Get:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error

    def execute(self, _recommendation_id: object) -> object:
        if self.error is not None:
            raise self.error
        return object()


class _Refiner:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error

    def execute(self, **_kwargs: object) -> RefinedComment:
        if self.error is not None:
            raise self.error
        return RefinedComment(text="다듬은 댓글입니다.", provider=LlmProvider.OPENAI, model="test")


def _refine_request(client: TestClient, recommendation_id: str, key: str, **payload: object):
    return client.post(
        f"/api/v1/recommendations/{recommendation_id}/refine",
        json=_refinement_payload(**payload),
        headers={"Idempotency-Key": key},
    )


@pytest.mark.parametrize(
    ("get_error", "selection", "client", "status", "code"),
    [
        (
            RecommendationNotFoundError(uuid4()),
            _valid_selection,
            lambda _selection: object(),
            404,
            "recommendation_not_found",
        ),
        (None, _invalid_selection, lambda _selection: object(), 422, "invalid_provider_selection"),
        (None, _valid_selection, _unavailable_client, 503, "generation_unavailable"),
    ],
)
def test_refinement_route_rejects_invalid_lookup_and_provider_configuration(
    get_error: Exception | None,
    selection: Callable[[str, str | None], ModelSelection],
    client: Callable[[ModelSelection], object],
    status: int,
    code: str,
) -> None:
    recommendation_id = str(uuid4())
    get = _Get(get_error)
    with TestClient(
        _app(
            get=get,
            selection_for=selection,
            client_for=client,
            refiner=_Refiner(),
        )
    ) as test_client:
        response = _refine_request(test_client, recommendation_id, str(uuid4()))

    assert response.status_code == status
    assert response.json()["code"] == code


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (GenerationUnavailableError(), 503, "generation_unavailable"),
        (RuntimeError("provider rejected request"), 502, "generation_refused"),
    ],
)
def test_refinement_route_normalizes_provider_failures(
    error: Exception,
    status: int,
    code: str,
) -> None:
    with TestClient(
        _app(
            get=_Get(),
            selection_for=_valid_selection,
            client_for=lambda _selection: object(),
            refiner=_Refiner(error),
        )
    ) as client:
        response = _refine_request(client, str(uuid4()), str(uuid4()))

    assert response.status_code == status
    assert response.json()["code"] == code


def test_refinement_route_rejects_reuse_of_a_key_for_different_input() -> None:
    recommendation_id = str(uuid4())
    key = str(uuid4())
    with TestClient(
        _app(
            get=_Get(),
            selection_for=_valid_selection,
            client_for=lambda _selection: object(),
            refiner=_Refiner(),
        )
    ) as client:
        first = _refine_request(client, recommendation_id, key)
        conflict = _refine_request(client, recommendation_id, key, preset="warmer")

    assert first.status_code == 200
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "idempotency_conflict"


class _FailingGenerator:
    def __init__(self, error: Exception) -> None:
        self.error = error

    def execute(self, **_kwargs: object) -> None:
        raise self.error


@pytest.mark.parametrize(
    ("error", "status", "code", "retry_after", "replayed"),
    [
        (IdempotencyConflictError(), 409, "idempotency_conflict", None, False),
        (GenerationInProgressError(), 409, "generation_in_progress", None, False),
        (GenerationIndeterminateError(), 409, "generation_indeterminate", None, False),
        (GenerationRateLimitedError(retry_after=19), 429, "generation_rate_limited", 19, False),
        (GenerationRefusedError(), 502, "generation_refused", None, False),
        (GenerationInvalidError(), 502, "generation_invalid", None, False),
        (GenerationUnavailableError(), 503, "generation_unavailable", None, False),
        (
            ReplayedGenerationFailure(
                GenerationFailureSnapshot(502, "generation_refused", "Refused", "safe failure")
            ),
            502,
            "generation_refused",
            None,
            True,
        ),
    ],
)
def test_generate_preserves_stable_failure_contracts(
    error: Exception,
    status: int,
    code: str,
    retry_after: int | None,
    replayed: bool,
) -> None:
    """Every application failure remains distinguishable at the HTTP boundary."""

    async def scenario() -> None:
        tracked: list[asyncio.Task[object]] = []
        with pytest.raises(ApiError) as raised:
            await _generate(
                _plan(),
                str(uuid4()),
                1,
                cast(GenerateRecommendation, _FailingGenerator(error)),
                tracked.append,
            )

        assert raised.value.status == status
        assert raised.value.code == code
        assert raised.value.retry_after == retry_after
        assert raised.value.idempotency_replayed is replayed
        assert len(tracked) == 1
        assert tracked[0].done()

    asyncio.run(scenario())


def test_generate_timeout_shields_provider_work_for_same_key_recovery() -> None:
    """A client timeout must not cancel the provider task that can settle the idempotency key."""

    async def scenario() -> None:
        started = threading.Event()
        release = threading.Event()
        sentinel = object()
        tracked: list[asyncio.Task[object]] = []

        class SlowGenerator:
            def execute(self, **_kwargs: object) -> object:
                started.set()
                assert release.wait(timeout=1)
                return sentinel

        request = asyncio.create_task(
            _generate(
                _plan(),
                str(uuid4()),
                0.02,
                cast(GenerateRecommendation, SlowGenerator()),
                tracked.append,
            )
        )
        assert await asyncio.to_thread(started.wait, 1)

        with pytest.raises(ApiError) as raised:
            await request

        assert raised.value.status == 504
        assert raised.value.code == "generation_timeout"
        assert len(tracked) == 1
        assert not tracked[0].done()

        release.set()
        assert await tracked[0] is sentinel

    asyncio.run(scenario())


def test_refinement_timeout_keeps_request_for_a_later_replay() -> None:
    """An interrupted refinement remains replayable instead of starting a second provider call."""

    async def scenario() -> None:
        requests = _RefinementRequests()
        key = uuid4()
        started = threading.Event()
        release = threading.Event()
        calls = 0

        def refine() -> RefinedComment:
            nonlocal calls
            calls += 1
            started.set()
            assert release.wait(timeout=1)
            return RefinedComment(
                text="안전하게 다듬은 댓글", provider=LlmProvider.OPENAI, model="test"
            )

        timed_out = asyncio.create_task(
            requests.execute(
                key=key,
                request_hash="stable-request",
                timeout_seconds=0.02,
                run=refine,
            )
        )
        assert await asyncio.to_thread(started.wait, 1)
        with pytest.raises(TimeoutError):
            await timed_out

        entry = requests._items[key]
        assert not entry.task.done()
        release.set()

        result, replayed = await requests.execute(
            key=key,
            request_hash="stable-request",
            timeout_seconds=1,
            run=refine,
        )

        assert result.text == "안전하게 다듬은 댓글"
        assert replayed is False
        assert calls == 1

        replay, replayed = await requests.execute(
            key=key,
            request_hash="stable-request",
            timeout_seconds=1,
            run=refine,
        )
        assert replay is result
        assert replayed is True
        assert calls == 1

    asyncio.run(scenario())
