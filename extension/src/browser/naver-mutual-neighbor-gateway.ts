export type MutualNeighborActionCode =
  | "already_mutual"
  | "already_neighbor"
  | "ambiguous"
  | "author_mismatch"
  | "captcha_required"
  | "login_required"
  | "message_occupied"
  | "not_found"
  | "permission_denied"
  | "request_pending"
  | "request_unavailable"
  | "request_unconfirmed"
  | "requested"
  | "stale_page"
  | "state_unknown";

export interface MutualNeighborDiagnostic {
  candidateCount: number;
  matchedKinds: string[];
  stage: "entry" | "form";
}

export interface MutualNeighborActionResult {
  code: MutualNeighborActionCode;
  diagnostic?: MutualNeighborDiagnostic;
}

type RelationshipState =
  | "already_mutual"
  | "already_neighbor"
  | "can_request"
  | "request_pending"
  | "request_unavailable"
  | "state_unknown";

interface RelationshipProbe {
  count: number;
  kinds: string[];
  state: RelationshipState | null;
}

interface FormProbe {
  count: number;
  kinds: string[];
}

interface FormLocation {
  frameId: number;
  tabId: number;
}

interface PageDiagnosis {
  captcha: boolean;
  loginRequired: boolean;
  unavailable: boolean;
}

/** Opening the Naver dialog is not the same as submitting a neighbor request. */
type NeighborEntryActionCode = Exclude<MutualNeighborActionCode, "requested"> | "opened";
type NeighborFormActionCode =
  | Exclude<MutualNeighborActionCode, "requested">
  | "advanced"
  | "submitted";

interface MutualNeighborConfirmationProbe {
  closeCount: number;
  confirmed: boolean;
  diagnosis: "captcha_required" | "login_required" | null;
}

export interface NaverMutualNeighborGateway {
  request(
    tabId: number,
    expectedBlogId: string,
    message: string,
  ): Promise<MutualNeighborActionResult>;
}

export interface ChromeNaverMutualNeighborApi {
  scripting: Pick<typeof chrome.scripting, "executeScript">;
  tabs: Pick<typeof chrome.tabs, "query">;
}

export class ChromeNaverMutualNeighborGateway implements NaverMutualNeighborGateway {
  readonly #api: ChromeNaverMutualNeighborApi;
  readonly #unconfirmed = new Set<string>();

  constructor(api: ChromeNaverMutualNeighborApi = chrome) {
    this.#api = api;
  }

  async request(
    tabId: number,
    expectedBlogId: string,
    message: string,
  ): Promise<MutualNeighborActionResult> {
    const normalizedBlogId = normalizeBlogId(expectedBlogId);
    const approvedMessage = message;
    if (
      normalizedBlogId === null ||
      approvedMessage.trim().length === 0 ||
      approvedMessage.length > 500
    ) {
      return { code: "state_unknown" };
    }
    const attemptKey = `${tabId}:${normalizedBlogId}:${approvedMessage}`;
    if (this.#unconfirmed.has(attemptKey)) return { code: "request_unconfirmed" };

    const active = await this.#activeTab();
    if (active === null) return { code: "permission_denied" };
    if (active.id !== tabId || active.url === undefined || !isSupportedBlogUrl(active.url)) {
      return { code: "stale_page" };
    }
    if (blogIdFromUrl(active.url)?.toLocaleLowerCase() !== normalizedBlogId.toLocaleLowerCase()) {
      return { code: "author_mismatch" };
    }

    const entry = await this.#probeEntry(tabId);
    if ("code" in entry) return entry;
    if (entry.state !== "can_request") return { code: entry.state };

    let opened: chrome.scripting.InjectionResult<NeighborEntryActionCode>[];
    try {
      opened = await this.#api.scripting.executeScript({
        func: clickNeighborEntry,
        target: { frameIds: [entry.frameId], tabId },
        world: "ISOLATED",
      });
    } catch {
      return { code: "permission_denied" };
    }
    const openResult = opened[0]?.result ?? "not_found";
    if (openResult !== "opened") return { code: openResult };

    const relationshipForm = await this.#locateForm(tabId, normalizedBlogId);
    if ("code" in relationshipForm) return relationshipForm;
    try {
      const [advanced] = await this.#api.scripting.executeScript({
        args: [approvedMessage],
        func: selectMutualNeighborAndAdvance,
        target: { frameIds: [relationshipForm.frameId], tabId: relationshipForm.tabId },
        world: "ISOLATED",
      });
      const result = advanced?.result ?? "request_unconfirmed";
      if (result === "submitted") return this.#waitForRequestConfirmation(tabId, attemptKey);
      if (result !== "advanced") return { code: result as MutualNeighborActionCode };
    } catch {
      this.#unconfirmed.add(attemptKey);
      return { code: "request_unconfirmed" };
    }

    const applicationForm = await this.#locateForm(tabId, normalizedBlogId);
    if ("code" in applicationForm) return applicationForm;
    try {
      const [submitted] = await this.#api.scripting.executeScript({
        args: [approvedMessage],
        func: fillMutualNeighborApplicationAndSubmit,
        target: { frameIds: [applicationForm.frameId], tabId: applicationForm.tabId },
        world: "ISOLATED",
      });
      const result = submitted?.result ?? "request_unconfirmed";
      if (result !== "submitted") return { code: result as MutualNeighborActionCode };
    } catch {
      this.#unconfirmed.add(attemptKey);
      return { code: "request_unconfirmed" };
    }
    return this.#waitForRequestConfirmation(tabId, attemptKey);
  }

  async #activeTab(): Promise<chrome.tabs.Tab | null> {
    try {
      const [active] = await this.#api.tabs.query({ active: true, lastFocusedWindow: true });
      return active ?? null;
    } catch {
      return null;
    }
  }

  async #probeEntry(
    tabId: number,
  ): Promise<{ frameId: number; state: RelationshipState } | MutualNeighborActionResult> {
    let probes: chrome.scripting.InjectionResult<RelationshipProbe>[];
    try {
      probes = await this.#api.scripting.executeScript({
        func: probeNeighborEntry,
        target: { allFrames: true, tabId },
        world: "ISOLATED",
      });
    } catch {
      return { code: "permission_denied" };
    }
    const matches = probes.flatMap((probe) =>
      Array.from({ length: probe.result?.count ?? 0 }, () => ({
        frameId: probe.frameId,
        kinds: probe.result?.kinds ?? [],
        state: probe.result?.state ?? null,
      })),
    );
    if (matches.length === 0) {
      const diagnosis = await this.#diagnose(tabId);
      return {
        code: diagnosis,
        diagnostic: { candidateCount: 0, matchedKinds: [], stage: "entry" },
      };
    }
    if (matches.length > 1) {
      return {
        code: "ambiguous",
        diagnostic: {
          candidateCount: matches.length,
          matchedKinds: unique(matches.flatMap((match) => match.kinds)),
          stage: "entry",
        },
      };
    }
    const [match] = matches;
    if (match === undefined || match.state === null) return { code: "state_unknown" };
    return { frameId: match.frameId, state: match.state };
  }

  async #locateForm(
    originalTabId: number,
    expectedBlogId: string,
  ): Promise<FormLocation | MutualNeighborActionResult> {
    const deadline = Date.now() + 3_000;
    while (Date.now() <= deadline) {
      const active = await this.#activeTab();
      if (active === null) return { code: "permission_denied" };
      if (active.url !== undefined && isNaverLoginUrl(active.url))
        return { code: "login_required" };
      if (
        active.id !== undefined &&
        active.id !== originalTabId &&
        active.url !== undefined &&
        isSupportedBlogUrl(active.url) &&
        formBlogIdFromUrl(active.url) !== null &&
        formBlogIdFromUrl(active.url)?.toLocaleLowerCase() !== expectedBlogId.toLocaleLowerCase()
      ) {
        return { code: "author_mismatch" };
      }
      const tabIds = uniqueNumbers([
        ...(active.id !== undefined && active.url !== undefined && isSupportedBlogUrl(active.url)
          ? [active.id]
          : []),
        originalTabId,
      ]);
      const locations: (FormLocation & { kinds: string[] })[] = [];
      for (const candidateTabId of tabIds) {
        let probes: chrome.scripting.InjectionResult<FormProbe>[];
        try {
          probes = await this.#api.scripting.executeScript({
            func: probeMutualNeighborForm,
            target: { allFrames: true, tabId: candidateTabId },
            world: "ISOLATED",
          });
        } catch {
          continue;
        }
        for (const probe of probes) {
          for (let index = 0; index < (probe.result?.count ?? 0); index += 1) {
            locations.push({
              frameId: probe.frameId,
              kinds: probe.result?.kinds ?? [],
              tabId: candidateTabId,
            });
          }
        }
      }
      if (locations.length === 1) {
        const [location] = locations;
        if (location !== undefined) return location;
      }
      if (locations.length > 1) {
        return {
          code: "ambiguous",
          diagnostic: {
            candidateCount: locations.length,
            matchedKinds: unique(locations.flatMap((location) => location.kinds)),
            stage: "form",
          },
        };
      }
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 50));
    }
    return {
      code: "not_found",
      diagnostic: { candidateCount: 0, matchedKinds: [], stage: "form" },
    };
  }

  async #waitForRequestConfirmation(
    originalTabId: number,
    attemptKey: string,
  ): Promise<MutualNeighborActionResult> {
    const deadline = Date.now() + 3_000;
    while (Date.now() <= deadline) {
      const active = await this.#activeTab();
      if (active === null) return { code: "permission_denied" };
      if (active.url !== undefined && isNaverLoginUrl(active.url))
        return { code: "login_required" };
      const tabIds = uniqueNumbers([
        originalTabId,
        ...(active.id === undefined ? [] : [active.id]),
      ]);
      const confirmations: FormLocation[] = [];
      for (const tabId of tabIds) {
        let probes: chrome.scripting.InjectionResult<MutualNeighborConfirmationProbe>[];
        try {
          probes = await this.#api.scripting.executeScript({
            func: probeMutualNeighborConfirmation,
            target: { allFrames: true, tabId },
            world: "ISOLATED",
          });
        } catch {
          continue;
        }
        for (const probe of probes) {
          if (probe.result?.diagnosis !== null && probe.result?.diagnosis !== undefined) {
            return { code: probe.result.diagnosis };
          }
          if (probe.result?.confirmed) confirmations.push({ frameId: probe.frameId, tabId });
        }
      }
      if (confirmations.length > 1) return { code: "ambiguous" };
      const [confirmation] = confirmations;
      if (confirmation !== undefined) {
        try {
          const [closed] = await this.#api.scripting.executeScript({
            func: closeMutualNeighborConfirmation,
            target: { frameIds: [confirmation.frameId], tabId: confirmation.tabId },
            world: "ISOLATED",
          });
          if (closed?.result === "ambiguous") return { code: "ambiguous" };
          if (closed?.result === "not_found" || closed?.result === "closed")
            return { code: "requested" };
          return { code: "request_unconfirmed" };
        } catch {
          this.#unconfirmed.add(attemptKey);
          return { code: "request_unconfirmed" };
        }
      }
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 50));
    }
    this.#unconfirmed.add(attemptKey);
    return { code: "request_unconfirmed" };
  }

  async #diagnose(tabId: number): Promise<MutualNeighborActionCode> {
    try {
      const diagnoses = await this.#api.scripting.executeScript({
        func: diagnoseNeighborPage,
        target: { allFrames: true, tabId },
        world: "ISOLATED",
      });
      if (diagnoses.some((result) => result.result?.captcha)) return "captcha_required";
      if (diagnoses.some((result) => result.result?.loginRequired)) return "login_required";
      if (diagnoses.some((result) => result.result?.unavailable)) return "request_unavailable";
      return "not_found";
    } catch {
      return "permission_denied";
    }
  }
}

function normalizeBlogId(value: string): string | null {
  const normalized = value.trim();
  return /^[A-Za-z0-9._-]{1,100}$/.test(normalized) ? normalized : null;
}

function blogIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const queryBlogId = url.searchParams.get("blogId");
    if (queryBlogId !== null) return normalizeBlogId(queryBlogId);
    const [pathBlogId] = url.pathname.split("/").filter(Boolean);
    return pathBlogId === undefined ? null : normalizeBlogId(pathBlogId);
  } catch {
    return null;
  }
}

function formBlogIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return normalizeBlogId(url.searchParams.get("blogId") ?? "");
  } catch {
    return null;
  }
}

function isSupportedBlogUrl(value: string): boolean {
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

function isNaverLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "nid.naver.com";
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

/** Keep runtime helpers inside functions serialized by chrome.scripting.executeScript. */
function probeNeighborEntry(): RelationshipProbe {
  const candidates = findCandidates();
  return {
    count: candidates.length,
    kinds: [...new Set(candidates.map((candidate) => candidate.kind))].sort(),
    state: candidates.length === 1 ? readState(candidates[0]?.element as HTMLElement) : null,
  };

  function findCandidates(): { element: HTMLElement; kind: string }[] {
    const selectors = [
      ["btn_add_buddy", "a.btn_add_buddy, button.btn_add_buddy"],
      ["add_buddy_action", "a._addBuddy, button._addBuddy"],
      ["buddy_popup_action", "a._buddy_popup_btn, button._buddy_popup_btn"],
      ["buddy_add_href", "a[href*='BuddyAddForm.naver']"],
      ["buddy_status", "[data-buddy-status], .buddy_state, ._buddyState"],
    ] as const;
    const seen = new Set<Element>();
    const matches: { element: HTMLElement; kind: string }[] = [];
    for (const [kind, selector] of selectors) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (seen.has(element) || !isVisible(element)) continue;
        seen.add(element);
        matches.push({ element, kind });
      }
    }
    return matches;
  }

  function readState(element: HTMLElement): RelationshipState {
    const state = (
      element.getAttribute("data-buddy-status") ??
      element.getAttribute("data-relation") ??
      ""
    )
      .trim()
      .toLowerCase();
    if (["mutual", "both", "mutual_neighbor"].includes(state)) return "already_mutual";
    if (["neighbor", "buddy"].includes(state)) return "already_neighbor";
    if (["pending", "requested"].includes(state)) return "request_pending";
    const label = normalize(
      `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${
        element.textContent ?? ""
      }`,
    );
    if (/서로이웃(?:입니다)?$/.test(label)) return "already_mutual";
    if (/^(?:나의)?이웃(?:입니다)?$/.test(label)) return "already_neighbor";
    if (/신청중|신청완료/.test(label)) return "request_pending";
    if (
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      /신청불가|추가불가/.test(label)
    ) {
      return "request_unavailable";
    }
    if (/^(?:\+)?(?:서로)?이웃(?:추가|신청)$/.test(label)) return "can_request";
    return "state_unknown";
  }

  function normalize(value: string): string {
    return value.replace(/\s+/g, "").trim();
  }

  function isVisible(element: HTMLElement): boolean {
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current = current.parentElement
    ) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.pointerEvents === "none"
      ) {
        return false;
      }
    }
    return true;
  }
}

function clickNeighborEntry(): NeighborEntryActionCode {
  const candidates = findCandidates();
  if (candidates.length === 0) return "not_found";
  if (candidates.length > 1) return "ambiguous";
  const target = candidates[0] as HTMLElement;
  const state = readState(target);
  if (state !== "can_request") return state;
  target.click();
  return "opened";

  function findCandidates(): HTMLElement[] {
    const selectors = [
      "a.btn_add_buddy, button.btn_add_buddy",
      "a._addBuddy, button._addBuddy",
      "a._buddy_popup_btn, button._buddy_popup_btn",
      "a[href*='BuddyAddForm.naver']",
      "[data-buddy-status], .buddy_state, ._buddyState",
    ];
    const seen = new Set<Element>();
    const matches: HTMLElement[] = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (seen.has(element) || !isVisible(element)) continue;
        seen.add(element);
        matches.push(element);
      }
    }
    return matches;
  }

  function readState(element: HTMLElement): RelationshipState {
    const state = (
      element.getAttribute("data-buddy-status") ??
      element.getAttribute("data-relation") ??
      ""
    )
      .trim()
      .toLowerCase();
    if (["mutual", "both", "mutual_neighbor"].includes(state)) return "already_mutual";
    if (["neighbor", "buddy"].includes(state)) return "already_neighbor";
    if (["pending", "requested"].includes(state)) return "request_pending";
    const label = `${element.getAttribute("aria-label") ?? ""} ${
      element.getAttribute("title") ?? ""
    } ${element.textContent ?? ""}`
      .replace(/\s+/g, "")
      .trim();
    if (/서로이웃(?:입니다)?$/.test(label)) return "already_mutual";
    if (/^(?:나의)?이웃(?:입니다)?$/.test(label)) return "already_neighbor";
    if (/신청중|신청완료/.test(label)) return "request_pending";
    if (
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      /신청불가|추가불가/.test(label)
    ) {
      return "request_unavailable";
    }
    if (/^(?:\+)?(?:서로)?이웃(?:추가|신청)$/.test(label)) return "can_request";
    return "state_unknown";
  }

  function isVisible(element: HTMLElement): boolean {
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current = current.parentElement
    ) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.pointerEvents === "none"
      ) {
        return false;
      }
    }
    return true;
  }
}

function probeMutualNeighborForm(): FormProbe {
  const forms = findForms();
  return {
    count: forms.length,
    kinds: [...new Set(forms.map((form) => form.kind))].sort(),
  };

  function findForms(): { element: HTMLElement; kind: string }[] {
    const selectors = [
      ["buddy_add_form_id", "form#buddyAddForm"],
      ["buddy_add_form_name", "form[name='buddyAddForm']"],
      ["naver_buddy_form_name", "form[name='buddyFrm']"],
      ["naver_buddy_application_form_name", "form[name='buddyApplyFrm']"],
      ["buddy_add_form_class", "form._buddyAddForm"],
      ["buddy_add_form_testid", "form[data-testid='buddy-add-form']"],
    ] as const;
    const seen = new Set<Element>();
    const forms: { element: HTMLElement; kind: string }[] = [];
    for (const [kind, selector] of selectors) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (seen.has(element) || !isVisible(element)) continue;
        seen.add(element);
        forms.push({ element, kind });
      }
    }
    return forms;
  }

  function isVisible(element: HTMLElement): boolean {
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current = current.parentElement
    ) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.pointerEvents === "none"
      ) {
        return false;
      }
    }
    return true;
  }
}

function selectMutualNeighborAndAdvance(message: string): NeighborFormActionCode {
  const forms = findForms();
  if (forms.length === 0) return "not_found";
  if (forms.length > 1) return "ambiguous";
  const form = forms[0] as HTMLElement;
  const mutualOptions = findMutualOptions(form);
  if (mutualOptions.length === 0) return "state_unknown";
  if (mutualOptions.length > 1) return "ambiguous";
  const mutual = mutualOptions[0] as HTMLInputElement;
  if (!mutual.checked) {
    mutual.click();
    if (!mutual.checked) return "state_unknown";
  }

  const submitButtons = findSubmitButtons(form);
  if (submitButtons.length > 1) return "ambiguous";
  if (submitButtons.length === 1) {
    const messageTargets = findMessageTargets(form);
    if (messageTargets.length > 1) return "ambiguous";
    if (messageTargets.length === 0) return "not_found";
    const messageTarget = messageTargets[0] as HTMLTextAreaElement;
    if (messageTarget.value.trim() !== "" && messageTarget.value !== message) {
      return "message_occupied";
    }
    messageTarget.value = message;
    messageTarget.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
    messageTarget.dispatchEvent(new Event("change", { bubbles: true }));
    if (messageTarget.value !== message) return "state_unknown";
    (submitButtons[0] as HTMLElement).click();
    return "submitted";
  }

  const firstNext = findNextButtons(form);
  if (firstNext.length === 0) return "not_found";
  if (firstNext.length > 1) return "ambiguous";
  (firstNext[0] as HTMLElement).click();
  return "advanced";

  function findForms(): HTMLElement[] {
    const selectors = [
      "form#buddyAddForm",
      "form[name='buddyAddForm']",
      "form[name='buddyFrm']",
      "form._buddyAddForm",
      "form[data-testid='buddy-add-form']",
    ];
    const seen = new Set<Element>();
    const matches: HTMLElement[] = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (seen.has(element) || !isVisible(element)) continue;
        seen.add(element);
        matches.push(element);
      }
    }
    return matches;
  }

  function findMutualOptions(root: HTMLElement): HTMLInputElement[] {
    const selectors = [
      "input[type='radio']#both_buddy",
      "input[type='radio']#each_buddy_add",
      "input[type='radio']#relation_both",
      "input[type='radio'][value='both']",
      "input[type='radio'][value='mutual']",
      "input[type='radio'][value='mutual_neighbor']",
    ];
    const seen = new Set<Element>();
    const matches: HTMLInputElement[] = [];
    for (const selector of selectors) {
      for (const element of root.querySelectorAll<HTMLInputElement>(selector)) {
        if (seen.has(element) || element.disabled || !isVisible(element)) continue;
        seen.add(element);
        matches.push(element);
      }
    }
    return matches;
  }

  function findMessageTargets(root: HTMLElement): HTMLTextAreaElement[] {
    return Array.from(
      root.querySelectorAll<HTMLTextAreaElement>(
        "textarea#message, textarea[name='message'], textarea[name='buddyMessage'], textarea._message",
      ),
    ).filter((element) => !element.disabled && !element.readOnly && isVisible(element));
  }

  function findSubmitButtons(root: HTMLElement): HTMLElement[] {
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        "button.btn_ok, a.btn_ok, button._submit, button[type='submit'], button[data-testid='buddy-submit']",
      ),
    ).filter((element) => {
      const label = `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`
        .replace(/\s+/g, "")
        .trim();
      return (
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-disabled") !== "true" &&
        /^(?:확인|신청|서로이웃신청)$/.test(label) &&
        isVisible(element)
      );
    });
  }

  function findNextButtons(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>("button, a, [role='button']")).filter(
      (element) => {
        const label = `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`
          .replace(/\s+/g, "")
          .trim();
        return (
          !element.hasAttribute("disabled") &&
          element.getAttribute("aria-disabled") !== "true" &&
          label === "다음" &&
          isVisible(element)
        );
      },
    );
  }

  function isVisible(element: HTMLElement): boolean {
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current = current.parentElement
    ) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.pointerEvents === "none"
      ) {
        return false;
      }
    }
    return true;
  }
}

function fillMutualNeighborApplicationAndSubmit(message: string): NeighborFormActionCode {
  const forms = Array.from(
    document.querySelectorAll<HTMLElement>("form[name='buddyApplyFrm']"),
  ).filter(isVisible);
  if (forms.length === 0) return diagnose();
  if (forms.length > 1) return "ambiguous";
  const form = forms[0] as HTMLElement;
  const messages = Array.from(
    form.querySelectorAll<HTMLTextAreaElement>(
      "textarea#message, textarea[name='message'], textarea[name='buddyMessage'], textarea._message",
    ),
  ).filter((element) => !element.disabled && !element.readOnly && isVisible(element));
  if (messages.length === 0) return "not_found";
  if (messages.length > 1) return "ambiguous";
  const target = messages[0] as HTMLTextAreaElement;
  if (target.value.trim() !== "" && target.value !== message) return "message_occupied";
  target.value = message;
  target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  if (target.value !== message) return "state_unknown";
  const next = Array.from(form.querySelectorAll<HTMLElement>("button, a, [role='button']")).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-disabled") !== "true" &&
      `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`
        .replace(/\s+/g, "")
        .trim() === "다음" &&
      isVisible(element),
  );
  if (next.length === 0) return "not_found";
  if (next.length > 1) return "ambiguous";
  (next[0] as HTMLElement).click();
  return "submitted";

  function diagnose(): NeighborFormActionCode {
    const text = document.body?.innerText ?? document.body?.textContent ?? "";
    if (
      document.querySelector(
        ".captcha, #captcha, iframe[title*='캡차'], iframe[title*='captcha' i]",
      )
    )
      return "captcha_required";
    if (
      document.querySelector("a[href*='nidlogin.login'], form[action*='nidlogin.login']") ||
      /로그인\s*(?:후|이 필요)/.test(text)
    )
      return "login_required";
    return "not_found";
  }

  function isVisible(element: HTMLElement): boolean {
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current = current.parentElement
    ) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.pointerEvents === "none"
      )
        return false;
    }
    return true;
  }
}

function probeMutualNeighborConfirmation(): MutualNeighborConfirmationProbe {
  const text = document.body?.innerText ?? document.body?.textContent ?? "";
  const captcha =
    document.querySelector(
      ".captcha, #captcha, iframe[title*='캡차'], iframe[title*='captcha' i]",
    ) !== null;
  const loginRequired =
    document.querySelector("a[href*='nidlogin.login'], form[action*='nidlogin.login']") !== null ||
    /로그인\s*(?:후|이 필요)/.test(text);
  const confirmed =
    /서로이웃\s*(?:을|를)?\s*신청하였습니다|서로이웃\s*(?:신청|추가).*(?:완료|되었습니다)|신청\s*중/.test(
      text,
    );
  const closeCount = confirmed
    ? Array.from(document.querySelectorAll<HTMLElement>("button, a, [role='button']")).filter(
        (element) =>
          `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`
            .replace(/\s+/g, "")
            .trim() === "닫기" && isVisible(element),
      ).length
    : 0;
  return {
    closeCount,
    confirmed,
    diagnosis: captcha ? "captcha_required" : loginRequired ? "login_required" : null,
  };

  function isVisible(element: HTMLElement): boolean {
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current = current.parentElement
    ) {
      const style = getComputedStyle(current);
      if (
        current.hidden ||
        current.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.pointerEvents === "none"
      )
        return false;
    }
    return true;
  }
}

function closeMutualNeighborConfirmation(): "ambiguous" | "closed" | "not_found" {
  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>("button, a, [role='button']"),
  ).filter(
    (element) =>
      `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`
        .replace(/\s+/g, "")
        .trim() === "닫기" && isVisible(element),
  );
  if (buttons.length === 0) return "not_found";
  if (buttons.length > 1) return "ambiguous";
  (buttons[0] as HTMLElement).click();
  return "closed";

  function isVisible(element: HTMLElement): boolean {
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current = current.parentElement
    ) {
      const style = getComputedStyle(current);
      if (
        current.hidden ||
        current.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.pointerEvents === "none"
      )
        return false;
    }
    return true;
  }
}

function diagnoseNeighborPage(): PageDiagnosis {
  const text = document.body?.innerText ?? document.body?.textContent ?? "";
  return {
    captcha:
      document.querySelector(
        ".captcha, #captcha, iframe[title*='캡차'], iframe[title*='captcha' i]",
      ) !== null,
    loginRequired:
      document.querySelector("a[href*='nidlogin.login'], form[action*='nidlogin.login']") !==
        null || /로그인\s*(?:후|이 필요)/.test(text),
    unavailable: /이웃\s*(?:추가|신청).*(?:제한|불가|할 수 없)/.test(text),
  };
}
