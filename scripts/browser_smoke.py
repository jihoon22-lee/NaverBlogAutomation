"""Start the automation browser once and report its redacted fingerprint state.

The check prints only non-sensitive values: the resolved driver, the dedicated profile path, the
`navigator.webdriver` result, and whether a page could be evaluated. It never prints page content,
cookies, or screenshots.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from naver_blog_assistant.application.automation import BrowserSessionManager
from naver_blog_assistant.infrastructure.browser import create_browser_driver, resolve_profile_dir

DEFAULT_PROBE_URL = "about:blank"


async def _report(
    *,
    driver_name: str,
    headless: bool,
    profile_dir: Path,
    probe_url: str,
    channel: str,
) -> list[str]:
    driver = create_browser_driver(driver_name)
    sessions = BrowserSessionManager(
        driver,
        profile_dir=profile_dir,
        headless=headless,
        channel=channel or None,
        login_probe_url=probe_url,
    )
    lines: list[str] = []
    try:
        status = await sessions.launch()
        lines.append(f"driver={status.driver}")
        lines.append(f"channel={channel or 'bundled-chromium'}")
        lines.append(f"state={status.state.value}")
        lines.append(f"login={status.login.value}")
        lines.append(f"headless={str(status.headless).lower()}")
        lines.append(f"profile_dir={status.profile_dir}")
        page = await sessions.primary_page()
        lines.append(f"navigator.webdriver={await page.evaluate('() => navigator.webdriver')}")
        lines.append(f"title_length={len(str(await page.evaluate('() => document.title')))}")
        lines.append(f"screenshot_bytes={len(await sessions.screenshot())}")
    finally:
        await sessions.shutdown()
    return lines


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--driver",
        default=os.getenv("AUTOMATION_DRIVER", "patchright"),
        help="patchright, playwright, or fake",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="run without a visible window; the real flow uses a visible window",
    )
    parser.add_argument(
        "--url",
        default=DEFAULT_PROBE_URL,
        help="page used for the one-time login probe; defaults to about:blank",
    )
    parser.add_argument(
        "--profile-dir",
        default=os.getenv("AUTOMATION_PROFILE_DIR", ""),
        help="override the dedicated persistent profile directory",
    )
    parser.add_argument(
        "--channel",
        default=os.getenv("AUTOMATION_BROWSER_CHANNEL", "chrome"),
        help="browser channel such as chrome; pass an empty value to use bundled Chromium",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Print the redacted browser session report and return a process exit code."""
    arguments = _parser().parse_args(argv)
    profile_dir = resolve_profile_dir(
        configured=arguments.profile_dir,
        platform=sys.platform,
        environment=os.environ,
        home=Path.home(),
    )
    try:
        lines = asyncio.run(
            _report(
                driver_name=arguments.driver,
                headless=arguments.headless,
                profile_dir=profile_dir,
                probe_url=arguments.url,
                channel=arguments.channel.strip(),
            )
        )
    except Exception as error:  # noqa: BLE001 - report the failure without a stack trace
        print(f"browser smoke failed: {type(error).__name__}: {error}")
        return 1
    for line in lines:
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
