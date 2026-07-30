"""Problem mapping for automation transport errors."""

from __future__ import annotations

import pytest

from naver_blog_assistant.api.routers.automation import SESSION_ERROR_MAP, to_api_error
from naver_blog_assistant.application.automation import (
    AutomationError,
    BrowserSessionAlreadyRunningError,
    BrowserSessionBusyError,
    BrowserSessionNotRunningError,
    BrowserSessionOperationFailedError,
    BrowserSessionUnavailableError,
)


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (BrowserSessionAlreadyRunningError(), 409, "browser_session_already_running"),
        (BrowserSessionBusyError(), 409, "browser_session_busy"),
        (BrowserSessionNotRunningError(), 409, "browser_session_not_running"),
        (BrowserSessionUnavailableError(), 503, "browser_unavailable"),
        (BrowserSessionOperationFailedError(), 502, "browser_operation_failed"),
    ],
)
def test_known_failures_map_to_stable_codes(error: Exception, status: int, code: str) -> None:
    mapped = to_api_error(error)

    assert mapped.status == status
    assert mapped.code == code
    assert mapped.detail


def test_unmapped_automation_failures_fall_back_to_a_bad_gateway_problem() -> None:
    mapped = to_api_error(AutomationError("unexpected"))

    assert mapped.status == 502
    assert mapped.code == "browser_operation_failed"


def test_unexpected_exception_types_never_leak_their_message() -> None:
    mapped = to_api_error(RuntimeError("profile /home/user/secret is locked"))

    assert "secret" not in mapped.detail
    assert mapped.code == "browser_operation_failed"


def test_every_mapped_error_uses_a_snake_case_code() -> None:
    for status, code, title, detail in SESSION_ERROR_MAP.values():
        assert 400 <= status <= 599
        assert code == code.lower()
        assert " " not in code
        assert title
        assert detail
