/**
 * Comment editor and submit-control discovery for one post document.
 *
 * Ported from the extension's comment input and publish gateways. Every mutation was removed: the
 * probes report the editor state and selectors, and the Python layer types with trusted key events
 * and clicks the submit control it was told about.
 */

import {
  elementSelector,
  hasRenderedBox,
  isEditable,
  isEnabled,
  isVisible,
  queryAllUnique,
  readValue,
} from "./dom";

export type CommentEditorState = "empty" | "matching" | "occupied";

export type CommentProbeCode =
  | "ready"
  | "already_filled"
  | "occupied"
  | "ambiguous"
  | "not_found"
  | "needs_open";

export interface CommentProbe {
  candidateCount: number;
  code: CommentProbeCode;
  editorSelector: string | null;
  openerSelector: string | null;
  state: CommentEditorState | null;
  submitSelector: string | null;
}

export interface CommentPageDiagnosis {
  blocked: boolean;
  captcha: boolean;
  loginRequired: boolean;
}

const EDITOR_SELECTORS: readonly string[] = [
  ".u_cbox_write_area textarea",
  "textarea.u_cbox_text",
  '.u_cbox_text[contenteditable="true"]',
  'textarea[placeholder*="댓글"]',
  '[contenteditable="true"][data-placeholder*="댓글"]',
  '[contenteditable="true"][aria-label*="댓글"]',
  '[role="textbox"][contenteditable="true"][class*="comment"]',
];

const OPENER_SELECTORS: readonly string[] = [
  ".btn_write_comment._naverCommentWriteBtn",
  ".btn_comment._cmtList",
];

const SUBMIT_SELECTORS = "button.u_cbox_btn_upload, a.u_cbox_btn_upload, button._submitButton";

const CAPTCHA_SELECTORS =
  ".u_cbox_captcha, #captcha, iframe[title*='캡차'], iframe[title*='captcha' i]";

/** Report the single comment editor, its state, and the matching submit control. */
export function probeComment(expectedValue: string): CommentProbe {
  const editors = findEditors();
  if (editors.length > 1) {
    return {
      candidateCount: editors.length,
      code: "ambiguous",
      editorSelector: null,
      openerSelector: null,
      state: null,
      submitSelector: null,
    };
  }
  if (editors.length === 0) {
    const openers = findOpeners();
    if (openers.length === 1) {
      return {
        candidateCount: 0,
        code: "needs_open",
        editorSelector: null,
        openerSelector: elementSelector(openers[0] as Element),
        state: null,
        submitSelector: null,
      };
    }
    return {
      candidateCount: openers.length,
      code: openers.length > 1 ? "ambiguous" : "not_found",
      editorSelector: null,
      openerSelector: null,
      state: null,
      submitSelector: null,
    };
  }

  const editor = editors[0] as Element;
  const value = readValue(editor);
  const state: CommentEditorState =
    value.trim().length === 0 ? "empty" : value === expectedValue ? "matching" : "occupied";
  const submits = findSubmitControls(editor);
  const submitSelector = submits.length === 1 ? elementSelector(submits[0] as Element) : null;
  const editorSelector = elementSelector(editor);
  if (state === "occupied") {
    return {
      candidateCount: 1,
      code: "occupied",
      editorSelector,
      openerSelector: null,
      state,
      submitSelector,
    };
  }
  if (submits.length > 1) {
    return {
      candidateCount: submits.length,
      code: "ambiguous",
      editorSelector,
      openerSelector: null,
      state,
      submitSelector: null,
    };
  }
  if (submitSelector === null) {
    return {
      candidateCount: 1,
      code: "not_found",
      editorSelector,
      openerSelector: null,
      state,
      submitSelector: null,
    };
  }
  return {
    candidateCount: 1,
    code: state === "matching" ? "already_filled" : "ready",
    editorSelector,
    openerSelector: null,
    state,
    submitSelector,
  };
}

/** Count published comments whose text equals the approved comment. */
export function countMatchingComments(expectedValue: string): number {
  const expected = expectedValue.trim();
  return Array.from(
    document.querySelectorAll(
      ".u_cbox_comment_box .u_cbox_contents, .u_cbox_comment .u_cbox_contents",
    ),
  ).filter((element) => (element.textContent ?? "").trim() === expected).length;
}

/** Report captcha, login, and comment-block affordances without bypassing any of them. */
export function diagnoseCommentPage(): CommentPageDiagnosis {
  const body = document.body;
  const text = body === null ? "" : (body.textContent ?? "");
  return {
    blocked: /댓글(?:을|이)?\s*(?:작성|등록).*(?:제한|불가|할 수 없)/.test(text),
    captcha: document.querySelector(CAPTCHA_SELECTORS) !== null,
    loginRequired:
      document.querySelector(".u_cbox_login, a[href*='nidlogin.login']") !== null ||
      /로그인\s*(?:후|이 필요)/.test(text),
  };
}

/**
 * Return true only for an actually rendered captcha.
 *
 * Naver leaves a zero-sized captcha placeholder in the document after a successful post, so size is
 * part of the decision.
 */
export function captchaVisible(): boolean {
  return Array.from(document.querySelectorAll(CAPTCHA_SELECTORS)).some(
    (element) => isVisible(element) && hasRenderedBox(element),
  );
}

/** Report whether the editor still holds the approved text. */
export function commentStillPending(selector: string, expectedValue: string): boolean {
  const editor = document.querySelector(selector);
  if (editor === null) return false;
  const value = readValue(editor);
  return value.trim().length > 0 && value === expectedValue;
}

function findEditors(): Element[] {
  return queryAllUnique(EDITOR_SELECTORS, document).filter(
    (element) => isEditable(element) && isVisible(element),
  );
}

function findOpeners(): Element[] {
  return queryAllUnique(OPENER_SELECTORS, document).filter(isEnabled);
}

function findSubmitControls(editor: Element): Element[] {
  // Naver places the editor in `.u_cbox_write_area` and the 등록 button in its sibling
  // `.u_cbox_upload`; their common scope is the outer write wrap or its form.
  const root =
    editor.closest(".u_cbox_write_wrap") ??
    editor.closest("form") ??
    editor.closest(".u_cbox_write_area") ??
    editor.parentElement;
  if (root === null) return [];
  return Array.from(root.querySelectorAll(SUBMIT_SELECTORS)).filter(isEnabled);
}
