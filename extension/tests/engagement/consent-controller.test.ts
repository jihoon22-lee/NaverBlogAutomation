import { readFile } from "node:fs/promises";

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngagementApprovalSession } from "../../src/engagement/approval-session";
import { EngagementConsentController } from "../../src/engagement/consent-controller";
import {
  ENGAGEMENT_CONSENT_STORAGE_KEY,
  ENGAGEMENT_CONSENT_VERSION,
  EngagementConsentStore,
  type ConsentStorageArea,
} from "../../src/engagement/consent-store";

const htmlPath = new URL("../../public/sidepanel.html", import.meta.url);
let document: Document;

class MemoryStorage implements ConsentStorageArea {
  value: Record<string, unknown> = {};

  async get(): Promise<Record<string, unknown>> {
    return structuredClone(this.value);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.value = { ...this.value, ...structuredClone(items) };
  }
}

beforeEach(async () => {
  const dom = new JSDOM(await readFile(htmlPath, "utf8"), {
    pretendToBeVisual: true,
    url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sidepanel.html",
  });
  document = dom.window.document;
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
});

afterEach(() => vi.unstubAllGlobals());

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function setup(active = false) {
  const storage = new MemoryStorage();
  if (active) {
    storage.value[ENGAGEMENT_CONSENT_STORAGE_KEY] = {
      active: true,
      agreedAt: "2026-07-27T00:00:00.000Z",
      version: ENGAGEMENT_CONSENT_VERSION,
    };
  }
  const session = new EngagementApprovalSession(() => "approval-1");
  const controller = new EngagementConsentController(document, {
    session,
    store: new EngagementConsentStore(storage, () => new Date("2026-07-27T01:02:03.000Z")),
  });
  return { controller, session, storage };
}

describe("EngagementConsentController", () => {
  it("requires the explicit checkbox before enabling consent", async () => {
    const { controller, storage } = setup();
    await controller.start();
    const checkbox = document.querySelector("#engagement-consent-checkbox") as HTMLInputElement;
    const label = checkbox.closest("label");
    expect(label?.textContent).toContain("약관 안내를 확인");
    expect(document.querySelector("#engagement-consent-notice")?.getAttribute("aria-live")).toBe(
      "polite",
    );
    (document.querySelector("#engagement-consent-agree") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("#engagement-consent-notice")?.textContent).toContain(
      "동의 항목",
    );
    expect(storage.value).toEqual({});

    checkbox.checked = true;
    (document.querySelector("#engagement-consent-agree") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("#engagement-consent-status")?.textContent).toContain("동의함");
    expect(storage.value).toEqual({
      [ENGAGEMENT_CONSENT_STORAGE_KEY]: {
        active: true,
        agreedAt: "2026-07-27T01:02:03.000Z",
        version: ENGAGEMENT_CONSENT_VERSION,
      },
    });
    expect(JSON.stringify(storage.value)).not.toContain("댓글");
    expect(JSON.stringify(storage.value)).not.toContain("blog.naver.com");
  });

  it("shows one final confirmation and issues a consumable token only on execute", async () => {
    const { controller, session } = setup(true);
    await controller.start();
    const pending = controller.requestApproval({
      comment: "최종 승인 댓글",
      neighborMessage: "서로이웃 신청 메시지",
      sourceUrl: "https://blog.naver.com/synthetic/7",
      steps: ["like", "comment", "mutual_neighbor"],
      title: "합성 글 제목",
    });
    expect(document.querySelector("#engagement-confirmation")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#engagement-confirm-steps")?.textContent).toContain("공감");
    expect(document.querySelector("#engagement-confirm-comment")?.textContent).toBe(
      "최종 승인 댓글",
    );
    expect(document.querySelector("#engagement-confirmation")?.getAttribute("role")).toBe("dialog");
    expect(document.activeElement?.id).toBe("engagement-confirm-execute");

    (document.querySelector("#engagement-confirm-execute") as HTMLButtonElement).click();
    const token = await pending;

    expect(token?.id).toBe("approval-1");
    expect(session.consume(token?.id ?? "")?.details.comment).toBe("최종 승인 댓글");
    expect(session.consume(token?.id ?? "")).toBeNull();
    expect(document.querySelector("#engagement-confirmation")?.hasAttribute("hidden")).toBe(true);
  });

  it("does not issue approval without consent, confirmation, or a supported exact origin", async () => {
    const consentRequired = vi.fn();
    document.defaultView?.addEventListener("engagement-consent-required", consentRequired, {
      once: true,
    });
    const inactive = setup();
    await inactive.controller.start();
    await expect(
      inactive.controller.requestApproval({
        comment: "등록하면 안 되는 댓글",
        sourceUrl: "https://blog.naver.com/synthetic/12",
        steps: ["comment"],
        title: "동의하지 않은 글",
      }),
    ).resolves.toBeNull();
    expect(inactive.session.consume("approval-1")).toBeNull();
    expect(consentRequired).toHaveBeenCalledOnce();

    const active = setup(true);
    await active.controller.start();
    await expect(
      active.controller.requestApproval({
        comment: "지원하지 않는 주소의 댓글",
        sourceUrl: "https://blog.naver.com.example/synthetic/13",
        steps: ["comment"],
        title: "지원하지 않는 글",
      }),
    ).resolves.toBeNull();
    expect(document.querySelector("#engagement-confirmation")?.hasAttribute("hidden")).toBe(true);
    expect(active.session.consume("approval-1")).toBeNull();
  });

  it("cancels pending approval on withdrawal and keeps manual assistance available", async () => {
    const { controller, session } = setup(true);
    await controller.start();
    const pending = controller.requestApproval({
      comment: "취소할 댓글",
      sourceUrl: "https://blog.naver.com/synthetic/8",
      steps: ["like", "comment"],
      title: "취소할 글",
    });
    expect(
      await controller.requestApproval({
        comment: "두 번째 댓글",
        sourceUrl: "https://blog.naver.com/synthetic/9",
        steps: ["comment"],
        title: "두 번째 글",
      }),
    ).toBeNull();

    (document.querySelector("#engagement-consent-withdraw") as HTMLButtonElement).click();
    await settle();

    await expect(pending).resolves.toBeNull();
    expect(document.querySelector("#engagement-consent-notice")?.textContent).toContain(
      "입력 보조와 복사",
    );
    session.revokeAll();
    await expect(
      controller.requestApproval({
        comment: "철회 뒤 댓글",
        sourceUrl: "https://blog.naver.com/synthetic/10",
        steps: ["comment"],
        title: "철회 뒤 글",
      }),
    ).resolves.toBeNull();
  });

  it("cancels a pending approval when navigation invalidates the current page", async () => {
    const { controller } = setup(true);
    await controller.start();
    const pending = controller.requestApproval({
      comment: "이동 전 댓글",
      sourceUrl: "https://blog.naver.com/synthetic/11",
      steps: ["comment"],
      title: "이동 전 글",
    });

    controller.cancelPendingApproval();

    await expect(pending).resolves.toBeNull();
  });
});
