"""SQLite behavior for the provider attempt ledger."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy.engine import Engine

from naver_blog_assistant.domain.llm import LlmCallStatus, LlmProvider, ModelSelection
from naver_blog_assistant.infrastructure.database.engine import create_sqlite_engine
from naver_blog_assistant.infrastructure.database.llm_attempt_repository import (
    SqliteLlmAttemptRepository,
)
from naver_blog_assistant.infrastructure.database.schema import metadata

REQUEST_HASH = "c" * 64
OPENAI = ModelSelection(provider=LlmProvider.OPENAI, model="gpt-test")
GEMINI = ModelSelection(provider=LlmProvider.GEMINI, model="gemini-test")


@pytest.fixture
def engine(tmp_path: Path) -> Iterator[Engine]:
    created = create_sqlite_engine(f"sqlite:///{tmp_path / 'attempts.db'}")
    metadata.create_all(created)
    yield created
    created.dispose()


def test_it_records_one_attempt_per_selection(engine: Engine) -> None:
    repository = SqliteLlmAttemptRepository(engine)
    recommendation_id = uuid4()

    repository.record(
        request_hash=REQUEST_HASH,
        attempt=1,
        selection=OPENAI,
        status=LlmCallStatus.SUCCEEDED,
        result_code="generated",
        recommendation_id=recommendation_id,
    )
    repository.record(
        request_hash=REQUEST_HASH,
        attempt=1,
        selection=GEMINI,
        status=LlmCallStatus.FAILED,
        result_code="generation_refused",
    )

    stored = repository.for_request(REQUEST_HASH, 1)
    assert [record.selection.provider for record in stored] == [
        LlmProvider.GEMINI,
        LlmProvider.OPENAI,
    ]
    assert stored[1].recommendation_id == recommendation_id
    assert stored[0].result_code == "generation_refused"


def test_recording_the_same_selection_twice_replaces_the_row(engine: Engine) -> None:
    repository = SqliteLlmAttemptRepository(engine)
    repository.record(
        request_hash=REQUEST_HASH,
        attempt=1,
        selection=OPENAI,
        status=LlmCallStatus.INDETERMINATE,
        result_code="generation_timeout",
    )

    repository.record(
        request_hash=REQUEST_HASH,
        attempt=1,
        selection=OPENAI,
        status=LlmCallStatus.SUCCEEDED,
        result_code="generated",
    )

    stored = repository.for_request(REQUEST_HASH, 1)
    assert len(stored) == 1
    assert stored[0].status is LlmCallStatus.SUCCEEDED


def test_a_replacement_attempt_is_a_separate_row(engine: Engine) -> None:
    repository = SqliteLlmAttemptRepository(engine)
    for attempt in (1, 2):
        repository.record(
            request_hash=REQUEST_HASH,
            attempt=attempt,
            selection=OPENAI,
            status=LlmCallStatus.SUCCEEDED,
            result_code="generated",
        )

    assert len(repository.for_request(REQUEST_HASH, 1)) == 1
    assert len(repository.for_request(REQUEST_HASH, 2)) == 1


def test_it_counts_only_attempts_after_the_given_moment(engine: Engine) -> None:
    repository = SqliteLlmAttemptRepository(engine)
    repository.record(
        request_hash=REQUEST_HASH,
        attempt=1,
        selection=OPENAI,
        status=LlmCallStatus.SUCCEEDED,
        result_code="generated",
    )

    now = datetime.now(UTC)
    assert repository.count_since(now - timedelta(hours=1)) == 1
    assert repository.count_since(now + timedelta(hours=1)) == 0


def test_it_keeps_the_retry_delay(engine: Engine) -> None:
    repository = SqliteLlmAttemptRepository(engine)

    recorded = repository.record(
        request_hash=REQUEST_HASH,
        attempt=1,
        selection=GEMINI,
        status=LlmCallStatus.FAILED,
        result_code="generation_rate_limited",
        retry_after=13,
    )

    assert recorded.retry_after == 13
    assert repository.for_request(REQUEST_HASH, 1)[0].retry_after == 13


def test_an_empty_request_has_no_attempts(engine: Engine) -> None:
    assert SqliteLlmAttemptRepository(engine).for_request(REQUEST_HASH, 1) == []
