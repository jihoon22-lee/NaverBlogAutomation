import {
  ChromeCommentInputGateway,
  type ChromeCommentInputApi,
  type CommentInputGateway,
  type CommentInputResult,
} from "./comment-input-gateway";

export type CommentPublishResult =
  | Exclude<CommentInputResult, "filled">
  | "captcha_required"
  | "comment_blocked"
  | "login_required"
  | "submitted"
  | "submission_unconfirmed";

interface PublishTargetProbe {
  count: number;
}

interface CommentPageDiagnosis {
  blocked: boolean;
  captcha: boolean;
  loginRequired: boolean;
}

export interface CommentPublishGateway {
  publish(tabId: number, value: string): Promise<CommentPublishResult>;
}

export interface CommentPublishDependencies {
  input?: CommentInputGateway;
}

export class ChromeCommentPublishGateway implements CommentPublishGateway {
  readonly #api: ChromeCommentInputApi;
  readonly #input: CommentInputGateway;
  readonly #unconfirmedAttempts = new Map<number, Set<string>>();

  constructor(api: ChromeCommentInputApi = chrome, dependencies: CommentPublishDependencies = {}) {
    this.#api = api;
    this.#input = dependencies.input ?? new ChromeCommentInputGateway(api);
  }

  async publish(tabId: number, value: string): Promise<CommentPublishResult> {
    if (this.#unconfirmedAttempts.get(tabId)?.has(value) === true) {
      return "submission_unconfirmed";
    }
    const inputResult = await this.#input.fill(tabId, value);
    if (inputResult !== "filled") {
      return this.#diagnoseInputFailure(tabId, inputResult);
    }

    let probes: chrome.scripting.InjectionResult<PublishTargetProbe>[];
    try {
      probes = await this.#api.scripting.executeScript({
        args: [value],
        func: probePublishTarget,
        target: { allFrames: true, tabId },
        world: "ISOLATED",
      });
    } catch {
      return "permission_denied";
    }
    const matches = probes.flatMap((probe) =>
      Array.from({ length: probe.result?.count ?? 0 }, () => ({ frameId: probe.frameId })),
    );
    if (matches.length === 0) return "not_found";
    if (matches.length > 1) return "ambiguous";
    const [match] = matches;
    if (match === undefined) return "not_found";

    try {
      const [submitted] = await this.#api.scripting.executeScript({
        args: [value],
        func: clickAndConfirmComment,
        target: { frameIds: [match.frameId], tabId },
        world: "ISOLATED",
      });
      const result = submitted?.result ?? "submission_unconfirmed";
      if (result === "submission_unconfirmed") {
        const values = this.#unconfirmedAttempts.get(tabId) ?? new Set<string>();
        values.add(value);
        this.#unconfirmedAttempts.set(tabId, values);
      }
      return result;
    } catch {
      return "permission_denied";
    }
  }

  async #diagnoseInputFailure(
    tabId: number,
    inputResult: Exclude<CommentInputResult, "filled">,
  ): Promise<CommentPublishResult> {
    if (inputResult !== "not_found" && inputResult !== "open_failed") return inputResult;
    try {
      const diagnoses = await this.#api.scripting.executeScript({
        func: diagnoseCommentPage,
        target: { allFrames: true, tabId },
        world: "ISOLATED",
      });
      if (diagnoses.some((result) => result.result?.captcha)) return "captcha_required";
      if (diagnoses.some((result) => result.result?.loginRequired)) return "login_required";
      if (diagnoses.some((result) => result.result?.blocked)) return "comment_blocked";
    } catch {
      return "permission_denied";
    }
    return inputResult;
  }
}

/** Keep runtime helpers inside functions serialized by chrome.scripting.executeScript. */
function probePublishTarget(expectedValue: string): PublishTargetProbe {
  return { count: findPublishPairs(expectedValue).length };

  function findPublishPairs(comment: string): { button: HTMLElement; input: HTMLElement }[] {
    const pairs: { button: HTMLElement; input: HTMLElement }[] = [];
    for (const input of findCommentTargets()) {
      if (readValue(input) !== comment) continue;
      const buttons = findSubmitButtons(input);
      if (buttons.length === 1) pairs.push({ button: buttons[0] as HTMLElement, input });
      if (buttons.length > 1) {
        pairs.push(...buttons.map((button) => ({ button, input })));
      }
    }
    return pairs;
  }

  function findCommentTargets(): HTMLElement[] {
    const selectors = [
      ".u_cbox_write_area textarea",
      "textarea.u_cbox_text",
      '.u_cbox_text[contenteditable="true"]',
      'textarea[placeholder*="댓글"]',
      '[contenteditable="true"][data-placeholder*="댓글"]',
      '[contenteditable="true"][aria-label*="댓글"]',
      '[role="textbox"][contenteditable="true"][class*="comment"]',
    ];
    const seen = new Set<Element>();
    const elements: HTMLElement[] = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (seen.has(element) || !isEditable(element) || !isVisible(element)) continue;
        seen.add(element);
        elements.push(element);
      }
    }
    return elements;
  }

  function findSubmitButtons(input: HTMLElement): HTMLElement[] {
    const root =
      input.closest<HTMLElement>(".u_cbox_write_wrap, .u_cbox_write_area, form") ??
      input.parentElement;
    if (root === null) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        "button.u_cbox_btn_upload, a.u_cbox_btn_upload, button._submitButton",
      ),
    ).filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-disabled") !== "true" &&
        isVisible(element),
    );
  }

  function isEditable(element: HTMLElement): boolean {
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    return (
      (element.isContentEditable || element.getAttribute("contenteditable") === "true") &&
      element.getAttribute("aria-disabled") !== "true"
    );
  }

  function isVisible(element: HTMLElement): boolean {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function readValue(element: HTMLElement): string {
    return element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? "");
  }
}

async function clickAndConfirmComment(expectedValue: string): Promise<CommentPublishResult> {
  const pairs = findPublishPairs(expectedValue);
  if (pairs.length === 0) return "not_found";
  if (pairs.length > 1) return "ambiguous";
  const pair = pairs[0];
  if (pair === undefined) return "not_found";
  const before = matchingCommentCount(expectedValue);
  pair.button.click();
  const deadline = Date.now() + 3_000;
  while (Date.now() <= deadline) {
    if (captchaVisible()) return "captcha_required";
    if (!pair.input.isConnected || readValue(pair.input).trim().length === 0) return "submitted";
    if (matchingCommentCount(expectedValue) > before) return "submitted";
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  return "submission_unconfirmed";

  function findPublishPairs(comment: string): { button: HTMLElement; input: HTMLElement }[] {
    const pairs: { button: HTMLElement; input: HTMLElement }[] = [];
    for (const input of findCommentTargets()) {
      if (readValue(input) !== comment) continue;
      const buttons = findSubmitButtons(input);
      if (buttons.length === 1) pairs.push({ button: buttons[0] as HTMLElement, input });
      if (buttons.length > 1) {
        pairs.push(...buttons.map((button) => ({ button, input })));
      }
    }
    return pairs;
  }

  function findCommentTargets(): HTMLElement[] {
    const selectors = [
      ".u_cbox_write_area textarea",
      "textarea.u_cbox_text",
      '.u_cbox_text[contenteditable="true"]',
      'textarea[placeholder*="댓글"]',
      '[contenteditable="true"][data-placeholder*="댓글"]',
      '[contenteditable="true"][aria-label*="댓글"]',
      '[role="textbox"][contenteditable="true"][class*="comment"]',
    ];
    const seen = new Set<Element>();
    const elements: HTMLElement[] = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (seen.has(element) || !isEditable(element) || !isVisible(element)) continue;
        seen.add(element);
        elements.push(element);
      }
    }
    return elements;
  }

  function findSubmitButtons(input: HTMLElement): HTMLElement[] {
    const root =
      input.closest<HTMLElement>(".u_cbox_write_wrap, .u_cbox_write_area, form") ??
      input.parentElement;
    if (root === null) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        "button.u_cbox_btn_upload, a.u_cbox_btn_upload, button._submitButton",
      ),
    ).filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-disabled") !== "true" &&
        isVisible(element),
    );
  }

  function matchingCommentCount(comment: string): number {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        ".u_cbox_comment_box .u_cbox_contents, .u_cbox_comment .u_cbox_contents",
      ),
    ).filter((element) => (element.textContent ?? "").trim() === comment.trim()).length;
  }

  function captchaVisible(): boolean {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        ".u_cbox_captcha, #captcha, iframe[title*='캡차'], iframe[title*='captcha' i]",
      ),
    ).some(isVisible);
  }

  function isEditable(element: HTMLElement): boolean {
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    return (
      (element.isContentEditable || element.getAttribute("contenteditable") === "true") &&
      element.getAttribute("aria-disabled") !== "true"
    );
  }

  function isVisible(element: HTMLElement): boolean {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function readValue(element: HTMLElement): string {
    return element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? "");
  }
}

function diagnoseCommentPage(): CommentPageDiagnosis {
  const text = document.body?.innerText ?? document.body?.textContent ?? "";
  return {
    blocked: /댓글(?:을|이)?\s*(?:작성|등록).*(?:제한|불가|할 수 없)/.test(text),
    captcha:
      document.querySelector(
        ".u_cbox_captcha, #captcha, iframe[title*='캡차'], iframe[title*='captcha' i]",
      ) !== null,
    loginRequired:
      document.querySelector(".u_cbox_login, a[href*='nidlogin.login']") !== null ||
      /로그인\s*(?:후|이 필요)/.test(text),
  };
}
