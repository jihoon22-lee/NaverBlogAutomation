"""Start the local API, wait for it, and open the independent web app once."""

from __future__ import annotations

import argparse
import json
import os
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
# The first import of optional LLM SDKs can be slow on mounted or virus-scanned filesystems.
# Do not interrupt a healthy local startup before it has a realistic chance to bind its port.
STARTUP_TIMEOUT_SECONDS = 60.0
STARTUP_PROGRESS_SECONDS = 5.0

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
    """Wait for a child process to bind, stopping when it exits first."""
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    progress_deadline = time.monotonic() + STARTUP_PROGRESS_SECONDS
    progress_reported = False
    while time.monotonic() < deadline:
        if _is_healthy():
            return True
        if process.poll() is not None:
            return False
        if not progress_reported and time.monotonic() >= progress_deadline:
            print(
                "Local API를 준비하고 있습니다. 처음 실행은 최대 60초 걸릴 수 있습니다.",
                file=sys.stderr,
            )
            progress_reported = True
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
    """Run the API under a small supervisor and open ``/app/`` after health succeeds."""
    command = (
        "uv",
        "run",
        "--frozen",
        "--env-file",
        str(environment_file),
        "naver-blog-api",
    )
    restart_marker = environment_file.parent / f".{environment_file.name}.restart"
    restart_marker.unlink(missing_ok=True)
    process = _launch_child(
        command,
        environment_file=environment_file,
        restart_marker=restart_marker,
        launch=launch,
    )
    try:
        if not _wait_for_health(process):
            exit_code = process.poll()
            if exit_code is None:
                print(
                    "오류: Local API가 60초 안에 준비되지 않았습니다. "
                    "네트워크 드라이브나 보안 검사 환경에서는 첫 시작이 느릴 수 있습니다.",
                    file=sys.stderr,
                )
            else:
                print(
                    "오류: Local API가 준비 전에 종료되었습니다 "
                    f"(종료 코드: {exit_code}). 이 terminal 위쪽의 상세 오류를 확인해 주세요.",
                    file=sys.stderr,
                )
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
        if launch is not None:
            # Embedding callers own the provided process and retain the old wait contract.
            return process.wait()
        while True:
            exit_code = process.poll()
            if exit_code is not None:
                return exit_code
            if not restart_marker.exists():
                time.sleep(0.1)
                continue
            restart_marker.unlink(missing_ok=True)
            print("저장한 연결 설정을 적용하기 위해 로컬 서비스를 다시 시작합니다.")
            _terminate(process)
            process = _launch_child(
                command,
                environment_file=environment_file,
                restart_marker=restart_marker,
                launch=None,
            )
            if not _wait_for_health(process):
                _terminate(process)
                print("오류: 재시작한 Local API가 준비되지 않았습니다.", file=sys.stderr)
                return 1
    except KeyboardInterrupt:
        _terminate(process)
        return 130


def _launch_child(
    command: Sequence[str],
    *,
    environment_file: Path,
    restart_marker: Path,
    launch: LaunchProcess | None,
) -> subprocess.Popen[bytes]:
    """Start a child with only private file paths passed out-of-band from the browser."""
    if launch is not None:
        return launch(command, REPOSITORY_ROOT)
    environment = {
        **os.environ,
        "NBA_RUNTIME_CONFIG_FILE": str(environment_file),
        "NBA_SUPERVISOR_RESTART_FILE": str(restart_marker),
    }
    return subprocess.Popen(command, cwd=REPOSITORY_ROOT, env=environment)


def main(arguments: Sequence[str] | None = None) -> None:
    """Parse the selected private environment path and propagate the API exit code."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    options = parser.parse_args(arguments)
    raise SystemExit(start_webapp(environment_file=options.env_file.expanduser()))


if __name__ == "__main__":
    main()
