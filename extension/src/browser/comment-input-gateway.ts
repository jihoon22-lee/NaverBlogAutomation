export type CommentInputResult =
  | "ambiguous"
  | "filled"
  | "not_found"
  | "open_failed"
  | "occupied"
  | "permission_denied"
  | "stale_page";

interface CommentTargetProbe {
  count: number;
  empty: boolean;
}

export interface CommentInputGateway {
  fill(tabId: number, value: string): Promise<CommentInputResult>;
}

export interface ChromeCommentInputApi {
  scripting: Pick<typeof chrome.scripting, "executeScript">;
  tabs: Pick<typeof chrome.tabs, "query">;
}

export class ChromeCommentInputGateway implements CommentInputGateway {
  readonly #api: ChromeCommentInputApi;

  constructor(api: ChromeCommentInputApi = chrome) {
    this.#api = api;
  }

  async fill(tabId: number, value: string): Promise<CommentInputResult> {
    let active: chrome.tabs.Tab | undefined;
    try {
      [active] = await this.#api.tabs.query({ active: true, lastFocusedWindow: true });
    } catch {
      return "permission_denied";
    }
    if (active?.id !== tabId || active.url === undefined || !isSupportedUrl(active.url)) {
      return "stale_page";
    }

    let probes: chrome.scripting.InjectionResult<CommentTargetProbe>[];
    try {
      probes = await this.#api.scripting.executeScript({
        func: probeCommentTarget,
        target: { allFrames: true, tabId },
        world: "ISOLATED",
      });
    } catch {
      return "permission_denied";
    }

    const matches = probes.flatMap((probe) =>
      Array.from({ length: probe.result?.count ?? 0 }, () => ({
        empty: probe.result?.empty ?? false,
        frameId: probe.frameId,
      })),
    );
    if (matches.length === 0) return this.#openAndFill(tabId, value);
    if (matches.length > 1) return "ambiguous";
    const [match] = matches;
    if (match === undefined || !match.empty) return "occupied";

    try {
      const [filled] = await this.#api.scripting.executeScript({
        args: [value],
        func: fillCommentTarget,
        target: { frameIds: [match.frameId], tabId },
        world: "ISOLATED",
      });
      return filled?.result ?? "not_found";
    } catch {
      return "permission_denied";
    }
  }

  async #openAndFill(tabId: number, value: string): Promise<CommentInputResult> {
    let probes: chrome.scripting.InjectionResult<CommentTargetProbe>[];
    try {
      probes = await this.#api.scripting.executeScript({
        func: probeCommentOpener,
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
      const [filled] = await this.#api.scripting.executeScript({
        args: [value],
        func: openAndFillCommentTarget,
        target: { frameIds: [match.frameId], tabId },
        world: "ISOLATED",
      });
      return filled?.result ?? "open_failed";
    } catch {
      return "permission_denied";
    }
  }
}

function isSupportedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "blog.naver.com" || url.hostname === "m.blog.naver.com")
    );
  } catch {
    return false;
  }
}

/** Keep runtime helpers inside functions serialized by chrome.scripting.executeScript. */
function probeCommentTarget(): CommentTargetProbe {
  const candidates = findCommentTargets();
  return {
    count: candidates.length,
    empty: candidates.length === 1 && readValue(candidates[0] as HTMLElement).trim().length === 0,
  };

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

function probeCommentOpener(): CommentTargetProbe {
  return { count: findCommentOpeners().length, empty: false };

  function findCommentOpeners(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(".btn_write_comment._naverCommentWriteBtn"),
    ).filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-disabled") !== "true" &&
        isVisible(element),
    );
  }

  function isVisible(element: HTMLElement): boolean {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }
}

function fillCommentTarget(value: string): CommentInputResult {
  const candidates = findCommentTargets();
  if (candidates.length === 0) return "not_found";
  if (candidates.length > 1) return "ambiguous";
  const target = candidates[0] as HTMLElement;
  if (readValue(target).trim().length > 0) return "occupied";

  target.focus();
  if (target instanceof HTMLTextAreaElement) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    descriptor?.set?.call(target, value);
  } else {
    target.textContent = value;
  }
  target.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      data: value,
      inputType: "insertText",
    }),
  );
  return "filled";

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

async function openAndFillCommentTarget(value: string): Promise<CommentInputResult> {
  const openers = findCommentOpeners();
  if (openers.length === 0) return "not_found";
  if (openers.length > 1) return "ambiguous";
  const opener = openers[0];
  if (opener === undefined) return "not_found";

  opener.click();
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    const candidates = findCommentTargets();
    if (candidates.length > 1) return "ambiguous";
    const target = candidates[0];
    if (target !== undefined) {
      if (readValue(target).trim().length > 0) return "occupied";
      writeValue(target, value);
      return "filled";
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  return "open_failed";

  function findCommentOpeners(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(".btn_write_comment._naverCommentWriteBtn"),
    ).filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-disabled") !== "true" &&
        isVisible(element),
    );
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

  function writeValue(target: HTMLElement, comment: string): void {
    target.focus();
    if (target instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      descriptor?.set?.call(target, comment);
    } else {
      target.textContent = comment;
    }
    target.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: comment,
        inputType: "insertText",
      }),
    );
  }
}
