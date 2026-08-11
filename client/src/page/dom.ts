/**
 * Shared DOM helpers for the injected page scripts.
 *
 * The bundled page script shares these helpers across every probe while still producing one
 * self-contained browser artifact.
 *
 * These scripts are read-only: they locate elements, report state, and return a stable selector for
 * the caller. Clicking and typing happen through trusted CDP input in the Python layer, because a
 * synthetic `element.click()` is both detectable and ignored by some handlers.
 */

export const EXCLUDED_TAGS: ReadonlySet<string> = new Set([
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

export const BLOCK_TAGS: ReadonlySet<string> = new Set([
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

export const EXCLUDED_IDENTITY_TOKENS: readonly string[] = [
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

/** Return true when the element itself is hidden, disabled, or an excluded region. */
export function isVisible(element: Element): boolean {
  const asHtml = element as HTMLElement;
  if (asHtml.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const view = element.ownerDocument.defaultView;
  if (view === null) return true;
  const style = view.getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    style.pointerEvents !== "none" &&
    (style.opacity === "" || Number(style.opacity) !== 0)
  );
}

/** Return true only when the element and every ancestor is interactable. */
export function isInteractable(element: Element): boolean {
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    if (!isVisible(current)) return false;
  }
  return true;
}

/** Return true when the element accepts typed input. */
export function isEditable(element: Element): boolean {
  const asHtml = element as HTMLElement;
  if (element.tagName === "TEXTAREA") {
    const textarea = element as HTMLTextAreaElement;
    return !textarea.disabled && !textarea.readOnly;
  }
  return (
    (asHtml.isContentEditable || element.getAttribute("contenteditable") === "true") &&
    element.getAttribute("aria-disabled") !== "true"
  );
}

/** Return true when a control is enabled for activation. */
export function isEnabled(element: Element): boolean {
  return (
    !element.hasAttribute("disabled") &&
    element.getAttribute("aria-disabled") !== "true" &&
    isInteractable(element)
  );
}

/** Read the current text of a textarea or contenteditable element. */
export function readValue(element: Element): string {
  if (element.tagName === "TEXTAREA") return (element as HTMLTextAreaElement).value;
  return element.textContent ?? "";
}

/** Return true when the element has a non-zero rendered box. */
export function hasRenderedBox(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Return a document-unique CSS selector for `element`.
 *
 * The Python layer resolves this selector again before dispatching trusted input, so it must be
 * stable within the captured document rather than pretty.
 */
export function elementSelector(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current !== null && current.nodeType === 1) {
    if (current.tagName === "HTML") {
      segments.unshift("html");
      break;
    }
    const parent: Element | null = current.parentElement;
    if (parent === null) {
      segments.unshift(current.tagName.toLowerCase());
      break;
    }
    let index = 1;
    for (const sibling of parent.children) {
      if (sibling === current) break;
      if (sibling.tagName === current.tagName) index += 1;
    }
    segments.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index})`);
    current = parent;
  }
  return segments.join(" > ");
}

/** Normalize newlines and collapse inline whitespace without dropping paragraph breaks. */
export function normalizeExtractedText(value: string): string {
  return value
    .replace(/\u00a0/gu, " ")
    .split(/\r?\n/gu)
    .map((line) => line.replace(/[\t\f\v ]+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Return true when the element is an excluded region for article extraction. */
export function isExcludedRegion(element: Element): boolean {
  if (EXCLUDED_TAGS.has(element.tagName) || element.hasAttribute("hidden")) return true;
  if (element.getAttribute("aria-hidden")?.toLowerCase() === "true") return true;
  const identity = `${element.id} ${element.className}`.toLowerCase();
  if (EXCLUDED_IDENTITY_TOKENS.some((token) => identity.includes(token))) return true;
  const view = element.ownerDocument.defaultView;
  if (view !== null) {
    const style = view.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return true;
  }
  return false;
}

/** Return true when the element or any ancestor is an excluded region. */
export function isInsideExcludedRegion(element: Element): boolean {
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    if (isExcludedRegion(current)) return true;
  }
  return false;
}

/** Collect visible text under `root`, normalizing while traversing to bound memory use. */
export function collectVisibleText(
  root: Element,
  maximum: number,
): { originalLength: number; text: string } {
  const retained: string[] = [];
  let originalLength = 0;
  let hasContent = false;
  let lineHasContent = false;
  let pendingSpace = false;

  const retain = (point: string): void => {
    originalLength += 1;
    if (retained.length < maximum) retained.push(point);
  };

  const consume = (value: string): void => {
    for (const rawPoint of value) {
      const point = rawPoint === "\u00a0" ? " " : rawPoint;
      if (point === "\n" || point === "\r") {
        lineHasContent = false;
        pendingSpace = false;
      } else if (point === " " || point === "\t" || point === "\f" || point === "\v") {
        if (lineHasContent) pendingSpace = true;
      } else {
        if (!lineHasContent && hasContent) retain("\n");
        lineHasContent = true;
        hasContent = true;
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
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (isExcludedRegion(element)) return;
    const block = BLOCK_TAGS.has(element.tagName);
    if (block) consume("\n");
    for (const child of element.childNodes) visit(child);
    if (block) consume("\n");
  };
  visit(root);
  return { originalLength, text: retained.join("") };
}

/** Collect matching elements for every selector in order, skipping duplicates. */
export function queryAllUnique(selectors: readonly string[], scope: ParentNode): Element[] {
  const seen = new Set<Element>();
  const found: Element[] = [];
  for (const selector of selectors) {
    for (const element of scope.querySelectorAll(selector)) {
      if (seen.has(element)) continue;
      seen.add(element);
      found.push(element);
    }
  }
  return found;
}
