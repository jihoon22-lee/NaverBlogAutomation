/**
 * Like-control discovery for one post document.
 *
 * The read-only probe reports what it found and where it is, and the Python layer performs a
 * trusted click.
 */

import { elementSelector, isEnabled } from "./dom";

export type LikeProbeCode = "ready" | "already_liked" | "not_found" | "ambiguous" | "state_unknown";

export interface LikeProbe {
  candidateCount: number;
  code: LikeProbeCode;
  liked: boolean | null;
  /** Selector for the default 공감 option inside a reaction layer, when one is open. */
  optionSelector: string | null;
  selector: string | null;
}

const LIKE_SELECTORS = [
  "button.u_likeit_list_btn",
  "a.u_likeit_list_btn",
  ".u_likeit_list_module._reactionModule_BLOG .u_likeit_button._face[role='button']",
].join(",");

const CANONICAL_FACE = "a.u_likeit_button._face[role='button']";
const DEFAULT_OPTION = "a.u_likeit_list_button._button[data-type='like']";

/** Report the single canonical like control, its state, and its selector. */
export function probeLike(): LikeProbe {
  const candidates = findLikeTargets();
  if (candidates.length === 0) {
    return {
      candidateCount: 0,
      code: "not_found",
      liked: null,
      optionSelector: null,
      selector: null,
    };
  }
  if (candidates.length > 1) {
    return {
      candidateCount: candidates.length,
      code: "ambiguous",
      liked: null,
      optionSelector: null,
      selector: null,
    };
  }
  const target = candidates[0] as Element;
  const liked = readLikedState(target);
  const selector = elementSelector(target);
  const optionSelector = findDefaultLikeOption(target);
  if (liked === true) {
    return { candidateCount: 1, code: "already_liked", liked: true, optionSelector, selector };
  }
  if (liked === null) {
    return { candidateCount: 1, code: "state_unknown", liked: null, optionSelector, selector };
  }
  return { candidateCount: 1, code: "ready", liked: false, optionSelector, selector };
}

/** Return the selectors of visible default-like options inside the open reaction layer. */
export function probeLikeOption(): string | null {
  const candidates = findLikeTargets();
  const target = candidates.length === 1 ? (candidates[0] as Element) : null;
  return target === null ? null : findDefaultLikeOption(target);
}

function findLikeTargets(): Element[] {
  const candidates = Array.from(document.querySelectorAll(LIKE_SELECTORS)).filter(isEnabled);
  const canonicalLiveTargets = candidates.filter(
    (element) =>
      element.matches(CANONICAL_FACE) &&
      element.closest(".my_reaction") !== null &&
      element.closest(".area_sympathy[id^='area_sympathy']") !== null,
  );
  if (canonicalLiveTargets.length > 0) return canonicalLiveTargets;
  const primaryLiveTargets = candidates.filter(
    (element) => element.matches(CANONICAL_FACE) && element.closest(".my_reaction") !== null,
  );
  return primaryLiveTargets.length > 0 ? primaryLiveTargets : candidates;
}

function findDefaultLikeOption(face: Element): string | null {
  const module = face.closest(".u_likeit_list_module._reactionModule_BLOG");
  if (module === null) return null;
  const options = Array.from(module.querySelectorAll(DEFAULT_OPTION)).filter(isEnabled);
  return options.length === 1 ? elementSelector(options[0] as Element) : null;
}

function readLikedState(element: Element): boolean | null {
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
