/**
 * Read-only probes for the Naver post editor.
 *
 * The probes report which stage the editor is in and which selectors to act on; the Python layer
 * performs every click, keystroke, and file attachment with trusted input. Anything ambiguous is
 * reported as such so the caller can stop instead of guessing.
 */

import { elementSelector, isEnabled, isVisible, queryAllUnique, readValue } from "./dom";

export type EditorStage = "restore_prompt" | "ready" | "not_found" | "ambiguous" | "login_required";

export interface EditorProbe {
  stage: EditorStage;
  titleSelector: string | null;
  bodySelector: string | null;
  /** The component container used only for semantic post-action snapshots. */
  editorRootSelector: string | null;
  imageInputSelector: string | null;
  imageCaptionSelector: string | null;
  saveSelector: string | null;
  tagInputSelector: string | null;
  restoreCancelSelector: string | null;
  /** Individually verified toolbar controls. Missing is deliberately unsupported. */
  blockActionSelectors: Partial<Record<EditorBlockSnapshot["type"], string>>;
}

export interface EditorSaveProbe {
  saved: boolean;
  savedCount: number | null;
  diagnosis: "captcha_required" | "login_required" | null;
}

/** A read-only, semantic snapshot used to refuse a staging result whose block order changed. */
export interface EditorBlockSnapshot {
  type: "heading" | "paragraph" | "quote" | "ordered_list" | "unordered_list" | "divider" | "image";
  text?: string;
  items?: string[];
  caption?: string;
}

const RESTORE_SELECTORS =
  ".se-popup-alert-confirm, .se-popup-restore, [class*='restore'] button, ._restorePopup";
const RESTORE_CANCEL_SELECTORS =
  ".se-popup-alert-cancel, .se-popup-button-cancel, button[class*='cancel' i]";
const TITLE_SELECTORS: readonly string[] = [
  ".se-section-documentTitle .se-text-paragraph",
  ".se-documentTitle .se-text-paragraph",
  "textarea.se-documentTitle",
  "#subject",
  "input[name='subject']",
];
const BODY_SELECTORS: readonly string[] = [
  ".se-component-content .se-text-paragraph",
  ".se-main-container .se-text-paragraph",
  "div.se-content[contenteditable='true']",
  "#editorContainer [contenteditable='true']",
];
const EDITOR_ROOT_SELECTORS: readonly string[] = [
  ".se-main-container",
  ".se-component-container",
  "#editorContainer",
];
const BLOCK_ACTION_SELECTORS: Readonly<
  Record<Exclude<EditorBlockSnapshot["type"], "paragraph" | "image">, readonly string[]>
> = {
  heading: [
    "button[aria-label*='소제목']",
    "button[title*='소제목']",
    "button[data-command='heading']",
  ],
  quote: ["button[aria-label*='인용']", "button[title*='인용']", "button[data-command='quote']"],
  ordered_list: [
    "button[aria-label*='번호 목록']",
    "button[title*='번호 목록']",
    "button[data-command='ordered-list']",
  ],
  unordered_list: [
    "button[aria-label*='글머리']",
    "button[title*='글머리']",
    "button[data-command='unordered-list']",
  ],
  divider: [
    "button[aria-label*='구분선']",
    "button[title*='구분선']",
    "button[data-command='divider']",
  ],
};
const IMAGE_INPUT_SELECTORS: readonly string[] = [
  "input[type='file'][accept*='image']",
  "input.se-image-file-input",
  "input[type='file']",
];
const IMAGE_CAPTION_SELECTORS: readonly string[] = [
  "input[aria-label*='이미지 설명']",
  "input[placeholder*='이미지 설명']",
  "textarea[aria-label*='이미지 설명']",
];
const TAG_INPUT_SELECTORS: readonly string[] = [
  "input[aria-label*='태그']",
  "input[placeholder*='태그']",
  "input[data-command='tags']",
];
const SAVE_SELECTORS: readonly string[] = [
  "button.save_btn__bzc5B",
  "button[class*='save' i]",
  "a[class*='save' i]",
  "._btn_save",
];
const SAVED_COUNT_SELECTORS = ".text__d09H7, [class*='save'] [class*='count']";
const LOGIN_SELECTORS = "a[href*='nidlogin.login'], form[action*='nidlogin.login']";
const CAPTCHA_SELECTORS = ".captcha, #captcha, iframe[title*='캡차'], iframe[title*='captcha' i]";

/** Report which editor stage the page is in and the selectors to act on. */
export function probeEditor(): EditorProbe {
  if (hasVisible(LOGIN_SELECTORS)) return empty("login_required");
  const restore = firstVisible([RESTORE_SELECTORS]);
  if (restore !== null) {
    const cancel = firstVisible([RESTORE_CANCEL_SELECTORS]);
    return {
      ...empty("restore_prompt"),
      restoreCancelSelector: cancel === null ? null : elementSelector(cancel),
    };
  }
  const title = uniqueAcross(TITLE_SELECTORS);
  const body = uniqueAcross(BODY_SELECTORS);
  const editorRoot = uniqueAcross(EDITOR_ROOT_SELECTORS);
  const save = uniqueAcross(SAVE_SELECTORS);
  if (
    title === "ambiguous" ||
    body === "ambiguous" ||
    editorRoot === "ambiguous" ||
    save === "ambiguous"
  ) {
    return empty("ambiguous");
  }
  if (title === null || body === null || editorRoot === null || save === null)
    return empty("not_found");
  const imageInput = uniqueAcross(IMAGE_INPUT_SELECTORS, { requireVisible: false });
  const imageCaption = actionSelector(IMAGE_CAPTION_SELECTORS);
  const tagInput = actionSelector(TAG_INPUT_SELECTORS);
  return {
    stage: "ready",
    titleSelector: elementSelector(title),
    bodySelector: elementSelector(body),
    editorRootSelector: elementSelector(editorRoot),
    imageInputSelector:
      imageInput === null || imageInput === "ambiguous" ? null : elementSelector(imageInput),
    imageCaptionSelector: imageCaption,
    saveSelector: elementSelector(save),
    tagInputSelector: tagInput,
    restoreCancelSelector: null,
    blockActionSelectors: Object.fromEntries(
      Object.entries(BLOCK_ACTION_SELECTORS)
        .map(([kind, selectors]) => [kind, actionSelector(selectors)] as const)
        .filter((entry): entry is [string, string] => entry[1] !== null),
    ),
  };
}

/** Report whether the draft was saved, using the count next to the save control. */
export function probeEditorSave(): EditorSaveProbe {
  if (hasVisible(CAPTCHA_SELECTORS)) {
    return { saved: false, savedCount: null, diagnosis: "captcha_required" };
  }
  if (hasVisible(LOGIN_SELECTORS)) {
    return { saved: false, savedCount: null, diagnosis: "login_required" };
  }
  const count = readSavedCount();
  return { saved: count !== null && count > 0, savedCount: count, diagnosis: null };
}

/** Report the text the editor currently holds, so a caller can confirm its own input. */
export function readEditorText(selector: string): string {
  const element = document.querySelector(selector);
  if (element === null) return "";
  const value = readValue(element);
  return value.replace(/\u200b/gu, "").trim();
}

/**
 * Read the visible editor structure after trusted input.  This deliberately does not infer a
 * heading from large text or an image from a filename: an unknown structure is returned as null
 * and staging stops before saving.
 */
export function readEditorBlocks(selector: string): EditorBlockSnapshot[] | null {
  const root = document.querySelector(selector);
  if (root === null) return null;
  const components = Array.from(
    root.querySelectorAll(
      ":scope > .se-component, :scope > [data-a11y-title], :scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > blockquote, :scope > ol, :scope > ul, :scope > hr, :scope > figure",
    ),
  );
  if (components.length === 0) return null;
  const blocks: EditorBlockSnapshot[] = [];
  for (const component of components) {
    const candidate = component.matches(".se-component")
      ? (component.querySelector(
          "h1, h2, h3, h4, h5, h6, blockquote, ol, ul, hr, figure, p, .se-text-paragraph",
        ) ?? component)
      : component;
    const tag = candidate.tagName.toLowerCase();
    if (/^h[1-6]$/u.test(tag)) {
      blocks.push({ type: "heading", text: text(candidate) });
    } else if (tag === "blockquote") {
      blocks.push({ type: "quote", text: text(candidate) });
    } else if (tag === "ol" || tag === "ul") {
      const items = Array.from(candidate.querySelectorAll(":scope > li"), text).filter(Boolean);
      if (items.length === 0) return null;
      blocks.push({ type: tag === "ol" ? "ordered_list" : "unordered_list", items });
    } else if (tag === "hr") {
      blocks.push({ type: "divider" });
    } else if (tag === "figure" || candidate.querySelector("img") !== null) {
      const caption = text(candidate.querySelector("figcaption") ?? document.createElement("span"));
      blocks.push({ type: "image", caption });
    } else if (tag === "p" || candidate.classList.contains("se-text-paragraph")) {
      const value = text(candidate);
      if (!value) return null;
      blocks.push({ type: "paragraph", text: value });
    } else {
      return null;
    }
  }
  return blocks;
}

function text(element: Element): string {
  return (element.textContent ?? "").replace(/\u200b/gu, "").trim();
}

function readSavedCount(): number | null {
  for (const element of queryAllUnique([SAVED_COUNT_SELECTORS], document)) {
    const match = /(\d+)/u.exec((element.textContent ?? "").trim());
    if (match !== null) {
      const parsed = Number.parseInt(match[1] as string, 10);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return null;
}

function empty(stage: EditorStage): EditorProbe {
  return {
    stage,
    titleSelector: null,
    bodySelector: null,
    editorRootSelector: null,
    imageInputSelector: null,
    imageCaptionSelector: null,
    saveSelector: null,
    tagInputSelector: null,
    restoreCancelSelector: null,
    blockActionSelectors: {},
  };
}

function hasVisible(selectors: string): boolean {
  return queryAllUnique([selectors], document).some(isVisible);
}

function firstVisible(selectors: readonly string[]): Element | null {
  return queryAllUnique(selectors, document).find(isVisible) ?? null;
}

/** Return a trusted action target only when one visible enabled control is unambiguous. */
function actionSelector(selectors: readonly string[]): string | null {
  const result = uniqueAcross(selectors);
  return result === null || result === "ambiguous" ? null : elementSelector(result);
}

/**
 * Resolve one control only when all fallback selectors identify exactly the same visible target.
 * A toolbar that exposes multiple matching controls is not a safe automation target: the caller
 * must fail closed rather than selecting a convenient first button.
 */
function uniqueAcross(
  selectors: readonly string[],
  options: { requireVisible?: boolean } = {},
): Element | "ambiguous" | null {
  const requireVisible = options.requireVisible ?? true;
  const matches = queryAllUnique(selectors, document).filter(
    (element) => isEnabled(element) && (!requireVisible || isVisible(element)),
  );
  if (matches.length === 1) return matches[0] as Element;
  return matches.length === 0 ? null : "ambiguous";
}
