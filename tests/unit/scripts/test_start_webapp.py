"""Tests for opening the independent web app only after the local API is ready."""

from pathlib import Path
from unittest.mock import Mock

from scripts import start_webapp


def test_start_webapp_opens_the_app_after_health_succeeds(monkeypatch) -> None:
    process = Mock()
    process.poll.return_value = None
    process.wait.return_value = 0
    launch = Mock(return_value=process)
    open_browser = Mock(return_value=True)
    monkeypatch.setattr(start_webapp, "_wait_for_health", lambda _: True)
    monkeypatch.setattr(start_webapp, "_read_readiness", lambda: {"access_mode": "local"})

    result = start_webapp.start_webapp(
        environment_file=Path("/private/env"),
        launch=launch,
        open_browser=open_browser,
    )

    assert result == 0
    open_browser.assert_called_once_with(start_webapp.WEB_APP_URL)
    assert launch.call_args.args[0][-1] == "naver-blog-api"


def test_start_webapp_stops_an_unhealthy_api_without_opening_a_browser(monkeypatch) -> None:
    process = Mock()
    process.poll.return_value = None
    launch = Mock(return_value=process)
    open_browser = Mock(return_value=True)
    monkeypatch.setattr(start_webapp, "_wait_for_health", lambda _: False)

    result = start_webapp.start_webapp(
        environment_file=Path("/private/env"),
        launch=launch,
        open_browser=open_browser,
    )

    assert result == 1
    open_browser.assert_not_called()
    process.send_signal.assert_called_once()


def test_start_webapp_prints_server_reported_tablet_addresses(monkeypatch, capsys) -> None:
    process = Mock()
    process.poll.return_value = None
    process.wait.return_value = 0
    monkeypatch.setattr(start_webapp, "_wait_for_health", lambda _: True)
    monkeypatch.setattr(
        start_webapp,
        "_read_readiness",
        lambda: {"access_mode": "lan", "lan_addresses": ["192.168.1.20"]},
    )

    result = start_webapp.start_webapp(
        environment_file=Path("/private/env"),
        launch=Mock(return_value=process),
        open_browser=Mock(return_value=True),
    )

    assert result == 0
    assert "http://192.168.1.20:8765/app/" in capsys.readouterr().out
