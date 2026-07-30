"""Select the configured browser driver without leaking library imports upward."""

from __future__ import annotations

from typing import Final

from naver_blog_assistant.infrastructure.browser.fake import FakeBrowserDriver
from naver_blog_assistant.infrastructure.browser.playwright_driver import PlaywrightBrowserDriver
from naver_blog_assistant.ports.browser import BrowserDriver

DRIVER_MODULES: Final[dict[str, str]] = {
    "patchright": "patchright.async_api",
    "playwright": "playwright.async_api",
}
SUPPORTED_DRIVERS: Final = frozenset({*DRIVER_MODULES, "fake"})


def create_browser_driver(name: str) -> BrowserDriver:
    """Return the driver named by ``AUTOMATION_DRIVER``.

    ``patchright`` is the default because it avoids the ``Runtime.enable`` leak and removes the
    ``--enable-automation`` flag; ``playwright`` stays available for debugging because patchright
    disables the Console API.
    """
    normalized = name.strip().lower()
    if normalized == "fake":
        return FakeBrowserDriver()
    module = DRIVER_MODULES.get(normalized)
    if module is None:
        raise ValueError("AUTOMATION_DRIVER must be patchright, playwright, or fake")
    return PlaywrightBrowserDriver(name=normalized, module_name=module)
