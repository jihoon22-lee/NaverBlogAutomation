"""Install and call the injected page bundle inside an isolated browser context.

The bundle is built from `client/src/page` by `npm --prefix client run build:page` and ships inside
the wheel. Every exported probe is read-only: it reports element state and a document-unique
selector so the automation layer can act with trusted CDP input instead of a synthetic
`element.click()`.
"""

from __future__ import annotations

from importlib.resources import files
from pathlib import Path
from typing import Any, Final

from naver_blog_assistant.ports.browser import BrowserOperationError, EvaluationTarget

BUNDLE_PACKAGE: Final = "naver_blog_assistant.infrastructure.browser.bundles"
BUNDLE_FILENAME: Final = "page.js"
BUNDLE_NAMESPACE: Final = "__nbaPage"
BUNDLE_VERSION: Final = 1

PAGE_PROBES: Final = frozenset(
    {
        "captchaVisible",
        "captureArticle",
        "commentStillPending",
        "countMatchingComments",
        "diagnoseCommentPage",
        "probeComment",
        "probeLike",
        "probeLikeOption",
        "probeNeighborApplication",
        "probeNeighborConfirmation",
        "probeNeighborOption",
        "probeNeighborRelationship",
    }
)

_CALL_EXPRESSION: Final = f"""(argument) => {{
  const bundle = globalThis.{BUNDLE_NAMESPACE};
  if (bundle === undefined || bundle.version !== {BUNDLE_VERSION}) {{
    return {{ installed: false, value: null }};
  }}
  return {{ installed: true, value: bundle[argument.name](...argument.args) }};
}}"""


class PageBundleMissingError(RuntimeError):
    """Raised when the built page bundle is not present in the installed package."""


def load_page_bundle() -> str:
    """Return the built page bundle source, or explain how to build it."""
    resource = files(BUNDLE_PACKAGE).joinpath(BUNDLE_FILENAME)
    try:
        source = resource.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError) as error:
        raise PageBundleMissingError(
            "the page bundle is missing; run `npm --prefix client run build:page`"
        ) from error
    if len(source.strip()) == 0:
        raise PageBundleMissingError("the page bundle is empty")
    return source


def bundle_path() -> Path:
    """Return the on-disk bundle path for build and packaging checks."""
    return Path(str(files(BUNDLE_PACKAGE).joinpath(BUNDLE_FILENAME)))


class PageScriptRunner:
    """Call read-only probes from the page bundle, installing it on demand."""

    def __init__(self, bundle: str | None = None) -> None:
        self._bundle = bundle if bundle is not None else load_page_bundle()

    @property
    def bundle(self) -> str:
        """Return the bundle source that will be installed."""
        return self._bundle

    async def install(self, target: EvaluationTarget) -> None:
        """Install the bundle in the target's isolated context."""
        await target.evaluate(self._bundle)

    async def call(self, target: EvaluationTarget, name: str, *args: Any) -> Any:
        """Call one named probe, installing the bundle first when it is absent."""
        if name not in PAGE_PROBES:
            raise ValueError(f"{name} is not an exposed page probe")
        payload = {"args": list(args), "name": name}
        result = await target.evaluate(_CALL_EXPRESSION, payload)
        if not isinstance(result, dict):
            raise BrowserOperationError("the page bundle returned an unexpected result")
        if result.get("installed") is not True:
            await self.install(target)
            result = await target.evaluate(_CALL_EXPRESSION, payload)
            if not isinstance(result, dict) or result.get("installed") is not True:
                raise BrowserOperationError("the page bundle could not be installed")
        return result.get("value")
