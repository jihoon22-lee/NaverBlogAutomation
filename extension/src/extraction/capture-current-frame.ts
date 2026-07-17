import type { RawFrameCapture } from "./types";

/**
 * Capture one article candidate from the current frame.
 *
 * Chrome serializes this function when it is passed to scripting.executeScript. Keep every runtime
 * helper and selector inside the function: imported values and module-level closures are not
 * available in the isolated page world.
 */
export function captureCurrentFrame(): RawFrameCapture | null {
  const maximumBodyCodePoints = 100_000;
  const maximumTitleCodePoints = 300;
  const supportedHosts = new Set(["blog.naver.com", "m.blog.naver.com"]);
  const currentUrl = new URL(window.location.href);
  if (currentUrl.protocol !== "https:" || !supportedHosts.has(currentUrl.hostname)) {
    return null;
  }

  const selectorDefinitions = [
    { confidence: 500, kind: "modern" as const, selector: ".se-main-container" },
    { confidence: 430, kind: "legacy" as const, selector: "#postViewArea" },
    { confidence: 400, kind: "legacy" as const, selector: ".post_ct" },
    { confidence: 380, kind: "legacy" as const, selector: ".post-view" },
    { confidence: 260, kind: "semantic" as const, selector: "article" },
    { confidence: 220, kind: "semantic" as const, selector: '[role="main"]' },
  ];
  const excludedTags = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "SVG",
    "NAV",
    "ASIDE",
    "FOOTER",
    "FORM",
    "BUTTON",
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "OPTION",
  ]);
  const blockTags = new Set([
    "ADDRESS",
    "ARTICLE",
    "BLOCKQUOTE",
    "BR",
    "DIV",
    "FIGCAPTION",
    "FIGURE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HR",
    "LI",
    "MAIN",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TD",
    "TH",
    "TR",
    "UL",
  ]);
  const excludedTokens = [
    "comment",
    "reply",
    "replies",
    "share",
    "splugin",
    "recommend",
    "related",
    "promotion",
    "advert",
    "sidebar",
    "navigation",
  ];

  const normalize = (value: string): string =>
    value
      .replace(/\u00a0/gu, " ")
      .split(/\r?\n/gu)
      .map((line) => line.replace(/[\t\f\v ]+/gu, " ").trim())
      .filter((line) => line.length > 0)
      .join("\n");

  const isExcluded = (element: Element): boolean => {
    if (excludedTags.has(element.tagName) || element.hasAttribute("hidden")) {
      return true;
    }
    if (element.getAttribute("aria-hidden")?.toLowerCase() === "true") {
      return true;
    }
    const identity = `${element.id} ${element.className}`.toLowerCase();
    if (excludedTokens.some((token) => identity.includes(token))) {
      return true;
    }
    const view = element.ownerDocument.defaultView;
    if (view !== null) {
      const style = view.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return true;
      }
    }
    return false;
  };

  const isInsideExcludedTree = (element: Element): boolean => {
    let current: Element | null = element;
    while (current !== null) {
      if (isExcluded(current)) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  };

  /** Normalize while traversing so untrusted pages cannot make us retain their entire text. */
  const collectVisibleText = (
    root: Element,
    maximum: number,
  ): { originalLength: number; text: string } => {
    const retained: string[] = [];
    let originalLength = 0;
    let hasContent = false;
    let lineHasContent = false;
    let pendingSpace = false;

    const retain = (point: string): void => {
      originalLength += 1;
      if (retained.length < maximum) {
        retained.push(point);
      }
    };

    const beginLineContent = (): void => {
      if (!lineHasContent && hasContent) {
        retain("\n");
      }
      lineHasContent = true;
      hasContent = true;
    };

    const consume = (value: string): void => {
      for (const rawPoint of value) {
        const point = rawPoint === "\u00a0" ? " " : rawPoint;
        if (point === "\n" || point === "\r") {
          lineHasContent = false;
          pendingSpace = false;
        } else if (point === " " || point === "\t" || point === "\f" || point === "\v") {
          if (lineHasContent) {
            pendingSpace = true;
          }
        } else {
          beginLineContent();
          if (pendingSpace) {
            retain(" ");
            pendingSpace = false;
          }
          retain(point);
        }
      }
    };

    const visit = (node: Node): void => {
      if (node.nodeType === 3) {
        consume(node.nodeValue ?? "");
        return;
      }
      if (node.nodeType !== 1) {
        return;
      }
      const element = node as Element;
      if (isExcluded(element)) {
        return;
      }
      const block = blockTags.has(element.tagName);
      if (block) {
        consume("\n");
      }
      for (const child of element.childNodes) {
        visit(child);
      }
      if (block) {
        consume("\n");
      }
    };
    visit(root);
    return { originalLength, text: retained.join("") };
  };

  type Candidate = {
    body: string;
    confidence: number;
    kind: "modern" | "legacy" | "semantic";
    originalLength: number;
    root: Element;
  };
  let selected: Candidate | undefined;
  const visited = new Set<Element>();
  for (const definition of selectorDefinitions) {
    for (const element of document.querySelectorAll(definition.selector)) {
      if (visited.has(element) || isInsideExcludedTree(element)) {
        continue;
      }
      visited.add(element);
      const collected = collectVisibleText(element, maximumBodyCodePoints);
      if (collected.originalLength > 0) {
        const candidate: Candidate = {
          body: collected.text,
          confidence: definition.confidence,
          kind: definition.kind,
          originalLength: collected.originalLength,
          root: element,
        };
        if (
          selected === undefined ||
          candidate.confidence > selected.confidence ||
          (candidate.confidence === selected.confidence &&
            candidate.originalLength > selected.originalLength)
        ) {
          selected = candidate;
        }
      }
    }
  }
  if (selected === undefined) {
    return null;
  }

  const readContent = (selector: string, attribute: string): string =>
    document.querySelector(selector)?.getAttribute(attribute)?.trim() ?? "";
  const titleSelectors = [".se-title-text", ".pcol1", ".post-title", "h1"];
  const findTitleInScope = (scope: Element): string => {
    for (const selector of titleSelectors) {
      const walker = document.createTreeWalker(scope, 1);
      let element: Element | null = scope;
      while (element !== null) {
        if (element.matches(selector) && !isInsideExcludedTree(element)) {
          const title = collectVisibleText(element, maximumTitleCodePoints).text;
          if (title.length > 0) {
            return title;
          }
        }
        element = walker.nextNode() as Element | null;
      }
    }
    return "";
  };
  const findNearbyTitle = (root: Element): string => {
    const localTitle = findTitleInScope(root);
    if (localTitle.length > 0) {
      return localTitle;
    }

    let anchor: Element | null = root;
    for (let depth = 0; anchor !== null && depth < 4; depth += 1) {
      let previous = anchor.previousElementSibling;
      let following = anchor.nextElementSibling;
      for (
        let distance = 0;
        distance < 8 && (previous !== null || following !== null);
        distance += 1
      ) {
        if (previous !== null) {
          const title = findTitleInScope(previous);
          if (title.length > 0) {
            return title;
          }
          previous = previous.previousElementSibling;
        }
        if (following !== null) {
          const title = findTitleInScope(following);
          if (title.length > 0) {
            return title;
          }
          following = following.nextElementSibling;
        }
      }
      anchor = anchor.parentElement;
    }
    return "";
  };
  let title = findNearbyTitle(selected.root);
  if (title.length === 0) {
    title = readContent('meta[property="og:title"]', "content") || normalize(document.title);
  }
  const canonicalUrl =
    readContent('link[rel="canonical"]', "href") ||
    readContent('meta[property="og:url"]', "content") ||
    null;

  return {
    body: selected.body,
    canonicalUrl,
    frameUrl: window.location.href,
    originalLength: selected.originalLength,
    selectorConfidence: selected.confidence,
    selectorKind: selected.kind,
    title,
  };
}
