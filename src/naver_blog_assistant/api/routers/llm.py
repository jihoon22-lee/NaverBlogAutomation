"""Provider configuration endpoint for the local web app.

The response says whether a provider can be called, never how. API keys stay in the process
environment and never appear in a response or a log line.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import FastAPI

from naver_blog_assistant.api.models import LlmProvidersResponse
from naver_blog_assistant.domain import ProviderAvailability


def register_llm_routes(
    app: FastAPI,
    *,
    availability: Callable[[], list[ProviderAvailability]],
    problem_metadata: Callable[..., dict[str, Any]],
) -> None:
    """Add the provider configuration endpoint to ``app``."""
    del problem_metadata

    @app.get(
        "/api/v1/llm/providers",
        response_model=LlmProvidersResponse,
        tags=["Generation"],
        operation_id="listLlmProviders",
    )
    async def list_llm_providers() -> LlmProvidersResponse:
        return LlmProvidersResponse.from_domain(availability())
