"""Real-socket smoke test for the fixed loopback launcher."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def test_launcher_serves_health_on_loopback(tmp_path: Path) -> None:
    with socket.socket() as candidate:
        candidate.bind(("127.0.0.1", 0))
        port = candidate.getsockname()[1]

    environment = os.environ.copy()
    environment.update(
        {
            "API_HOST": "127.0.0.1",
            "API_PORT": str(port),
            "APP_ENV": "test",
            "COMMENT_GENERATOR_MODE": "fake",
            "CHROME_EXTENSION_ORIGIN": ("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            "DATABASE_URL": f"sqlite:///{tmp_path / 'socket-smoke.db'}",
        }
    )
    process = subprocess.Popen(
        [sys.executable, "-m", "naver_blog_assistant.api"],
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/health", timeout=1
                ) as response:
                    assert response.status == 200
                    assert json.load(response) == {"status": "ok"}
                    break
            except OSError as error:
                if process.poll() is not None:
                    raise AssertionError(
                        "local API process exited before becoming healthy"
                    ) from error
                if time.monotonic() >= deadline:
                    raise AssertionError(
                        "local API did not become healthy within 10 seconds"
                    ) from error
                time.sleep(0.1)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
