import { readFile } from "node:fs/promises";

import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DomPanelView } from "../../src/sidepanel/view";
import type { PanelActions, ReviewPresentation } from "../../src/sidepanel/state";

const htmlPath = new URL("../../public/sidepanel.html", import.meta.url);
let document: Document;
let view: DomPanelView;

const recommendation: ReviewPresentation = {
  copied: false,
  editedComment: "",
  recommendation: {
    candidates: [
      { comment: "따뜻한 댓글", id: "1", referencedDetail: "전시 동선", tone: "warm" },
      { comment: "궁금한 댓글", id: "2", referencedDetail: "작품 설명", tone: "curious" },
      { comment: "응원 댓글", id: "3", referencedDetail: "다음 계획", tone: "supportive" },
    ],
    commentLength: "medium",
    createdAt: "2026-07-17T00:00:00Z",
    editedComment: null,
    id: "recommendation",
    relationshipLevel: "friendly",
    reviewStatus: "drafted",
    selectedCandidateId: null,
    sourceUrl: "https://blog.naver.com/synthetic/1",
    speechStyle: "honorific",
    summary: "합성 요약",
    title: "합성 제목",
    topics: ["전시", "동선"],
    updatedAt: null,
  },
  selectedCandidateId: null,
};

function actions(overrides: Partial<PanelActions> = {}): PanelActions {
  return {
    approve: vi.fn(),
    cancel: vi.fn(),
    cleanup: vi.fn(),
    complete: vi.fn(),
    copy: vi.fn(),
    edit: vi.fn(),
    generate: vi.fn(),
    replace: vi.fn(),
    retry: vi.fn(),
    select: vi.fn(),
    ...overrides,
  };
}

beforeEach(async () => {
  const html = await readFile(htmlPath, "utf8");
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sidepanel.html",
  });
  document = dom.window.document;
  view = new DomPanelView(document);
});

describe("DomPanelView", () => {
  it("announces progress without exposing preview controls", () => {
    view.render({ kind: "extracting" });

    expect(document.querySelector("#app")?.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector("#status")?.textContent).toContain("확인하고");
    expect((document.querySelector("#preview-panel") as HTMLElement).hidden).toBe(true);
  });

  it("renders a bounded preview and enables explicit generation", async () => {
    view.render({
      kind: "preview",
      preview: {
        body: "구체적인 전시 감상과 관람 동선을 정리한 합성 본문입니다. ".repeat(40),
        documentId: "document-1",
        frameId: 1,
        originalLength: 120_000,
        sourceUrl: "https://blog.naver.com/synthetic/1",
        tabId: 1,
        title: "합성 전시 후기",
        transmittedLength: 100_000,
        truncated: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((document.querySelector("#preview-panel") as HTMLElement).hidden).toBe(false);
    expect(document.querySelector("#post-title")?.textContent).toBe("합성 전시 후기");
    expect(document.querySelector("#character-count")?.textContent).toContain("100,000");
    expect(document.querySelector("#truncation-notice")?.textContent).toContain("API 제한");
    expect(document.querySelector("#body-preview")?.textContent?.endsWith("…")).toBe(true);
    expect((document.querySelector("#generate-button") as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement?.id).toBe("preview-title");
  });

  it("hides the truncation notice for content within the API limit", () => {
    view.render({
      kind: "preview",
      preview: {
        body: "충분한 길이의 합성 본문 내용입니다.",
        frameId: 0,
        originalLength: 20,
        sourceUrl: "https://blog.naver.com/synthetic/2",
        tabId: 2,
        title: "합성 제목",
        transmittedLength: 20,
        truncated: false,
      },
    });

    expect((document.querySelector("#truncation-notice") as HTMLElement).hidden).toBe(true);
    expect(document.querySelector("#body-preview")?.textContent).toBe(
      "충분한 길이의 합성 본문 내용입니다.",
    );
  });

  it("renders actionable errors and invokes retry from a keyboard-operable button", async () => {
    const retry = vi.fn();
    view.bind(actions({ retry }));

    view.render({ failure: { code: "permission_denied" }, kind: "error" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    (document.querySelector("#retry-button") as HTMLButtonElement).click();

    expect((document.querySelector("#error-panel") as HTMLElement).hidden).toBe(false);
    expect(document.querySelector("#error-message")?.textContent).toContain("권한");
    expect(document.activeElement?.id).toBe("error-title");
    expect(retry).toHaveBeenCalledOnce();
  });

  it("guides a missing active-tab grant back to the toolbar action", () => {
    view.render({ failure: { code: "no_active_tab" }, kind: "error" });

    expect(document.querySelector("#error-message")?.textContent).toBe(
      "네이버 글 탭을 활성화한 뒤 확장 프로그램 toolbar 아이콘을 다시 클릭해 주세요.",
    );
  });

  it("renders a keyboard-operable candidate, edit, approve, copy, and completion flow", async () => {
    const window = document.defaultView;
    if (window === null) {
      throw new Error("Synthetic window is missing");
    }
    const select = vi.fn();
    const edit = vi.fn();
    const approve = vi.fn();
    const copy = vi.fn();
    const complete = vi.fn();
    view.bind(actions({ approve, complete, copy, edit, select }));
    view.render({ kind: "review", ...recommendation });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const radios = document.querySelectorAll<HTMLInputElement>('input[name="candidate"]');
    expect(radios).toHaveLength(3);
    expect(document.activeElement?.id).toBe("result-title");
    radios[1]?.focus();
    radios[1]?.click();
    view.render({
      kind: "review",
      ...recommendation,
      editedComment: "궁금한 댓글",
      selectedCandidateId: "2",
    });
    expect((document.activeElement as HTMLInputElement).value).toBe("2");
    const textarea = document.querySelector("#edited-comment") as HTMLTextAreaElement;
    textarea.value = "키보드로 다듬은 댓글";
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    (document.querySelector("#approve-button") as HTMLButtonElement).click();

    expect(select).toHaveBeenCalledWith("2");
    expect(edit).toHaveBeenCalledWith("키보드로 다듬은 댓글");
    expect(approve).toHaveBeenCalledOnce();

    view.render({
      kind: "approved",
      ...recommendation,
      editedComment: "키보드로 다듬은 댓글",
      recommendation: {
        ...recommendation.recommendation,
        editedComment: "키보드로 다듬은 댓글",
        reviewStatus: "approved",
        selectedCandidateId: "2",
      },
      selectedCandidateId: "2",
    });
    (document.querySelector("#copy-button") as HTMLButtonElement).click();
    (document.querySelector("#complete-button") as HTMLButtonElement).click();
    expect(copy).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("uses Clipboard API best effort and leaves a selectable fallback", async () => {
    const navigator = document.defaultView?.navigator;
    if (navigator === undefined) {
      throw new Error("Synthetic navigator is missing");
    }
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    expect(await view.copyText("승인한 합성 댓글")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("승인한 합성 댓글");

    const approved = {
      kind: "approved" as const,
      ...recommendation,
      editedComment: "수동 선택 댓글",
      recommendation: {
        ...recommendation.recommendation,
        editedComment: "수동 선택 댓글",
        reviewStatus: "approved" as const,
        selectedCandidateId: "1",
      },
      selectedCandidateId: "1",
    };
    view.render(approved);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    expect(await view.copyText("수동 선택 댓글")).toBe(false);
    view.render(approved);
    const textarea = document.querySelector("#edited-comment") as HTMLTextAreaElement;
    expect(document.activeElement?.id).toBe("edited-comment");
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe("수동 선택 댓글".length);
  });

  it("requires confirmation for replacement and registry cleanup actions", () => {
    const window = document.defaultView;
    if (window === null) {
      throw new Error("Synthetic window is missing");
    }
    const replace = vi.fn();
    const cleanup = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    view.bind(actions({ cleanup, replace }));

    view.render({
      failure: {
        action: "replace",
        code: "generation_indeterminate",
        message: "unknown",
        title: "확인 필요",
      },
      kind: "error",
    });
    (document.querySelector("#replace-button") as HTMLButtonElement).click();
    view.render({
      failure: {
        action: "cleanup",
        code: "registry_invalid",
        message: "invalid",
        title: "정리 필요",
      },
      kind: "error",
    });
    (document.querySelector("#cleanup-button") as HTMLButtonElement).click();

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("clears article and comment text from hidden DOM on generation and errors", () => {
    view.render({
      kind: "preview",
      preview: {
        body: "민감하지 않은 합성 본문이지만 메모리 해제를 검증할 충분한 길이입니다.",
        frameId: 0,
        originalLength: 38,
        sourceUrl: "https://blog.naver.com/synthetic/clear",
        tabId: 1,
        title: "지울 합성 제목",
        transmittedLength: 38,
        truncated: false,
      },
    });
    view.render({ canCancel: true, kind: "generating", message: "처리 중" });
    expect(document.querySelector("#body-preview")?.textContent).toBe("");
    expect(document.querySelector("#post-title")?.textContent).toBe("");

    view.render({ kind: "review", ...recommendation, editedComment: "지울 합성 댓글" });
    view.render({ failure: { code: "stale_page" }, kind: "error" });
    expect((document.querySelector("#edited-comment") as HTMLTextAreaElement).value).toBe("");
    expect(document.querySelector("#candidate-list")?.children).toHaveLength(0);
  });

  it("fails fast when required static markup is missing", () => {
    expect(() => new DomPanelView(document.implementation.createHTMLDocument())).toThrow(
      "Missing Side Panel element",
    );
  });
});
