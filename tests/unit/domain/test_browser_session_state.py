"""Tests for the browser session state machine and its redacted snapshot."""

from __future__ import annotations

import pytest

from naver_blog_assistant.domain import (
    BrowserLoginState,
    BrowserSessionState,
    BrowserSessionStatus,
    DomainValidationError,
    TriggerKind,
    assert_session_transition,
)

ALLOWED = (
    (BrowserSessionState.STOPPED, BrowserSessionState.LAUNCHING),
    (BrowserSessionState.LAUNCHING, BrowserSessionState.READY),
    (BrowserSessionState.LAUNCHING, BrowserSessionState.STOPPED),
    (BrowserSessionState.READY, BrowserSessionState.CLOSING),
    (BrowserSessionState.CLOSING, BrowserSessionState.STOPPED),
)
FORBIDDEN = (
    (BrowserSessionState.STOPPED, BrowserSessionState.READY),
    (BrowserSessionState.STOPPED, BrowserSessionState.CLOSING),
    (BrowserSessionState.STOPPED, BrowserSessionState.STOPPED),
    (BrowserSessionState.LAUNCHING, BrowserSessionState.CLOSING),
    (BrowserSessionState.LAUNCHING, BrowserSessionState.LAUNCHING),
    (BrowserSessionState.READY, BrowserSessionState.LAUNCHING),
    (BrowserSessionState.READY, BrowserSessionState.READY),
    (BrowserSessionState.READY, BrowserSessionState.STOPPED),
    (BrowserSessionState.CLOSING, BrowserSessionState.READY),
    (BrowserSessionState.CLOSING, BrowserSessionState.LAUNCHING),
    (BrowserSessionState.CLOSING, BrowserSessionState.CLOSING),
)


@pytest.mark.parametrize(("current", "target"), ALLOWED)
def test_forward_only_transitions_are_accepted(
    current: BrowserSessionState, target: BrowserSessionState
) -> None:
    assert_session_transition(current, target)


@pytest.mark.parametrize(("current", "target"), FORBIDDEN)
def test_transitions_outside_the_state_machine_are_rejected(
    current: BrowserSessionState, target: BrowserSessionState
) -> None:
    with pytest.raises(DomainValidationError, match="cannot move"):
        assert_session_transition(current, target)


def test_ready_status_reports_pages_and_login() -> None:
    status = BrowserSessionStatus(
        state=BrowserSessionState.READY,
        login=BrowserLoginState.AUTHENTICATED,
        driver="patchright",
        headless=False,
        profile_dir="/profiles/automation",
        open_pages=2,
    )

    assert status.open_pages == 2
    assert status.detail is None


def test_status_requires_a_driver_name() -> None:
    with pytest.raises(DomainValidationError, match="driver name"):
        BrowserSessionStatus(
            state=BrowserSessionState.STOPPED,
            login=BrowserLoginState.UNKNOWN,
            driver="   ",
            headless=True,
            profile_dir="/profiles/automation",
            open_pages=0,
        )


def test_status_rejects_negative_page_counts() -> None:
    with pytest.raises(DomainValidationError, match="negative"):
        BrowserSessionStatus(
            state=BrowserSessionState.READY,
            login=BrowserLoginState.UNKNOWN,
            driver="fake",
            headless=True,
            profile_dir="/profiles/automation",
            open_pages=-1,
        )


@pytest.mark.parametrize(
    "state",
    [BrowserSessionState.STOPPED, BrowserSessionState.LAUNCHING, BrowserSessionState.CLOSING],
)
def test_only_a_ready_session_can_report_open_pages(state: BrowserSessionState) -> None:
    with pytest.raises(DomainValidationError, match="open pages"):
        BrowserSessionStatus(
            state=state,
            login=BrowserLoginState.UNKNOWN,
            driver="fake",
            headless=True,
            profile_dir="/profiles/automation",
            open_pages=1,
        )


@pytest.mark.parametrize("login", [BrowserLoginState.AUTHENTICATED, BrowserLoginState.ANONYMOUS])
def test_login_state_is_observable_only_while_ready(login: BrowserLoginState) -> None:
    with pytest.raises(DomainValidationError, match="login state"):
        BrowserSessionStatus(
            state=BrowserSessionState.STOPPED,
            login=login,
            driver="fake",
            headless=True,
            profile_dir="/profiles/automation",
            open_pages=0,
        )


def test_trigger_kinds_cover_manual_session_and_schedule() -> None:
    assert [kind.value for kind in TriggerKind] == ["manual", "session", "schedule"]
