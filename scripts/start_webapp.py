"""Start the local API, wait for it, and open the independent web app once."""

from __future__ import annotations

import argparse
import json
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from collections.abc import Callable, Sequence
from pathlib import Path

from naver_blog_assistant.api.runtime import (
    LOOPBACK_HOST,
    LOOPBACK_PORT,
)
from scripts._local_runtime import REPOSITORY_ROOT

WEB_APP_URL = f"http://{LOOPBACK_HOST}:{LOOPBACK_PORT}/app/"
STARTUP_TIMEOUT_SECONDS = 12.0

OpenBrowser = Callable[[str], bool]
LaunchProcess = Callable[[Sequence[str], Path], subprocess.Popen[bytes]]


def _is_healthy() -> bool:
    """Return whether the service responds to its unauthenticated local health check."""
    try:
        with urllib.request.urlopen(
            f"http://{LOOPBACK_HOST}:{LOOPBACK_PORT}/health", timeout=0.5
        ) as reply:
            return reply.status == 200
    except OSError, urllib.error.URLError:
        return False


def _wait_for_health(process: subprocess.Popen[bytes]) -> bool:
    """Wait briefly for a child process to bind, stopping when it exits first."""
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if _is_healthy():
            return True
        if process.poll() is not None:
            return False
        time.sleep(0.1)
    return False


def _read_readiness() -> dict[str, object] | None:
    """Read the child service's redacted access mode instead of parsing a private env file."""
    try:
        with urllib.request.urlopen(
            f"http://{LOOPBACK_HOST}:{LOOPBACK_PORT}/api/v1/app/readiness", timeout=0.5
        ) as reply:
            payload = json.load(reply)
    except OSError, ValueError, urllib.error.URLError:
        return None
    return payload if isinstance(payload, dict) else None


def _terminate(process: subprocess.Popen[bytes]) -> None:
    """Stop a child process we started while preserving a normal Ctrl+C outcome."""
    if process.poll() is not None:
        return
    process.send_signal(signal.SIGINT)
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=3)


def start_webapp(
    *,
    environment_file: Path,
    launch: LaunchProcess | None = None,
    open_browser: OpenBrowser = webbrowser.open,
) -> int:
    """Run the API until it exits and open ``/app/`` only after health succeeds."""
    command = (
        "uv",
        "run",
        "--frozen",
        "--env-file",
        str(environment_file),
        "naver-blog-api",
    )
    process = (
        launch(command, REPOSITORY_ROOT)
        if launch is not None
        else subprocess.Popen(command, cwd=REPOSITORY_ROOT)
    )
    try:
        if not _wait_for_health(process):
            print("오류: Local API가 시작 시간 안에 준비되지 않았습니다.", file=sys.stderr)
            _terminate(process)
            return 1
        if not open_browser(WEB_APP_URL):
            print(f"웹앱을 자동으로 열지 못했습니다. 브라우저에서 {WEB_APP_URL}을 여세요.")
        readiness = _read_readiness()
        if readiness is not None and readiness.get("access_mode") == "lan":
            addresses = readiness.get("lan_addresses")
            hosts = addresses if isinstance(addresses, list) else []
            for host in sorted(address for address in hosts if isinstance(address, str)):
                print(f"같은 신뢰 Wi-Fi의 태블릿 연결 주소: http://{host}:{LOOPBACK_PORT}/app/")
        return process.wait()
    except KeyboardInterrupt:
        _terminate(process)
        return 130


def main(arguments: Sequence[str] | None = None) -> None:
    """Parse the selected private environment path and propagate the API exit code."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    options = parser.parse_args(arguments)
    raise SystemExit(start_webapp(environment_file=options.env_file.expanduser()))


if __name__ == "__main__":
    main()
