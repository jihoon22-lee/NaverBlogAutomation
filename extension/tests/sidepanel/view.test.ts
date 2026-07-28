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
    personalizationApplied: false,
    personalizationEligible: true,
    personalizationMode: "completed_examples",
    personalizationSampleCount: 0,
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
    changePersonalizationMode: vi.fn(),
    changeClosingPhrase: vi.fn(),
    changeRelationship: vi.fn(),
    changeSpeechStyle: vi.fn(),
    edit: vi.fn(),
    engage: vi.fn(),
    generate: vi.fn(),
    manualComplete: vi.fn(),
    changeNeighborMessage: vi.fn(),
    regenerate: vi.fn(),
    replace: vi.fn(),
    retry: vi.fn(),
    savePreferences: vi.fn(),
    select: vi.fn(),
    useEdited: vi.fn(),
    ...overrides,
  };
}

function submitEvent(): Event {
  const event = document.createEvent("Event");
  event.initEvent("submit", true, true);
  return event;
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
  it("lets the user record only confirmed steps for a failed engagement run", () => {
    const manualComplete = vi.fn();
    view.bind(actions({ manualComplete }));
    const dialog = document.querySelector("#engagement-manual-dialog") as HTMLDialogElement;
    dialog.showModal = vi.fn();
    dialog.close = vi.fn();
    view.render({
      ...recommendation,
      discoveryPost: {
        createdAt: "2026-07-28T00:00:00Z",
        id: "post",
        neighborId: "neighbor",
        publishedAt: null,
        publisherBlogId: null,
        publisherName: "이웃",
        searchId: null,
        source: "neighbor",
        sourceUrl: recommendation.recommendation.sourceUrl,
        state: "opened",
        title: recommendation.recommendation.title,
        updatedAt: "2026-07-28T00:00:00Z",
      },
      engagementRun: {
        approvalId: "approval",
        createdAt: "2026-07-28T00:00:00Z",
        discoveryPostId: "post",
        id: "run",
        recommendationId: recommendation.recommendation.id,
        source: "neighbor",
        state: "failed",
        steps: [
          {
            name: "like",
            position: 0,
            resultCode: "clicked",
            state: "succeeded",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          {
            name: "comment",
            position: 1,
            resultCode: null,
            state: "pending",
            updatedAt: "2026-07-28T00:00:00Z",
          },
        ],
        updatedAt: "2026-07-28T00:00:00Z",
      },
      kind: "approved",
      recommendation: { ...recommendation.recommendation, reviewStatus: "approved" },
    });

    const button = document.querySelector("#engagement-manual-button") as HTMLButtonElement;
    button.click();
    expect(button.hidden).toBe(false);
    expect(dialog.showModal).toHaveBeenCalledOnce();
    const comment = document.querySelector<HTMLInputElement>(
      'input[name="manual-engagement-step"][value="comment"]',
    );
    comment?.click();
    (document.querySelector("#engagement-manual-form") as HTMLFormElement).dispatchEvent(
      submitEvent(),
    );
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(manualComplete).toHaveBeenCalledWith(["like", "comment"]);
  });

  it("keeps a failed engagement unrecorded when comment registration is not confirmed", () => {
    const manualComplete = vi.fn();
    view.bind(actions({ manualComplete }));
    const dialog = document.querySelector("#engagement-manual-dialog") as HTMLDialogElement;
    dialog.showModal = vi.fn();
    view.render({
      ...recommendation,
      discoveryPost: {
        createdAt: "2026-07-28T00:00:00Z",
        id: "post",
        neighborId: "neighbor",
        publishedAt: null,
        publisherBlogId: null,
        publisherName: "이웃",
        searchId: null,
        source: "neighbor",
        sourceUrl: recommendation.recommendation.sourceUrl,
        state: "opened",
        title: recommendation.recommendation.title,
        updatedAt: "2026-07-28T00:00:00Z",
      },
      engagementRun: {
        approvalId: "approval",
        createdAt: "2026-07-28T00:00:00Z",
        discoveryPostId: "post",
        id: "run",
        recommendationId: recommendation.recommendation.id,
        source: "neighbor",
        state: "failed",
        steps: [
          {
            name: "like",
            position: 0,
            resultCode: "not_found",
            state: "failed",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          {
            name: "comment",
            position: 1,
            resultCode: null,
            state: "pending",
            updatedAt: "2026-07-28T00:00:00Z",
          },
        ],
        updatedAt: "2026-07-28T00:00:00Z",
      },
      kind: "approved",
      recommendation: { ...recommendation.recommendation, reviewStatus: "approved" },
    });

    (document.querySelector("#engagement-manual-button") as HTMLButtonElement).click();
    (document.querySelector("#engagement-manual-form") as HTMLFormElement).dispatchEvent(
      submitEvent(),
    );
    expect(manualComplete).not.toHaveBeenCalled();
    expect(document.querySelector("#engagement-manual-notice")?.textContent).toContain("댓글 등록");
  });

  it("closes the manual-completion dialog without recording anything when cancelled", () => {
    const dialog = document.querySelector("#engagement-manual-dialog") as HTMLDialogElement;
    dialog.close = vi.fn();
    view.bind(actions());

    (dialog.querySelector('button[value="cancel"]') as HTMLButtonElement).click();

    expect(dialog.close).toHaveBeenCalledOnce();
  });

  it("does not offer manual completion while an engagement result is unconfirmed", () => {
    view.render({
      ...recommendation,
      discoveryPost: {
        createdAt: "2026-07-28T00:00:00Z",
        id: "post",
        neighborId: "neighbor",
        publishedAt: null,
        publisherBlogId: null,
        publisherName: "이웃",
        searchId: null,
        source: "neighbor",
        sourceUrl: recommendation.recommendation.sourceUrl,
        state: "opened",
        title: recommendation.recommendation.title,
        updatedAt: "2026-07-28T00:00:00Z",
      },
      engagementRun: {
        approvalId: "approval",
        createdAt: "2026-07-28T00:00:00Z",
        discoveryPostId: "post",
        id: "run",
        recommendationId: recommendation.recommendation.id,
        source: "neighbor",
        state: "unconfirmed",
        steps: [
          {
            name: "like",
            position: 0,
            resultCode: "unconfirmed",
            state: "unconfirmed",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          {
            name: "comment",
            position: 1,
            resultCode: null,
            state: "pending",
            updatedAt: "2026-07-28T00:00:00Z",
          },
        ],
        updatedAt: "2026-07-28T00:00:00Z",
      },
      kind: "approved",
      recommendation: { ...recommendation.recommendation, reviewStatus: "approved" },
    });

    expect((document.querySelector("#engagement-manual-button") as HTMLButtonElement).hidden).toBe(
      true,
    );
  });

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
        personalizationMode: "completed_examples",
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
        personalizationMode: "completed_examples",
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
        personalizationMode: "completed_examples",
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
        personalizationMode: "completed_examples",
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
        personalizationMode: "completed_examples",
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
        personalizationMode: "completed_examples",
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
    expect(document.querySelectorAll("button[data-use-candidate]")).toHaveLength(0);
  });

  it("uses candidate selection to open the edit flow without a direct page-input action", () => {
    const select = vi.fn();
    view.bind(actions({ select }));
    view.render({ kind: "review", ...recommendation });

    (document.querySelector<HTMLInputElement>("#candidate-2") as HTMLInputElement).click();

    expect(select).toHaveBeenCalledWith("2");
    expect(document.querySelectorAll("button[data-use-candidate]")).toHaveLength(0);
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

  it("guides a missing active tab back to the persistent Naver permission", () => {
    view.render({ failure: { code: "no_active_tab" }, kind: "error" });

    expect(document.querySelector("#error-message")?.textContent).toBe(
      "네이버 글 탭을 열고, 위의 ‘네이버 접근 허용’을 선택한 뒤 다시 시도해 주세요.",
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

  it("shows the one-post search engagement action and binds its request message", () => {
    const bound = actions();
    view.bind(bound);
    view.render({
      ...recommendation,
      discoveryPost: {
        createdAt: "2026-07-28T00:00:00Z",
        id: "00000000-0000-4000-8000-000000000090",
        neighborId: null,
        publishedAt: null,
        publisherBlogId: "candidate",
        publisherName: "합성 후보",
        searchId: "00000000-0000-4000-8000-000000000091",
        source: "search",
        sourceUrl: recommendation.recommendation.sourceUrl,
        state: "opened",
        title: recommendation.recommendation.title,
        updatedAt: "2026-07-28T00:00:00Z",
      },
      editedComment: "승인 댓글",
      kind: "approved",
      neighborMessage: "서로이웃으로 소통하고 싶어요.",
      recommendation: {
        ...recommendation.recommendation,
        editedComment: "승인 댓글",
        reviewStatus: "approved",
        selectedCandidateId: "1",
      },
      selectedCandidateId: "1",
    });

    const field = document.querySelector<HTMLTextAreaElement>("#neighbor-message");
    expect(document.querySelector("#engagement-run-panel")?.hasAttribute("hidden")).toBe(false);
    expect(field?.value).toContain("서로이웃");
    if (field === null) throw new Error("Synthetic neighbor message field missing");
    const EventConstructor = document.defaultView?.Event;
    if (EventConstructor === undefined) throw new Error("Synthetic Event constructor missing");
    field.focus();
    field.value = "사용자가 확인할 신청 메시지";
    field.dispatchEvent(new EventConstructor("input", { bubbles: true }));
    view.render({
      ...recommendation,
      discoveryPost: {
        createdAt: "2026-07-28T00:00:00Z",
        id: "00000000-0000-4000-8000-000000000090",
        neighborId: null,
        publishedAt: null,
        publisherBlogId: "candidate",
        publisherName: "합성 후보",
        searchId: "00000000-0000-4000-8000-000000000091",
        source: "search",
        sourceUrl: recommendation.recommendation.sourceUrl,
        state: "opened",
        title: recommendation.recommendation.title,
        updatedAt: "2026-07-28T00:00:00Z",
      },
      editedComment: "승인 댓글",
      kind: "approved",
      neighborMessage: "render가 덮어쓰면 안 되는 메시지",
      recommendation: {
        ...recommendation.recommendation,
        editedComment: "승인 댓글",
        reviewStatus: "approved",
        selectedCandidateId: "1",
      },
      selectedCandidateId: "1",
    });
    document.querySelector<HTMLButtonElement>("#engagement-run-button")?.click();

    expect(field.value).toBe("사용자가 확인할 신청 메시지");
    expect(bound.changeNeighborMessage).toHaveBeenCalledWith("사용자가 확인할 신청 메시지");
    expect(bound.engage).toHaveBeenCalledOnce();
    expect(document.querySelector("#engagement-step-results")?.textContent).toContain("서로이웃");
  });

  it("renders neighbor engagement progress and blocks completed or unconfirmed reruns", () => {
    const next = vi.fn();
    document.defaultView?.addEventListener("discovery-open-next", next);
    view.bind(actions());
    const neighborPost = {
      createdAt: "2026-07-28T00:00:00Z",
      id: "00000000-0000-4000-8000-000000000092",
      neighborId: "00000000-0000-4000-8000-000000000093",
      publishedAt: null,
      publisherBlogId: null,
      publisherName: "합성 이웃",
      searchId: null,
      source: "neighbor" as const,
      sourceUrl: recommendation.recommendation.sourceUrl,
      state: "opened" as const,
      title: recommendation.recommendation.title,
      updatedAt: "2026-07-28T00:00:00Z",
    };
    const run = {
      approvalId: "00000000-0000-4000-8000-000000000094",
      createdAt: "2026-07-28T00:00:00Z",
      discoveryPostId: neighborPost.id,
      id: "00000000-0000-4000-8000-000000000095",
      recommendationId: recommendation.recommendation.id,
      source: "neighbor" as const,
      state: "failed" as const,
      steps: [
        {
          name: "like" as const,
          position: 0,
          resultCode: "state_unknown",
          state: "failed" as const,
          updatedAt: "2026-07-28T00:00:01Z",
        },
        {
          name: "comment" as const,
          position: 1,
          resultCode: null,
          state: "pending" as const,
          updatedAt: "2026-07-28T00:00:00Z",
        },
      ],
      updatedAt: "2026-07-28T00:00:01Z",
    };
    const approved = {
      ...recommendation,
      discoveryPost: neighborPost,
      editedComment: "승인 댓글",
      engagementRun: run,
      recommendation: {
        ...recommendation.recommendation,
        editedComment: "승인 댓글",
        reviewStatus: "approved" as const,
        selectedCandidateId: "1",
      },
      selectedCandidateId: "1",
    };

    view.render({ ...approved, kind: "approved" });
    expect(document.querySelector("#neighbor-message-field")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("#engagement-run-button")?.textContent).toContain("승인 댓글");
    expect(document.querySelector<HTMLButtonElement>("#engagement-run-button")?.disabled).toBe(
      false,
    );
    expect(document.querySelector("#engagement-step-results")?.textContent).toContain("중단됨");
    expect(document.querySelector("#engagement-step-results li")?.getAttribute("data-state")).toBe(
      "failed",
    );

    view.render({ ...approved, kind: "engaging" });
    expect(document.querySelector<HTMLButtonElement>("#engagement-run-button")?.disabled).toBe(
      true,
    );
    expect(document.querySelector("#review-status")?.textContent).toContain("실행 중");

    view.render({
      ...approved,
      engagementRun: { ...run, state: "succeeded" },
      kind: "completed",
    });
    expect(document.querySelector<HTMLButtonElement>("#engagement-run-button")?.disabled).toBe(
      true,
    );
    expect(document.querySelector("#review-status")?.textContent).toBe("교류 완료");
    expect((document.querySelector("#completion-navigation") as HTMLElement).hidden).toBe(false);
    document.querySelector<HTMLButtonElement>("#next-post-button")?.click();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ detail: { source: "neighbor" } }));

    view.render({
      ...approved,
      engagementRun: { ...run, state: "unconfirmed" },
      kind: "approved",
    });
    expect(document.querySelector<HTMLButtonElement>("#engagement-run-button")?.disabled).toBe(
      true,
    );
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
        personalizationMode: "completed_examples",
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
