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
    commentMood: "warm",
    createdAt: "2026-07-17T00:00:00Z",
    editedComment: null,
    id: "recommendation",
    relationshipLevel: "friendly",
    qualityWarnings: [],
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
    changeOptions: vi.fn(),
    cleanup: vi.fn(),
    complete: vi.fn(),
    copy: vi.fn(),
    changeCommentLength: vi.fn(),
    changeCommentMood: vi.fn(),
    changeClosingPhrase: vi.fn(),
    changeRelationship: vi.fn(),
    changeSpeechStyle: vi.fn(),
    edit: vi.fn(),
    generate: vi.fn(),
    regenerate: vi.fn(),
    replace: vi.fn(),
    retry: vi.fn(),
    savePreferences: vi.fn(),
    select: vi.fn(),
    useCandidate: vi.fn(),
    useEdited: vi.fn(),
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
      closingPhrase: "",
      kind: "preview",
      preferences: {
        commentLength: "medium",
        commentMood: "warm",
        relationshipLevel: "friendly",
        speechStyle: "honorific",
      },
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
      closingPhrase: "",
      kind: "preview",
      preferences: {
        commentLength: "medium",
        commentMood: "warm",
        relationshipLevel: "friendly",
        speechStyle: "honorific",
      },
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

  it("keeps radio focus while rendering valid preference changes", async () => {
    const window = document.defaultView;
    if (window === null) throw new Error("Synthetic window is missing");
    const changeRelationship = vi.fn();
    const changeSpeechStyle = vi.fn();
    const changeCommentLength = vi.fn();
    view.bind(actions({ changeCommentLength, changeRelationship, changeSpeechStyle }));
    const preview = {
      body: "충분한 길이의 합성 본문 내용입니다.",
      frameId: 0,
      originalLength: 20,
      sourceUrl: "https://blog.naver.com/synthetic/options",
      tabId: 2,
      title: "합성 제목",
      transmittedLength: 20,
      truncated: false,
    };
    view.render({
      closingPhrase: "",
      kind: "preview",
      preferences: {
        commentLength: "medium",
        commentMood: "warm",
        relationshipLevel: "friendly",
        speechStyle: "honorific",
      },
      preview,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const close = document.querySelector<HTMLInputElement>(
      'input[name="relationship"][value="close"]',
    );
    close?.focus();
    close?.click();
    expect(changeRelationship).toHaveBeenCalledWith("close");
    view.render({
      closingPhrase: "",
      kind: "preview",
      preferences: {
        commentLength: "long",
        commentMood: "lively",
        relationshipLevel: "close",
        speechStyle: "banmal",
      },
      preview,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(close);
    expect(
      document.querySelector<HTMLInputElement>('input[name="speech-style"][value="banmal"]')
        ?.disabled,
    ).toBe(false);
  });

  it("exposes described mood and actual length options through labelled radio groups", () => {
    const window = document.defaultView;
    if (window === null) throw new Error("Synthetic window is missing");
    const changeCommentMood = vi.fn();
    view.bind(actions({ changeCommentMood }));
    view.render({
      closingPhrase: "",
      kind: "preview",
      preferences: {
        commentLength: "medium",
        commentMood: "warm",
        relationshipLevel: "friendly",
        speechStyle: "honorific",
      },
      preview: {
        body: "충분한 길이의 합성 본문 내용입니다.",
        frameId: 0,
        originalLength: 20,
        sourceUrl: "https://blog.naver.com/synthetic/mood",
        tabId: 2,
        title: "합성 제목",
        transmittedLength: 20,
        truncated: false,
      },
    });

    expect(document.querySelector("#comment-length-options")?.textContent).toContain("40–80자");
    expect(document.querySelector("#comment-length-options")?.textContent).toContain("200–320자");
    expect(document.querySelector("#comment-mood-options")?.textContent).toContain(
      "공감과 친근함을 담은 느낌",
    );
    document.querySelector<HTMLInputElement>('input[name="comment-mood"][value="lively"]')?.click();
    expect(changeCommentMood).toHaveBeenCalledWith("lively");
  });

  it("edits a reusable closing phrase with a visible local-only explanation", () => {
    const window = document.defaultView;
    if (window === null) throw new Error("Synthetic window is missing");
    const changeClosingPhrase = vi.fn();
    view.bind(actions({ changeClosingPhrase }));
    view.render({
      closingPhrase: "기존 문구",
      kind: "preview",
      preferences: {
        commentLength: "medium",
        commentMood: "warm",
        relationshipLevel: "friendly",
        speechStyle: "honorific",
      },
      preview: {
        body: "충분한 길이의 합성 본문 내용입니다.",
        frameId: 0,
        originalLength: 20,
        sourceUrl: "https://blog.naver.com/synthetic/phrase",
        tabId: 2,
        title: "합성 제목",
        transmittedLength: 20,
        truncated: false,
      },
    });

    const input = document.querySelector<HTMLInputElement>("#closing-phrase");
    if (input === null) throw new Error("Closing phrase input is missing");
    expect(input.value).toBe("기존 문구");
    expect(document.querySelector("#closing-phrase-help")?.textContent).toContain(
      "OpenAI에는 전송하지 않습니다",
    );
    input.value = "오늘도 좋은 하루 보내세요!";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(changeClosingPhrase).toHaveBeenCalledWith("오늘도 좋은 하루 보내세요!");
    expect(document.querySelector("#closing-phrase-count")?.textContent).toContain("15 / 50자");
  });

  it("shows deduplicated quality warnings without blocking three-candidate review", () => {
    view.render({
      kind: "review",
      ...recommendation,
      recommendation: {
        ...recommendation.recommendation,
        qualityWarnings: ["length_target_missed", "length_target_missed", "candidates_too_similar"],
      },
    });

    expect((document.querySelector("#quality-warning-panel") as HTMLElement).hidden).toBe(false);
    expect(document.querySelectorAll("#quality-warning-list li")).toHaveLength(2);
    expect(document.querySelector("#quality-warning-list")?.textContent).toContain("길이 범위");
    expect(document.querySelectorAll('#candidate-list input[name="candidate"]')).toHaveLength(3);
    expect(document.querySelectorAll("button[data-use-candidate]")).toHaveLength(3);
  });

  it("offers a direct candidate-use action without requiring the edit flow", () => {
    const useCandidate = vi.fn();
    view.bind(actions({ useCandidate }));
    view.render({ kind: "review", ...recommendation });

    const buttons = document.querySelectorAll<HTMLButtonElement>("button[data-use-candidate]");
    buttons[1]?.click();

    expect(buttons).toHaveLength(3);
    expect(useCandidate).toHaveBeenCalledWith("2");
    expect((document.querySelector("#edit-section") as HTMLElement).hidden).toBe(true);
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
    const useEdited = vi.fn();
    const copy = vi.fn();
    const complete = vi.fn();
    view.bind(actions({ complete, copy, edit, select, useEdited }));
    view.render({ kind: "review", ...recommendation });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const radios = document.querySelectorAll<HTMLInputElement>('input[name="candidate"]');
    expect(radios).toHaveLength(3);
    expect(document.activeElement?.id).toBe("result-title");
    expect(document.querySelector("#generated-relationship")?.textContent).toBe("편한 이웃");
    expect(document.querySelector("#generated-speech-style")?.textContent).toBe("존댓말");
    expect(document.querySelector("#generated-comment-length")?.textContent).toBe(
      "보통 (100–160자)",
    );
    expect(document.querySelector("#generated-comment-mood")?.textContent).toBe("따뜻하게");
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
    (document.querySelector("#edited-use-button") as HTMLButtonElement).click();

    expect(select).toHaveBeenCalledWith("2");
    expect(edit).toHaveBeenCalledWith("키보드로 다듬은 댓글");
    expect(useEdited).toHaveBeenCalledOnce();

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
    const regenerate = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    view.bind(actions({ cleanup, regenerate, replace }));

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

    view.render({ kind: "review", ...recommendation });
    (document.querySelector("#regenerate-button") as HTMLButtonElement).click();

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(regenerate).toHaveBeenCalledOnce();
  });

  it("clears article and comment text from hidden DOM on generation and errors", () => {
    view.render({
      closingPhrase: "",
      kind: "preview",
      preferences: {
        commentLength: "medium",
        commentMood: "warm",
        relationshipLevel: "friendly",
        speechStyle: "honorific",
      },
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
