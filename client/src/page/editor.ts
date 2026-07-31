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
  imageInputSelector: string | null;
  saveSelector: string | null;
  restoreCancelSelector: string | null;
}

export interface EditorSaveProbe {
  saved: boolean;
  savedCount: number | null;
  diagnosis: "captcha_required" | "login_required" | null;
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
const IMAGE_INPUT_SELECTORS: readonly string[] = [
  "input[type='file'][accept*='image']",
  "input.se-image-file-input",
  "input[type='file']",
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
  const title = unique(TITLE_SELECTORS);
  const body = unique(BODY_SELECTORS);
  const save = unique(SAVE_SELECTORS);
  if (title === "ambiguous" || body === "ambiguous" || save === "ambiguous") {
    return empty("ambiguous");
  }
  if (title === null || body === null || save === null) return empty("not_found");
  const imageInput = firstMatch(IMAGE_INPUT_SELECTORS);
  return {
    stage: "ready",
    titleSelector: elementSelector(title),
    bodySelector: elementSelector(body),
    imageInputSelector: imageInput === null ? null : elementSelector(imageInput),
    saveSelector: elementSelector(save),
    restoreCancelSelector: null,
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
    imageInputSelector: null,
    saveSelector: null,
    restoreCancelSelector: null,
  };
}

function hasVisible(selectors: string): boolean {
  return queryAllUnique([selectors], document).some(isVisible);
}

function firstVisible(selectors: readonly string[]): Element | null {
  return queryAllUnique(selectors, document).find(isVisible) ?? null;
}

function firstMatch(selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const found = queryAllUnique([selector], document);
    if (found.length > 0) return found[0] as Element;
  }
  return null;
}

function unique(selectors: readonly string[]): Element | "ambiguous" | null {
  for (const selector of selectors) {
    const found = queryAllUnique([selector], document).filter(
      (element) => isVisible(element) && isEnabled(element),
    );
    if (found.length === 1) return found[0] as Element;
    if (found.length > 1) return "ambiguous";
  }
  return null;
}
