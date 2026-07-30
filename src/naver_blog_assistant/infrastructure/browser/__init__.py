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
from naver_blog_assistant.infrastructure.browser.page_scripts import (
    BUNDLE_NAMESPACE,
    BUNDLE_VERSION,
    PAGE_PROBES,
    PageBundleMissingError,
    PageScriptRunner,
    bundle_path,
    load_page_bundle,
)
from naver_blog_assistant.infrastructure.browser.playwright_driver import PlaywrightBrowserDriver
from naver_blog_assistant.infrastructure.browser.profile import resolve_profile_dir

__all__ = [
    "BUNDLE_NAMESPACE",
    "BUNDLE_VERSION",
    "DRIVER_MODULES",
    "FakeBrowserContext",
    "FakeBrowserDriver",
    "FakeFrame",
    "FakePage",
    "PAGE_PROBES",
    "PageBundleMissingError",
    "PageScriptRunner",
    "PlaywrightBrowserDriver",
    "SUPPORTED_DRIVERS",
    "bundle_path",
    "create_browser_driver",
    "load_page_bundle",
    "resolve_profile_dir",
]
