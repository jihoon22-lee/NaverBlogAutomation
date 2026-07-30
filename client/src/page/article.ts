/**
 * Article capture for one document.
 *
 * Ported from the extension's `captureCurrentFrame`. The supported-host gate moved to the Python
 * layer so the same script can run against synthetic fixtures, and the caller decides which frame
 * result wins.
 */

import { collectVisibleText, isInsideExcludedRegion, normalizeExtractedText } from "./dom";

export const MAX_BODY_CODE_POINTS = 100_000;
export const MAX_TITLE_CODE_POINTS = 300;

export type ArticleSelectorKind = "modern" | "legacy" | "semantic";

export interface ArticleCapture {
  body: string;
  canonicalUrl: string | null;
  documentUrl: string;
  originalLength: number;
  selectorConfidence: number;
  selectorKind: ArticleSelectorKind;
  title: string;
}

interface SelectorDefinition {
  confidence: number;
  kind: ArticleSelectorKind;
  selector: string;
}

const SELECTOR_DEFINITIONS: readonly SelectorDefinition[] = [
  { confidence: 500, kind: "modern", selector: ".se-main-container" },
  { confidence: 430, kind: "legacy", selector: "#postViewArea" },
  { confidence: 400, kind: "legacy", selector: ".post_ct" },
  { confidence: 380, kind: "legacy", selector: ".post-view" },
  { confidence: 260, kind: "semantic", selector: "article" },
  { confidence: 220, kind: "semantic", selector: '[role="main"]' },
];

const TITLE_SELECTORS: readonly string[] = [".se-title-text", ".pcol1", ".post-title", "h1"];

interface Candidate {
  body: string;
  confidence: number;
  kind: ArticleSelectorKind;
  originalLength: number;
  root: Element;
}

/** Capture the strongest article candidate in the current document, or null when none matches. */
export function captureArticle(): ArticleCapture | null {
  const selected = selectStrongestCandidate();
  if (selected === null) return null;
  let title = findNearbyTitle(selected.root);
  if (title.length === 0) {
    title =
      readAttribute('meta[property="og:title"]', "content") ||
      normalizeExtractedText(document.title);
  }
  const canonicalUrl =
    readAttribute('link[rel="canonical"]', "href") ||
    readAttribute('meta[property="og:url"]', "content") ||
    null;
  return {
    body: selected.body,
    canonicalUrl,
    documentUrl: window.location.href,
    originalLength: selected.originalLength,
    selectorConfidence: selected.confidence,
    selectorKind: selected.kind,
    title,
  };
}

function selectStrongestCandidate(): Candidate | null {
  let selected: Candidate | null = null;
  const visited = new Set<Element>();
  for (const definition of SELECTOR_DEFINITIONS) {
    for (const element of document.querySelectorAll(definition.selector)) {
      if (visited.has(element) || isInsideExcludedRegion(element)) continue;
      visited.add(element);
      const collected = collectVisibleText(element, MAX_BODY_CODE_POINTS);
      if (collected.originalLength === 0) continue;
      const candidate: Candidate = {
        body: collected.text,
        confidence: definition.confidence,
        kind: definition.kind,
        originalLength: collected.originalLength,
        root: element,
      };
      if (
        selected === null ||
        candidate.confidence > selected.confidence ||
        (candidate.confidence === selected.confidence &&
          candidate.originalLength > selected.originalLength)
      ) {
        selected = candidate;
      }
    }
  }
  return selected;
}

function readAttribute(selector: string, attribute: string): string {
  return document.querySelector(selector)?.getAttribute(attribute)?.trim() ?? "";
}

function findTitleInScope(scope: Element): string {
  for (const selector of TITLE_SELECTORS) {
    const walker = document.createTreeWalker(scope, 1);
    let element: Element | null = scope;
    while (element !== null) {
      if (element.matches(selector) && !isInsideExcludedRegion(element)) {
        const title = collectVisibleText(element, MAX_TITLE_CODE_POINTS).text;
        if (title.length > 0) return title;
      }
      element = walker.nextNode() as Element | null;
    }
  }
  return "";
}

function findNearbyTitle(root: Element): string {
  const localTitle = findTitleInScope(root);
  if (localTitle.length > 0) return localTitle;

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
        if (title.length > 0) return title;
        previous = previous.previousElementSibling;
      }
      if (following !== null) {
        const title = findTitleInScope(following);
        if (title.length > 0) return title;
        following = following.nextElementSibling;
      }
    }
    anchor = anchor.parentElement;
  }
  return "";
}
