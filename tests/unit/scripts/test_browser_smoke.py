"""Tests for the redacted browser smoke report."""

from __future__ import annotations

from pathlib import Path

import pytest
from scripts import browser_smoke


def test_fake_driver_report_prints_only_redacted_fields(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    exit_code = browser_smoke.main(
        ["--driver", "fake", "--headless", "--profile-dir", str(tmp_path / "profile")]
    )

    printed = capsys.readouterr().out
    assert exit_code == 0
    assert "driver=fake" in printed
    assert "state=ready" in printed
    assert "login=unknown" in printed
    assert "headless=true" in printed
    assert f"profile_dir={tmp_path / 'profile'}" in printed
    assert "screenshot_bytes=" in printed


def test_unknown_driver_reports_a_failure_without_a_stack_trace(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    exit_code = browser_smoke.main(
        ["--driver", "selenium", "--profile-dir", str(tmp_path / "profile")]
    )

    printed = capsys.readouterr().out
    assert exit_code == 1
    assert "browser smoke failed" in printed
    assert "AUTOMATION_DRIVER" in printed
    assert "Traceback" not in printed


def test_launch_failure_is_reported_as_a_single_line(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    exit_code = browser_smoke.main(
        [
            "--driver",
            "patchright",
            "--headless",
            "--channel",
            "definitely-not-a-channel",
            "--profile-dir",
            str(tmp_path / "profile"),
        ]
    )

    printed = capsys.readouterr().out.strip()
    assert exit_code == 1
    assert printed.startswith("browser smoke failed")
    assert len(printed.splitlines()) == 1


def test_report_defaults_to_the_configured_environment_driver(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("AUTOMATION_DRIVER", "fake")
    monkeypatch.setenv("AUTOMATION_PROFILE_DIR", str(tmp_path / "from-env"))
    monkeypatch.setenv("AUTOMATION_BROWSER_CHANNEL", "")

    exit_code = browser_smoke.main(["--headless"])

    printed = capsys.readouterr().out
    assert exit_code == 0
    assert "driver=fake" in printed
    assert "channel=bundled-chromium" in printed
    assert str(tmp_path / "from-env") in printed
