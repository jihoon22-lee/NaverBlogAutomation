import type {
  EngagementApprovalDetails,
  EngagementApprovalSession,
  EngagementApprovalToken,
} from "./approval-session";
import { EngagementConsentStore } from "./consent-store";

export interface EngagementConsentControllerDependencies {
  session: EngagementApprovalSession;
  store?: EngagementConsentStore;
}

export class EngagementConsentController {
  readonly #document: Document;
  readonly #session: EngagementApprovalSession;
  readonly #store: EngagementConsentStore;
  #active = false;

  constructor(
    document: Document,
    { session, store = new EngagementConsentStore() }: EngagementConsentControllerDependencies,
  ) {
    this.#document = document;
    this.#session = session;
    this.#store = store;
  }

  async start(): Promise<void> {
    this.#button("engagement-consent-agree").addEventListener("click", () => void this.#agree());
    this.#button("engagement-consent-withdraw").addEventListener(
      "click",
      () => void this.#withdraw(),
    );
    this.#renderConsent(await this.#store.load());
  }

  requestApproval(details: EngagementApprovalDetails): Promise<EngagementApprovalToken | null> {
    if (!this.#active) {
      this.#dispatch("engagement-consent-required", {});
      return Promise.resolve(null);
    }
    const host = supportedHost(details.sourceUrl);
    if (
      host === null ||
      details.title.trim() === "" ||
      details.comment.trim() === "" ||
      details.steps.length === 0
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.#session.issue(details));
  }

  dispose(): void {
    this.cancelPendingApproval();
    this.#session.revokeAll();
  }

  cancelPendingApproval(): void {
    this.#session.revokeAll();
  }

  async #agree(): Promise<void> {
    const checkbox = this.#checkbox("engagement-consent-checkbox");
    if (!checkbox.checked) {
      this.#notice("자동 실행 범위를 확인하고 동의 항목을 선택해 주세요.");
      return;
    }
    try {
      this.#renderConsent(await this.#store.agree());
      checkbox.checked = false;
      this.#notice("사용자 승인형 자동 실행에 동의했습니다.");
    } catch {
      this.#notice("동의를 저장하지 못했습니다. Browser storage를 확인해 주세요.");
    }
  }

  async #withdraw(): Promise<void> {
    try {
      this.#renderConsent(await this.#store.withdraw());
      this.cancelPendingApproval();
      this.#notice("자동 실행 동의를 철회했습니다. 댓글 복사는 계속 사용할 수 있습니다.");
    } catch {
      this.#notice("동의 철회를 저장하지 못했습니다. Browser storage를 확인해 주세요.");
    }
  }

  #renderConsent(consent: { active: boolean; agreedAt: string | null }): void {
    this.#active = consent.active;
    this.#element("engagement-consent-status").textContent = consent.active
      ? `동의함 · ${consent.agreedAt === null ? "시각 미상" : new Date(consent.agreedAt).toLocaleString()}`
      : "동의하지 않음 · 댓글 복사만 사용";
    this.#button("engagement-consent-agree").hidden = consent.active;
    this.#button("engagement-consent-withdraw").hidden = !consent.active;
    this.#checkbox("engagement-consent-checkbox").disabled = consent.active;
  }

  #notice(value: string): void {
    this.#element("engagement-consent-notice").textContent = value;
  }

  #dispatch(name: string, detail: object): void {
    const EventConstructor = this.#document.defaultView?.CustomEvent;
    if (EventConstructor !== undefined) {
      this.#document.defaultView?.dispatchEvent(new EventConstructor(name, { detail }));
    }
  }

  #button(id: string): HTMLButtonElement {
    const value = this.#element(id);
    if (!(value instanceof HTMLButtonElement)) throw new Error(`${id} 버튼을 찾지 못했습니다.`);
    return value;
  }

  #checkbox(id: string): HTMLInputElement {
    const value = this.#element(id);
    if (!(value instanceof HTMLInputElement)) throw new Error(`${id} 입력을 찾지 못했습니다.`);
    return value;
  }

  #element(id: string): HTMLElement {
    const value = this.#document.getElementById(id);
    if (value === null) throw new Error(`${id} 요소를 찾지 못했습니다.`);
    return value;
  }
}

function supportedHost(sourceUrl: string): string | null {
  try {
    const url = new URL(sourceUrl);
    return url.protocol === "https:" &&
      (url.hostname === "blog.naver.com" || url.hostname === "m.blog.naver.com")
      ? url.hostname
      : null;
  } catch {
    return null;
  }
}
