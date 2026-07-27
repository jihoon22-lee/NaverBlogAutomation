export type LikeActionResult =
  | "already_liked"
  | "ambiguous"
  | "clicked"
  | "not_found"
  | "permission_denied"
  | "stale_page"
  | "state_unknown";

interface LikeTargetProbe {
  count: number;
  liked: boolean | null;
}

export interface NaverLikeGateway {
  like(tabId: number): Promise<LikeActionResult>;
}

export interface ChromeNaverLikeApi {
  scripting: Pick<typeof chrome.scripting, "executeScript">;
  tabs: Pick<typeof chrome.tabs, "query">;
}

export class ChromeNaverLikeGateway implements NaverLikeGateway {
  readonly #api: ChromeNaverLikeApi;

  constructor(api: ChromeNaverLikeApi = chrome) {
    this.#api = api;
  }

  async like(tabId: number): Promise<LikeActionResult> {
    let active: chrome.tabs.Tab | undefined;
    try {
      [active] = await this.#api.tabs.query({ active: true, lastFocusedWindow: true });
    } catch {
      return "permission_denied";
    }
    if (active?.id !== tabId || active.url === undefined || !isSupportedUrl(active.url)) {
      return "stale_page";
    }

    let probes: chrome.scripting.InjectionResult<LikeTargetProbe>[];
    try {
      probes = await this.#api.scripting.executeScript({
        func: probeLikeTarget,
        target: { allFrames: true, tabId },
        world: "ISOLATED",
      });
    } catch {
      return "permission_denied";
    }
    const matches = probes.flatMap((probe) =>
      Array.from({ length: probe.result?.count ?? 0 }, () => ({
        frameId: probe.frameId,
        liked: probe.result?.liked ?? null,
      })),
    );
    if (matches.length === 0) return "not_found";
    if (matches.length > 1) return "ambiguous";
    const [match] = matches;
    if (match === undefined) return "not_found";
    if (match.liked === true) return "already_liked";
    if (match.liked === null) return "state_unknown";

    try {
      const [clicked] = await this.#api.scripting.executeScript({
        func: clickLikeTarget,
        target: { frameIds: [match.frameId], tabId },
        world: "ISOLATED",
      });
      return clicked?.result ?? "not_found";
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
function probeLikeTarget(): LikeTargetProbe {
  const candidates = findLikeTargets();
  return {
    count: candidates.length,
    liked: candidates.length === 1 ? readLikedState(candidates[0] as HTMLElement) : null,
  };

  function findLikeTargets(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>("button.u_likeit_list_btn, a.u_likeit_list_btn"),
    ).filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-disabled") !== "true" &&
        isVisible(element),
    );
  }

  function readLikedState(element: HTMLElement): boolean | null {
    const pressed = element.getAttribute("aria-pressed");
    if (pressed === "true") return true;
    if (pressed === "false") return false;
    const state = [
      element.getAttribute("data-state"),
      element.getAttribute("data-status"),
      element.getAttribute("data-liked"),
      element.getAttribute("data-is-liked"),
    ]
      .filter((value): value is string => value !== null)
      .map((value) => value.trim().toLowerCase());
    if (state.some((value) => ["on", "true", "liked"].includes(value))) return true;
    if (state.some((value) => ["off", "false", "unliked"].includes(value))) return false;
    if (element.classList.contains("on")) return true;
    if (element.classList.contains("off")) return false;
    const label = `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`;
    if (/공감\s*취소|좋아요\s*취소/.test(label)) return true;
    return null;
  }

  function isVisible(element: HTMLElement): boolean {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }
}

function clickLikeTarget(): LikeActionResult {
  const candidates = findLikeTargets();
  if (candidates.length === 0) return "not_found";
  if (candidates.length > 1) return "ambiguous";
  const target = candidates[0] as HTMLElement;
  const liked = readLikedState(target);
  if (liked === true) return "already_liked";
  if (liked === null) return "state_unknown";
  target.click();
  return "clicked";

  function findLikeTargets(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>("button.u_likeit_list_btn, a.u_likeit_list_btn"),
    ).filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-disabled") !== "true" &&
        isVisible(element),
    );
  }

  function readLikedState(element: HTMLElement): boolean | null {
    const pressed = element.getAttribute("aria-pressed");
    if (pressed === "true") return true;
    if (pressed === "false") return false;
    const state = [
      element.getAttribute("data-state"),
      element.getAttribute("data-status"),
      element.getAttribute("data-liked"),
      element.getAttribute("data-is-liked"),
    ]
      .filter((value): value is string => value !== null)
      .map((value) => value.trim().toLowerCase());
    if (state.some((value) => ["on", "true", "liked"].includes(value))) return true;
    if (state.some((value) => ["off", "false", "unliked"].includes(value))) return false;
    if (element.classList.contains("on")) return true;
    if (element.classList.contains("off")) return false;
    const label = `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`;
    if (/공감\s*취소|좋아요\s*취소/.test(label)) return true;
    return null;
  }

  function isVisible(element: HTMLElement): boolean {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }
}
