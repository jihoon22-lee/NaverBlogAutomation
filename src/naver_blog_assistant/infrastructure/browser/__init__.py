"""Browser automation adapters for the locally owned session."""

from naver_blog_assistant.infrastructure.browser.driver_factory import (
    DRIVER_MODULES,
    SUPPORTED_DRIVERS,
    create_browser_driver,
)
from naver_blog_assistant.infrastructure.browser.fake import (
    FakeBrowserContext,
    FakeBrowserDriver,
    FakeFrame,
    FakePage,
)
from naver_blog_assistant.infrastructure.browser.playwright_driver import PlaywrightBrowserDriver
from naver_blog_assistant.infrastructure.browser.profile import resolve_profile_dir

__all__ = [
    "DRIVER_MODULES",
    "FakeBrowserContext",
    "FakeBrowserDriver",
    "FakeFrame",
    "FakePage",
    "PlaywrightBrowserDriver",
    "SUPPORTED_DRIVERS",
    "create_browser_driver",
    "resolve_profile_dir",
]
