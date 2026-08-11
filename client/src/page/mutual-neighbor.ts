/**
 * Mutual-neighbor discovery for the Naver buddy-add flow.
 *
 * The read-only probes report relationship state, popup stage, and selectors. The Python layer
 * selects the 서로이웃 option, types the approved message, and advances with trusted input.
 * Ambiguous, occupied, captcha, and login states fail closed.
 */

import { elementSelector, isEnabled, isVisible, queryAllUnique, readValue } from "./dom";

export type NeighborRelationshipState =
  | "already_mutual"
  | "already_neighbor"
  | "can_request"
  | "request_pending"
  | "request_unavailable"
  | "state_unknown";

export interface NeighborRelationshipProbe {
  blogId: string | null;
  candidateCount: number;
  entrySelector: string | null;
  matchedKinds: string[];
  state: NeighborRelationshipState;
}

export type NeighborStageCode =
  | "ready"
  | "already_selected"
  | "ambiguous"
  | "not_found"
  | "captcha_required"
  | "login_required"
  | "state_unknown";

export interface NeighborOptionProbe {
  code: NeighborStageCode;
  formSelector: string | null;
  mutualSelected: boolean;
  nextSelector: string | null;
  optionSelector: string | null;
}

export type NeighborGroupKind = "none" | "select" | "custom" | "radio";

export interface NeighborApplicationProbe {
  code: NeighborStageCode | "message_occupied";
  groupKind: NeighborGroupKind;
  groupNeedsSelection: boolean;
  groupOptionValue: string | null;
  groupSelector: string | null;
  messageSelector: string | null;
  nextSelector: string | null;
}

export interface NeighborConfirmationProbe {
  closeSelector: string | null;
  confirmed: boolean;
  diagnosis: "captcha_required" | "login_required" | null;
}

const ENTRY_SELECTORS: readonly [string, string][] = [
  ["buddy_add_href", "a[href*='BuddyAddForm.naver']"],
  ["buddy_add", "a[href*='BuddyAdd.naver']"],
  ["buddy_button", "button.btn_buddy, a.btn_buddy, ._buddyAddLayer"],
];

const OPTION_FORM_SELECTORS: readonly string[] = [
  "form#buddyAddForm",
  "form[name='buddyAddForm']",
  "form[name='buddyFrm']",
  "form._buddyAddForm",
  "form[data-testid='buddy-add-form']",
];

const MUTUAL_OPTION_SELECTORS: readonly string[] = [
  "input[type='radio']#both_buddy",
  "input[type='radio']#each_buddy_add",
  "input[type='radio']#relation_both",
  "input[type='radio'][value='both']",
  "input[type='radio'][value='mutual']",
  "input[type='radio'][value='mutual_neighbor']",
];

const APPLICATION_FORM_SELECTORS: readonly string[] = [
  "form[name='buddyApplyFrm']",
  "form#buddyApplyFrm",
  "form._buddyApplyForm",
  "form[data-testid='buddy-apply-form']",
  "form[name*='buddy' i]",
  "form[id*='buddy' i]",
];

const MESSAGE_SELECTORS =
  "textarea#message, textarea[name='message'], textarea[name='buddyMessage'], textarea._message, input[name*='message' i], input[name*='memo' i]";

const CAPTCHA_SELECTORS = ".captcha, #captcha, iframe[title*='캡차'], iframe[title*='captcha' i]";

const LOGIN_SELECTORS = "a[href*='nidlogin.login'], form[action*='nidlogin.login']";

/** Read the author's blog id from a buddy entry control, without guessing. */
function readEntryBlogId(entry: Element): string | null {
  const attribute = entry.getAttribute("data-blog-id");
  if (attribute !== null && attribute.trim() !== "") return attribute.trim();
  const href = entry.getAttribute("href");
  if (href === null) return null;
  const match = /[?&]blogId=([^&#]+)/.exec(href);
  if (match === null) return null;
  try {
    const decoded = decodeURIComponent(match[1] as string).trim();
    return decoded === "" ? null : decoded;
  } catch {
    return null;
  }
}

/** Report the current relationship with the post author and the entry control for a request. */
export function probeNeighborRelationship(): NeighborRelationshipProbe {
  const matchedKinds: string[] = [];
  const candidates: Element[] = [];
  for (const [kind, selector] of ENTRY_SELECTORS) {
    const found = Array.from(document.querySelectorAll(selector)).filter(isEnabled);
    if (found.length > 0) matchedKinds.push(kind);
    candidates.push(...found.filter((element) => !candidates.includes(element)));
  }
  if (candidates.length === 0) {
    return {
      blogId: null,
      candidateCount: 0,
      entrySelector: null,
      matchedKinds,
      state: "state_unknown",
    };
  }
  if (candidates.length > 1) {
    return {
      blogId: null,
      candidateCount: candidates.length,
      entrySelector: null,
      matchedKinds,
      state: "state_unknown",
    };
  }
  const entry = candidates[0] as Element;
  return {
    blogId: readEntryBlogId(entry),
    candidateCount: 1,
    entrySelector: elementSelector(entry),
    matchedKinds,
    state: readRelationshipState(entry),
  };
}

/** Report the stage-one popup form: the 서로이웃 option and the 다음 control. */
export function probeNeighborOption(): NeighborOptionProbe {
  const forms = queryAllUnique(OPTION_FORM_SELECTORS, document).filter(isVisible);
  if (forms.length === 0) return { ...emptyOptionProbe(), code: diagnosePage() };
  if (forms.length > 1) return { ...emptyOptionProbe(), code: "ambiguous" };
  const form = forms[0] as Element;
  const formSelector = elementSelector(form);
  const options = queryAllUnique(MUTUAL_OPTION_SELECTORS, form).filter(
    (element) => !(element as HTMLInputElement).disabled && isOptionReachable(element, form),
  );
  if (options.length === 0) {
    return { ...emptyOptionProbe(), code: "not_found", formSelector };
  }
  if (options.length > 1) {
    return { ...emptyOptionProbe(), code: "ambiguous", formSelector };
  }
  const option = options[0] as HTMLInputElement;
  const nextControls = findLabeledControls(form, "다음");
  const nextSelector =
    nextControls.length === 1 ? elementSelector(nextControls[0] as Element) : null;
  if (nextControls.length > 1) {
    return {
      code: "ambiguous",
      formSelector,
      mutualSelected: option.checked,
      nextSelector: null,
      optionSelector: null,
    };
  }
  if (nextSelector === null) {
    return {
      code: "not_found",
      formSelector,
      mutualSelected: option.checked,
      nextSelector: null,
      optionSelector: elementSelector(clickableOption(option, form)),
    };
  }
  return {
    code: option.checked ? "already_selected" : "ready",
    formSelector,
    mutualSelected: option.checked,
    nextSelector,
    optionSelector: elementSelector(clickableOption(option, form)),
  };
}

/** Report the stage-two application form: neighbor group, message field, and 다음 control. */
export function probeNeighborApplication(expectedMessage: string): NeighborApplicationProbe {
  const forms = queryAllUnique(APPLICATION_FORM_SELECTORS, document).filter(
    (form) => isVisible(form) && form.querySelector(MESSAGE_SELECTORS) !== null,
  );
  if (forms.length === 0) return { ...emptyApplicationProbe(), code: diagnosePage() };
  if (forms.length > 1) return { ...emptyApplicationProbe(), code: "ambiguous" };
  const form = forms[0] as Element;
  const messages = Array.from(form.querySelectorAll(MESSAGE_SELECTORS)).filter(
    (element) =>
      !(element as HTMLTextAreaElement).disabled &&
      !(element as HTMLTextAreaElement).readOnly &&
      isVisible(element),
  );
  if (messages.length === 0) return { ...emptyApplicationProbe(), code: "not_found" };
  if (messages.length > 1) return { ...emptyApplicationProbe(), code: "ambiguous" };
  const message = messages[0] as Element;
  const currentValue = readValue(message) || (message as HTMLTextAreaElement).value || "";
  const group = probeGroup(form);
  const nextControls = findLabeledControls(form, "다음");
  const nextSelector =
    nextControls.length === 1 ? elementSelector(nextControls[0] as Element) : null;
  const base: NeighborApplicationProbe = {
    code: "ready",
    groupKind: group.kind,
    groupNeedsSelection: group.needsSelection,
    groupOptionValue: group.optionValue,
    groupSelector: group.selector,
    messageSelector: elementSelector(message),
    nextSelector,
  };
  if (currentValue.trim() !== "" && currentValue !== expectedMessage) {
    return { ...base, code: "message_occupied" };
  }
  if (group.kind !== "none" && group.selector === null) {
    return { ...base, code: group.code };
  }
  if (nextControls.length > 1) return { ...base, code: "ambiguous", nextSelector: null };
  if (nextSelector === null) return { ...base, code: "not_found" };
  return base;
}

/** Report whether the request was confirmed and where the close control is. */
export function probeNeighborConfirmation(): NeighborConfirmationProbe {
  const body = document.body;
  const text = body === null ? "" : (body.textContent ?? "");
  const captcha = document.querySelector(CAPTCHA_SELECTORS) !== null;
  const loginRequired =
    document.querySelector(LOGIN_SELECTORS) !== null || /로그인\s*(?:후|이 필요)/.test(text);
  const confirmed =
    /서로이웃\s*(?:을|를)?\s*신청하였습니다|서로이웃\s*(?:신청|추가).*(?:완료|되었습니다)|신청\s*중/.test(
      text,
    );
  const closeControls = confirmed ? findCloseControls() : [];
  return {
    closeSelector: closeControls.length === 1 ? elementSelector(closeControls[0] as Element) : null,
    confirmed,
    diagnosis: captcha ? "captcha_required" : loginRequired ? "login_required" : null,
  };
}

function emptyOptionProbe(): NeighborOptionProbe {
  return {
    code: "not_found",
    formSelector: null,
    mutualSelected: false,
    nextSelector: null,
    optionSelector: null,
  };
}

function emptyApplicationProbe(): NeighborApplicationProbe {
  return {
    code: "not_found",
    groupKind: "none",
    groupNeedsSelection: false,
    groupOptionValue: null,
    groupSelector: null,
    messageSelector: null,
    nextSelector: null,
  };
}

function diagnosePage(): NeighborStageCode {
  const body = document.body;
  const text = body === null ? "" : (body.textContent ?? "");
  if (document.querySelector(CAPTCHA_SELECTORS) !== null) return "captcha_required";
  if (document.querySelector(LOGIN_SELECTORS) !== null || /로그인\s*(?:후|이 필요)/.test(text)) {
    return "login_required";
  }
  return "not_found";
}

function readRelationshipState(element: Element): NeighborRelationshipState {
  const label =
    `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${
      element.textContent ?? ""
    }`
      .replace(/\s+/gu, "")
      .trim();
  if (/서로이웃(?:입니다)?$/.test(label)) return "already_mutual";
  if (/^(?:나의)?이웃(?:입니다)?$/.test(label)) return "already_neighbor";
  if (/신청중|신청완료/.test(label)) return "request_pending";
  if (/신청불가|추가불가/.test(label)) return "request_unavailable";
  if (/^(?:\+)?(?:서로)?이웃(?:추가|신청)$/.test(label)) return "can_request";
  return "state_unknown";
}

function findLabeledControls(root: ParentNode, expectedLabel: string): Element[] {
  return Array.from(root.querySelectorAll("button, a, [role='button']")).filter((element) => {
    const label = `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`
      .replace(/\s+/gu, "")
      .trim();
    return label === expectedLabel && isEnabled(element);
  });
}

function findCloseControls(): Element[] {
  return Array.from(document.querySelectorAll("button, a, [role='button']")).filter((element) => {
    const label = `${element.getAttribute("aria-label") ?? ""} ${
      element.getAttribute("title") ?? ""
    } ${element.textContent ?? ""}`
      .replace(/\s+/gu, "")
      .trim()
      .toLocaleLowerCase();
    const matchesClass = element.matches(
      ".button_close, .btn_close, ._close, [data-action='close']",
    );
    return (label === "닫기" || label === "close" || matchesClass) && isEnabled(element);
  });
}

function isOptionReachable(element: Element, form: Element): boolean {
  if (isVisible(element)) return true;
  const label = findOptionLabel(element, form);
  return label !== null && isVisible(label);
}

function findOptionLabel(element: Element, form: Element): Element | null {
  const id = element.id;
  const byFor = id === "" ? null : form.querySelector(`label[for='${id}']`);
  return byFor ?? element.closest("label");
}

/** Prefer the visible label so a trusted click lands on something the user could click. */
function clickableOption(element: Element, form: Element): Element {
  if (isVisible(element)) return element;
  return findOptionLabel(element, form) ?? element;
}

interface GroupProbe {
  code: NeighborStageCode;
  kind: NeighborGroupKind;
  needsSelection: boolean;
  optionValue: string | null;
  selector: string | null;
}

function probeGroup(form: Element): GroupProbe {
  const selects = Array.from(
    form.querySelectorAll(
      "select[name*='group' i], select[id*='group' i], select[name*='category' i], select[id*='category' i]",
    ),
  ).filter((element) => !(element as HTMLSelectElement).disabled && isVisible(element));
  if (selects.length > 1) {
    return {
      code: "ambiguous",
      kind: "select",
      needsSelection: true,
      optionValue: null,
      selector: null,
    };
  }
  const select = selects[0] as HTMLSelectElement | undefined;
  if (select !== undefined) {
    const selected = select.selectedOptions[0];
    if (selected !== undefined && selected.value !== "" && !selected.disabled) {
      return {
        code: "ready",
        kind: "select",
        needsSelection: false,
        optionValue: selected.value,
        selector: elementSelector(select),
      };
    }
    const fallback = Array.from(select.options).find(
      (option) => option.value !== "" && !option.disabled,
    );
    if (fallback === undefined) {
      return {
        code: "state_unknown",
        kind: "select",
        needsSelection: true,
        optionValue: null,
        selector: elementSelector(select),
      };
    }
    return {
      code: "ready",
      kind: "select",
      needsSelection: true,
      optionValue: fallback.value,
      selector: elementSelector(select),
    };
  }

  const customGroups = Array.from(
    form.querySelectorAll("._selectGroup[groupid], [data-group-id]"),
  ).filter((element) => !element.hasAttribute("disabled") && isVisible(element));
  if (customGroups.length > 0) {
    const selected = customGroups.filter(
      (element) => element.getAttribute("aria-selected") === "true",
    );
    if (selected.length === 1) {
      return {
        code: "ready",
        kind: "custom",
        needsSelection: false,
        optionValue: null,
        selector: elementSelector(selected[0] as Element),
      };
    }
    if (selected.length > 1 || customGroups.length > 1) {
      return {
        code: "state_unknown",
        kind: "custom",
        needsSelection: true,
        optionValue: null,
        selector: null,
      };
    }
    return {
      code: "ready",
      kind: "custom",
      needsSelection: true,
      optionValue: null,
      selector: elementSelector(customGroups[0] as Element),
    };
  }

  const radios = Array.from(
    form.querySelectorAll(
      "input[type='radio'][name*='group' i], input[type='radio'][name*='category' i]",
    ),
  ).filter(
    (element) => !(element as HTMLInputElement).disabled && isOptionReachable(element, form),
  );
  if (radios.length === 0) {
    return {
      code: "ready",
      kind: "none",
      needsSelection: false,
      optionValue: null,
      selector: null,
    };
  }
  const checked = radios.filter((radio) => (radio as HTMLInputElement).checked);
  if (checked.length > 0) {
    return {
      code: "ready",
      kind: "radio",
      needsSelection: false,
      optionValue: null,
      selector: elementSelector(checked[0] as Element),
    };
  }
  return {
    code: "ready",
    kind: "radio",
    needsSelection: true,
    optionValue: null,
    selector: elementSelector(clickableOption(radios[0] as Element, form)),
  };
}
