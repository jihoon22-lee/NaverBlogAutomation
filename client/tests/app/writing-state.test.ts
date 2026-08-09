import { describe, expect, it, vi } from "vitest";

import type { DraftRevision, PostDraft, PublishRun } from "../../src/app/api/types";
import {
  activeRevision,
  blocksFromText,
  canGenerate,
  canStage,
  hasUncheckpointedChanges,
  initialWritingState,
  needsCheckpoint,
  revisionText,
  selectedTags,
  withDraft,
  withAutoSaveAcknowledged,
  withAutoSaveFailure,
  withFailure,
  withLoaded,
  withOptions,
  withRun,
  withSeed,
  withStagingEvent,
  withStagingTerminal,
} from "../../src/app/state/writing";
import { draftLabel, renderWriting, wordDiff } from "../../src/app/views/writing";

const IMAGE_ID = "22222222-2222-4222-8222-222222222222";

function revision(overrides: Partial<DraftRevision> = {}): DraftRevision {
  return {
    id: "r1",
    roundNo: 1,
    kind: "composed",
    provider: "openai",
    model: "gpt-test",
    title: "생성된 제목",
    summary: "요약",
    isActive: true,
    blocks: [
      { type: "heading", text: "첫 구역" },
      { type: "paragraph", text: "문단입니다." },
      { type: "image", image_id: IMAGE_ID, caption: "사진" },
    ],
    createdAt: "2026-07-31T00:00:00Z",
    ...overrides,
  };
}

function draft(overrides: Partial<PostDraft> = {}): PostDraft {
  return {
    id: "d1",
    title: "합성 초안",
    categoryNo: 7,
    status: "composed",
    useImageVision: false,
    seedText: "메모입니다.",
    revisions: [revision()],
    images: [
      {
        id: IMAGE_ID,
        ordinal: 0,
        originalFilename: "a.png",
        byteSize: 2048,
        mime: "image/png",
        altText: "",
      },
    ],
    tags: [
      { tag: "전시", ordinal: 0, source: "generated", selected: true },
      { tag: "기록", ordinal: 1, source: "user", selected: false },
    ],
    createdAt: "2026-07-31T00:00:00Z",
    updatedAt: "2026-07-31T00:00:00Z",
    ...overrides,
  };
}

function run(overrides: Partial<PublishRun> = {}): PublishRun {
  return {
    id: "run1",
    draftId: "d1",
    revisionId: "r1",
    state: "running",
    resultCode: null,
    steps: (["title", "body", "images", "tags", "save"] as const).map((name, index) => ({
      name,
      position: index,
      state: index === 0 ? "succeeded" : "pending",
      resultCode: index === 0 ? "title_filled" : null,
      updatedAt: null,
    })),
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const HANDLERS = {
  onAddTags: () => undefined,
  onBodyChange: () => undefined,
  onCompose: () => undefined,
  onCompleteWithAi: () => undefined,
  onCreateDraft: () => undefined,
  onDeleteDraft: () => undefined,
  onDeleteImage: () => undefined,
  onGenerateTags: () => undefined,
  onOpenDraft: () => undefined,
  onOptionChange: () => undefined,
  onRefine: () => undefined,
  onSaveBody: () => undefined,
  onSeedChange: () => undefined,
  onStage: () => undefined,
  onSyncCategories: () => undefined,
  onTitleChange: () => undefined,
  onToggleTag: () => undefined,
  onUploadImage: () => undefined,
};

describe("writing state", () => {
  it("starts empty and moves to the seed step once loaded", () => {
    const loaded = withLoaded(initialWritingState(), {
      categories: [],
      drafts: [],
      providers: [{ provider: "gemini", configured: true, model: "gemini-test" }],
    });

    expect(loaded.phase).toBe("seed");
    expect(loaded.options.provider).toBe("gemini");
  });

  it("keeps the chosen provider when none is configured", () => {
    const loaded = withLoaded(initialWritingState(), {
      categories: [],
      drafts: [],
      providers: [{ provider: "openai", configured: false, model: "gpt" }],
    });

    expect(loaded.options.provider).toBe("openai");
    expect(canGenerate(loaded)).toBe(false);
  });

  it("derives the phase from the draft status", () => {
    const base = initialWritingState();

    expect(withDraft(base, draft({ status: "collecting", revisions: [] })).phase).toBe("seed");
    expect(withDraft(base, draft({ status: "tagged" })).phase).toBe("tagging");
    expect(withDraft(base, draft({ status: "staged" })).phase).toBe("staging");
    expect(withDraft(base, draft({ status: "refining" })).phase).toBe("review");
  });

  it("upserts the latest draft at the front without duplicating recent drafts", () => {
    const older = draft({ id: "older" });
    const current = draft({
      id: "current",
      workingCopy: {
        title: "기존 제목",
        blocks: revision().blocks,
        summary: revision().summary,
        contentVersion: 1,
      },
    });
    const state = { ...initialWritingState(), drafts: [current, older] };

    const next = withDraft(state, {
      ...current,
      workingCopy: {
        ...(current.workingCopy as NonNullable<PostDraft["workingCopy"]>),
        title: "최신 제목",
      },
    });

    expect(next.drafts.map((item) => item.id)).toEqual(["current", "older"]);
    expect(next.drafts[0]?.title).toBe("최신 제목");
  });

  it("normalizes visible title and body text to the working canvas", () => {
    const active = revision({
      title: "활성 제목",
      blocks: [{ type: "paragraph", text: "활성 본문" }],
    });
    const working = draft({
      title: "씨앗 제목",
      revisions: [active],
      workingCopy: {
        title: "편집 제목",
        blocks: [{ type: "paragraph", text: "편집 본문" }],
        summary: "편집 요약",
        contentVersion: 2,
      },
    });
    const state = withDraft(initialWritingState(), working);

    expect(state.draft?.title).toBe("편집 제목");
    expect(state.drafts[0]?.title).toBe("편집 제목");
    expect(state.bodyText).toBe("편집 본문");

    const revisionOnly = withDraft(initialWritingState(), {
      ...working,
      workingCopy: null,
    });
    expect(revisionOnly.draft?.title).toBe("활성 제목");
    expect(revisionOnly.bodyText).toBe("활성 본문");
  });

  it("keeps an autosave acknowledgement in the recent drafts list", () => {
    const current = withDraft(initialWritingState(), draft({ id: "current" }));
    const acknowledged = { ...(current.draft as PostDraft), updatedAt: "2026-08-01T00:00:00Z" };

    const next = withAutoSaveAcknowledged(current, acknowledged);

    expect(next.drafts[0]?.id).toBe("current");
    expect(next.drafts.filter((item) => item.id === "current")).toHaveLength(1);
  });

  it("acknowledges a title-only save without replacing transient canvas blocks", () => {
    const current = withDraft(initialWritingState(), draft({ revisions: [] }));
    const edited = {
      ...current,
      blocks: [{ type: "paragraph" as const, text: "임시 본문" }],
      bodyText: "임시 본문",
      draft: { ...(current.draft as PostDraft), title: "새 제목" },
    };
    const acknowledged = withAutoSaveAcknowledged(edited, {
      ...(current.draft as PostDraft),
      title: "새 제목",
      revisions: [],
    });

    expect(acknowledged.draft?.title).toBe("새 제목");
    expect(acknowledged.blocks).toEqual([{ type: "paragraph", text: "임시 본문" }]);
    expect(acknowledged.bodyText).toBe("임시 본문");
  });

  it("requires an explicit checkpoint when working copy and active revision differ", () => {
    const base = revision();
    const current = draft({
      revisions: [base],
      workingCopy: {
        title: "고친 제목",
        blocks: base.blocks,
        summary: base.summary,
        contentVersion: 2,
      },
    });
    const equal = draft({
      revisions: [base],
      workingCopy: {
        title: base.title,
        blocks: base.blocks,
        summary: base.summary,
        contentVersion: 2,
      },
    });

    expect(needsCheckpoint(withDraft(initialWritingState(), current))).toBe(true);
    expect(hasUncheckpointedChanges(withDraft(initialWritingState(), equal))).toBe(false);
    expect(needsCheckpoint(withDraft(initialWritingState(), draft()))).toBe(false);

    const local = withDraft(initialWritingState(), draft());
    expect(needsCheckpoint({ ...local, blocks: [{ type: "paragraph", text: "로컬 편집" }] })).toBe(
      true,
    );
  });

  it("prefers the active revision over the newest", () => {
    const state = withDraft(
      initialWritingState(),
      draft({
        revisions: [
          revision({ id: "r1", isActive: true }),
          revision({ id: "r2", roundNo: 2, isActive: false }),
        ],
      }),
    );

    expect(activeRevision(state)?.id).toBe("r1");
  });

  it("falls back to the newest revision without a selection", () => {
    const state = withDraft(
      initialWritingState(),
      draft({
        revisions: [
          revision({ id: "r1", isActive: false }),
          revision({ id: "r2", roundNo: 2, isActive: false }),
        ],
      }),
    );

    expect(activeRevision(state)?.id).toBe("r2");
  });

  it("renders the revision as editable text including captions", () => {
    expect(revisionText(revision())).toBe("첫 구역\n\n문단입니다.\n\n사진");
    expect(revisionText(null)).toBe("");
  });

  it("turns edited text into paragraphs and keeps image blocks", () => {
    const blocks = blocksFromText("첫 문단\n\n둘째 문단", revision());

    expect(blocks.filter((block) => block.type === "paragraph")).toHaveLength(2);
    expect(blocks.at(-1)).toEqual({ type: "image", image_id: IMAGE_ID, caption: "사진" });
  });

  it("keeps only image blocks when the text is empty", () => {
    expect(blocksFromText("   ", revision())).toEqual([
      { type: "image", image_id: IMAGE_ID, caption: "사진" },
    ]);
  });

  it("reports the selected tags", () => {
    expect(selectedTags(withDraft(initialWritingState(), draft()))).toEqual(["전시"]);
  });

  it("allows staging only with a body and no work in flight", () => {
    const ready = withDraft(initialWritingState(), draft());

    expect(canStage(ready)).toBe(true);
    expect(canStage({ ...ready, busy: true })).toBe(false);
    expect(canStage(withDraft(initialWritingState(), draft({ revisions: [] })))).toBe(false);
    expect(canStage(withRun(ready, run()))).toBe(false);
    expect(canStage(withRun(ready, run({ state: "succeeded" })))).toBe(true);
  });

  it("resolves terminal staging events to a bounded run state", () => {
    const base = withRun(withDraft(initialWritingState(), draft()), run());

    expect(withStagingTerminal(base, "run_finished", { state: "succeeded" }).run?.state).toBe(
      "succeeded",
    );
    expect(withStagingTerminal(base, "run_failed").run?.state).toBe("failed");
    expect(withStagingTerminal(base, "stream_deadline").run?.state).toBe("unconfirmed");
    expect(withStagingTerminal(base, "run_snapshot", { state: "failed" }).run?.state).toBe(
      "failed",
    );
    expect(withStagingTerminal(base, "stream_error").run?.state).toBe("unconfirmed");
    expect(withStagingTerminal(base, "run_finished").busy).toBe(false);
  });

  it("records a failure message", () => {
    const source = { ...initialWritingState(), autoSave: "saved" as const };
    const failed = withFailure(source, "실패했습니다.");

    expect(failed.phase).toBe("failed");
    expect(failed.error).toBe("실패했습니다.");
    expect(failed.autoSave).toBe("saved");
    expect(withAutoSaveFailure(source, "자동 저장 실패").autoSave).toBe("failed");
  });

  it("keeps seed and option edits", () => {
    let state = withSeed(initialWritingState(), { title: "제목", text: "내용", categoryNo: 7 });
    state = withOptions(state, { length: "long" });

    expect(state.seedTitle).toBe("제목");
    expect(state.seedText).toBe("내용");
    expect(state.selectedCategoryNo).toBe(7);
    expect(state.options.length).toBe("long");
  });

  it("marks added and removed words for revision review", () => {
    expect(wordDiff("첫 문단", "첫 고친 문단")).toEqual(
      expect.arrayContaining([
        { kind: "same", text: "첫" },
        { kind: "added", text: "고친" },
      ]),
    );
  });

  it("presents draft status as a readable Korean label", () => {
    expect(draftLabel(draft({ status: "staged" }))).toBe("생성된 제목 · 임시저장 완료");
  });
});

describe("writing view", () => {
  function render(state = initialWritingState()): HTMLElement {
    const root = document.createElement("main");
    document.body.textContent = "";
    document.body.append(root);
    renderWriting(root, state, HANDLERS);
    return root;
  }

  it("announces progress through a live region", () => {
    const status = render().querySelector("#writing-status");

    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("role")).toBe("status");
  });

  it("shows only the seed form before a draft exists", () => {
    const root = render();

    expect(root.querySelector("#seed-text")).not.toBeNull();
    expect(root.querySelector("#body-text")).toBeNull();
    expect(root.querySelector("#stage-button")).toBeNull();
  });

  it("uses a writing-first start layout with a clear AI primary action", () => {
    const root = render(
      withLoaded(withSeed(initialWritingState(), { title: "", text: "" }), {
        categories: [],
        drafts: [],
        providers: [{ provider: "openai", configured: false, model: "gpt-test" }],
      }),
    );

    expect(root.querySelector('.writing-shell[data-mode="start"]')).not.toBeNull();
    expect(root.querySelector(".writing-page-header h2")?.textContent).toBe("글쓰기");
    expect(root.querySelector(".writing-start-layout")).not.toBeNull();
    expect(root.querySelector(".writing-start-layout > .seed-panel")).not.toBeNull();
    expect(
      root.querySelector(".writing-start-layout > aside.writing-recent-drafts-sidebar"),
    ).not.toBeNull();
    expect(root.querySelector(".writing-start-layout > aside .draft-list-panel")).not.toBeNull();
    expect(root.querySelector(".writing-editor-layout")).toBeNull();
    expect(root.querySelector("#complete-draft-button")?.textContent).toBe("AI로 초안 완성");
    expect(root.querySelector("#create-draft-button")?.textContent).toBe("초안만 저장");
    const seedPanel = root.querySelector(".seed-panel") as Element;
    const complete = seedPanel.querySelector("#complete-draft-button") as Node;
    const create = seedPanel.querySelector("#create-draft-button") as Node;
    expect(
      complete.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(root.querySelector(".provider-missing-hint")?.textContent).toContain(
      "AI 연결이 설정되지 않아",
    );
    expect(root.querySelector(".writing-page-header #writing-status")).not.toBeNull();
    expect(root.querySelector(".writing-page-heading > #writing-title")).not.toBeNull();
  });

  it("switches to an editor layout, keeps core actions in the main column, and exposes new draft", () => {
    const onStartNew = vi.fn();
    const root = render(withDraft(initialWritingState(), draft()));
    renderWriting(root, withDraft(initialWritingState(), draft()), {
      ...HANDLERS,
      onStartNew,
    });

    const shell = root.querySelector('.writing-shell[data-mode="editor"]');
    expect(shell).not.toBeNull();
    expect(shell?.querySelector(".seed-panel")).toBeNull();
    expect(shell?.querySelector(".writing-editor-layout > .writing-editor-main")).not.toBeNull();
    expect(shell?.querySelector(".writing-editor-layout > .writing-editor-sidebar")).not.toBeNull();
    expect(shell?.querySelector(".writing-editor-main")?.tagName).toBe("SECTION");
    expect(shell?.querySelector(".writing-editor-main #draft-title")).not.toBeNull();
    expect(shell?.querySelector(".writing-editor-main .block-canvas")).not.toBeNull();
    expect(shell?.querySelector(".writing-editor-sidebar #refine-button")).not.toBeNull();
    expect(shell?.querySelector("#start-new-draft-button")).not.toBeNull();

    (shell?.querySelector("#start-new-draft-button") as HTMLButtonElement | null)?.click();
    expect(onStartNew).toHaveBeenCalledOnce();
  });

  it("keeps important phase panels open and preserves manual disclosure state", () => {
    const root = render(withDraft(initialWritingState(), draft()));

    expect((root.querySelector('[data-writing-panel="ai"]') as HTMLDetailsElement).open).toBe(
      false,
    );
    expect(
      (root.querySelector('[data-writing-panel="revisions"]') as HTMLDetailsElement).open,
    ).toBe(false);

    const images = root.querySelector('[data-writing-panel="images"]') as HTMLDetailsElement;
    images.open = true;
    renderWriting(
      root,
      { ...withDraft(initialWritingState(), draft()), notice: "저장됨" },
      HANDLERS,
    );
    expect((root.querySelector('[data-writing-panel="images"]') as HTMLDetailsElement).open).toBe(
      true,
    );
    expect(root.querySelectorAll("details[data-writing-panel]")).not.toHaveLength(0);
    expect(
      root.querySelector('[data-writing-panel="images"] summary')?.getAttribute("aria-controls"),
    ).toBe("writing-panel-images-content");

    const taggingRoot = render(withDraft(initialWritingState(), draft({ status: "tagged" })));
    expect(
      (taggingRoot.querySelector('[data-writing-panel="tags"]') as HTMLDetailsElement).open,
    ).toBe(true);
    expect(
      (taggingRoot.querySelector('[data-writing-panel="ai"]') as HTMLDetailsElement).open,
    ).toBe(false);

    const stagingRoot = render(withRun(withDraft(initialWritingState(), draft()), run()));
    expect(
      (stagingRoot.querySelector('[data-writing-panel="staging"]') as HTMLDetailsElement).open,
    ).toBe(true);
  });

  it("opens AI tools when an empty draft needs its first body", () => {
    const collecting = draft({ status: "collecting", revisions: [] });
    const root = render(withDraft(initialWritingState(), collecting));

    expect((root.querySelector('[data-writing-panel="ai"]') as HTMLDetailsElement).open).toBe(true);
  });

  it("guards an empty collecting editor from actions that need body content", () => {
    const collecting = draft({ status: "collecting", revisions: [] });
    const state = withLoaded(withDraft(initialWritingState(), collecting), {
      categories: [],
      drafts: [collecting],
      providers: [{ provider: "openai", configured: true, model: "gpt-test" }],
    });
    const root = render(state);

    expect(root.querySelector(".editor-empty-state")).not.toBeNull();
    expect((root.querySelector("#empty-editor-compose-button") as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((root.querySelector("#compose-button") as HTMLButtonElement).disabled).toBe(false);
    expect((root.querySelector("#save-body-button") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector("#checkpoint-body-button") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((root.querySelector("#refine-button") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector("#generate-tags-button") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector("#stage-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("locks mutable editor controls while a server action is running", () => {
    const root = render({ ...withDraft(initialWritingState(), draft()), busy: true });

    for (const selector of [
      "#draft-title",
      ".block-canvas textarea",
      ".block-tools select",
      ".block-tools button",
      ".image-insertion-point",
      ".block-insert button",
      "#image-input",
      ".image-insert",
      ".image-remove",
      ".tag-choice",
      "#tag-input",
      "#start-new-draft-button",
    ]) {
      expect((root.querySelector(selector) as HTMLButtonElement | HTMLInputElement).disabled).toBe(
        true,
      );
    }
    expect(root.querySelector(".block-canvas")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("explains an unavailable AI provider in the editor and keeps generation controls disabled", () => {
    const state = withLoaded(withDraft(initialWritingState(), draft()), {
      categories: [],
      drafts: [draft()],
      providers: [{ provider: "openai", configured: false, model: "gpt-test" }],
    });
    const root = render(state);

    expect(root.querySelectorAll(".provider-missing-hint")).toHaveLength(1);
    expect(root.querySelector(".provider-missing-hint")?.textContent).toContain(
      "연결 설정을 완료하면",
    );
    expect((root.querySelector("#compose-button") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector("#refine-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the editor accessible and preserves body-first mobile DOM order", () => {
    const root = render(withDraft(initialWritingState(), draft()));
    const shell = root.querySelector(".writing-shell") as HTMLElement;
    const heading = shell.querySelector("#writing-title");
    expect(heading?.tagName).toBe("H2");
    expect(shell.querySelectorAll("#writing-title")).toHaveLength(1);
    expect(shell.querySelector(".writing-page-actions > #writing-status")).not.toBeNull();
    expect(shell.querySelector(".writing-editor-layout")?.firstElementChild?.className).toBe(
      "writing-editor-main",
    );
    expect(shell.querySelector(".writing-editor-layout")?.lastElementChild?.className).toBe(
      "writing-editor-sidebar",
    );
    for (const button of Array.from(shell.querySelectorAll("button"))) {
      expect(button.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
    for (const tool of Array.from(shell.querySelectorAll(".block-tools button"))) {
      const button = tool as HTMLButtonElement;
      expect(button.getAttribute("aria-label")).toBeTruthy();
      expect(button.title).toBeTruthy();
    }
    for (const summary of Array.from(
      shell.querySelectorAll("details[data-writing-panel] > summary"),
    )) {
      expect(summary.tagName).toBe("SUMMARY");
      expect(summary.getAttribute("role")).toBeNull();
      expect(summary.getAttribute("aria-controls")).toBeTruthy();
    }
  });

  it("disables draft creation without a title", () => {
    const root = render(withSeed(initialWritingState(), { title: "  " }));

    expect((root.querySelector("#create-draft-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders a block canvas, tags, and staging controls for a composed draft", () => {
    const state = withLoaded(withDraft(initialWritingState(), draft()), {
      categories: [{ categoryNo: 7, name: "전시 후기", postCount: 3, syncedAt: null }],
      drafts: [draft()],
      providers: [{ provider: "openai", configured: true, model: "gpt-test" }],
    });

    const root = render(state);

    expect(root.querySelector("#body-text")).toBeNull();
    expect(root.querySelector(".block-canvas")).not.toBeNull();
    expect(
      (root.querySelector('[data-block-index="0"] textarea') as HTMLTextAreaElement).value,
    ).toBe("첫 구역");
    expect(root.querySelectorAll(".image-insertion-point")).toHaveLength(4);
    expect(root.querySelector(".editor-preview")).not.toBeNull();
    expect(root.querySelectorAll(".tag-choice")).toHaveLength(2);
    expect(root.querySelector('[data-tag="전시"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector('[data-tag="기록"]')?.getAttribute("aria-pressed")).toBe("false");
    expect((root.querySelector("#stage-button") as HTMLButtonElement).disabled).toBe(false);
    expect(root.querySelector(".staging-hint")?.textContent).toContain("발행은 에디터에서");
  });

  it("disables generation when no provider is configured", () => {
    const state = withLoaded(withDraft(initialWritingState(), draft()), {
      categories: [],
      drafts: [],
      providers: [{ provider: "openai", configured: false, model: "gpt" }],
    });

    const root = render(state);

    expect((root.querySelector("#compose-button") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector(".provider-choice") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the staging steps once a run exists", () => {
    const state = withRun(withDraft(initialWritingState(), draft()), run());

    const root = render(state);

    expect(root.querySelectorAll(".staging-steps li")).toHaveLength(5);
    expect(root.querySelector('[data-step="title"]')?.getAttribute("data-state")).toBe("succeeded");
    expect(root.querySelector('[data-step="title"]')?.textContent).toContain("title_filled");
  });

  it("shows requested and observed body progress with the Naver verification checklist", () => {
    const state = withStagingEvent(withRun(withDraft(initialWritingState(), draft()), run()), {
      step: "body",
      state: "succeeded",
      result_code: "blocks_staged_3",
      detail: {
        requested_range_start: 1,
        requested_range_end: 3,
        observed_prefix_count: 3,
      },
    });

    const root = render(state);

    expect(state.stagingBodyVerification).toEqual({
      requestedRange: { start: 1, end: 3 },
      observedPrefixCount: 3,
    });
    expect(root.querySelector('[data-step="body"]')?.textContent).toContain("blocks_staged_3");
    expect(
      root.querySelector('[data-testid="staging-verification-checklist"]')?.textContent,
    ).toContain("요청한 1~3번 블록 중 앞 3개를 순서대로 검증했습니다.");
    expect(
      root.querySelector('[data-testid="staging-verification-checklist"]')?.textContent,
    ).toContain("이미지와 캡션");
  });

  it("lists the uploaded images with a remove control", () => {
    const root = render(withDraft(initialWritingState(), draft()));

    expect(root.querySelectorAll(".image-list li")).toHaveLength(1);
    expect(root.querySelector(".image-remove")?.getAttribute("data-image-id")).toBe(IMAGE_ID);
  });

  it("shows the failure message in the status line", () => {
    const root = render(withFailure(withDraft(initialWritingState(), draft()), "실패했습니다."));

    expect(root.querySelector("#writing-status")?.textContent).toBe("실패했습니다.");
    expect(root.querySelector("#writing-status")?.getAttribute("data-state")).toBe("error");
  });

  it("wires every available editing action to an explicit handler", () => {
    const handlers = {
      ...HANDLERS,
      onAddTags: vi.fn(),
      onBlocksChange: vi.fn(),
      onBlocksStructureChange: vi.fn(),
      onCompose: vi.fn(),
      onCompleteWithAi: vi.fn(),
      onCreateDraft: vi.fn(),
      onDeleteDraft: vi.fn(),
      onDeleteImage: vi.fn(),
      onGenerateTags: vi.fn(),
      onOpenDraft: vi.fn(),
      onOptionChange: vi.fn(),
      onRefine: vi.fn(),
      onSaveBody: vi.fn(),
      onSeedChange: vi.fn(),
      onStage: vi.fn(),
      onSyncCategories: vi.fn(),
      onTitleChange: vi.fn(),
      onToggleTag: vi.fn(),
    };
    const state = withLoaded(
      withSeed(withDraft(initialWritingState(), draft()), { title: "새 제목", text: "메모" }),
      {
        categories: [{ categoryNo: 7, name: "전시 후기", postCount: 3, syncedAt: null }],
        drafts: [draft()],
        providers: [{ provider: "openai", configured: true, model: "gpt-test" }],
      },
    );
    const root = document.createElement("main");
    document.body.textContent = "";
    document.body.append(root);
    renderWriting(root, state, handlers);

    for (const selector of [
      ".draft-item",
      ".image-remove",
      ".provider-choice",
      '.option-choice[data-option="length"]',
      "#compose-button",
      "#save-body-button",
      "#refine-button",
      ".revision-item",
      "#generate-tags-button",
      ".tag-choice",
      "#add-tags-button",
      "#stage-button",
      "#delete-draft-button",
    ]) {
      (root.querySelector(selector) as HTMLButtonElement).click();
    }
    const body = root.querySelector<HTMLTextAreaElement>(
      '[data-block-index="0"] textarea',
    ) as HTMLTextAreaElement;
    body.value = "고친 본문";
    body.dispatchEvent(new Event("input"));
    const title = root.querySelector<HTMLInputElement>("#draft-title") as HTMLInputElement;
    title.value = "고친 제목";
    title.dispatchEvent(new Event("input"));
    const startRoot = document.createElement("main");
    document.body.append(startRoot);
    renderWriting(
      startRoot,
      withLoaded(withSeed(initialWritingState(), { title: "새 글", text: "메모" }), {
        categories: [],
        drafts: [],
        providers: [{ provider: "openai", configured: true, model: "gpt-test" }],
      }),
      handlers,
    );
    startRoot.querySelector("#sync-categories-button")?.dispatchEvent(new Event("click"));
    const seed = startRoot.querySelector<HTMLTextAreaElement>("#seed-text") as HTMLTextAreaElement;
    seed.value = "바꾼 메모";
    seed.dispatchEvent(new Event("input"));

    expect(handlers.onCompose).toHaveBeenCalledTimes(1);
    expect(handlers.onBlocksChange).toHaveBeenCalledWith([
      { type: "heading", text: "고친 본문" },
      { type: "paragraph", text: "문단입니다." },
      { type: "image", image_id: IMAGE_ID, caption: "사진" },
    ]);
    expect(handlers.onTitleChange).toHaveBeenCalledWith("고친 제목");
    expect(handlers.onStage).toHaveBeenCalledTimes(1);
    expect(handlers.onDeleteDraft).toHaveBeenCalledTimes(1);
  });

  it("keeps image insertion and structural block editing explicit", () => {
    const handlers = {
      ...HANDLERS,
      onBlocksStructureChange: vi.fn(),
      onImageInsertionPointChange: vi.fn(),
      onInsertImage: vi.fn(),
    };
    const root = render(withDraft(initialWritingState(), draft()));
    renderWriting(root, withDraft(initialWritingState(), draft()), handlers);

    (root.querySelector("#image-insert-at-1") as HTMLButtonElement).click();
    (root.querySelector(".image-insert") as HTMLButtonElement).click();
    (root.querySelector('[data-block-index="1"] .block-tools button') as HTMLButtonElement).click();
    const heading = root.querySelector<HTMLTextAreaElement>('[data-block-index="0"] textarea');
    heading?.dispatchEvent(
      new KeyboardEvent("keydown", { altKey: true, ctrlKey: true, key: "3", bubbles: true }),
    );

    expect(handlers.onImageInsertionPointChange).toHaveBeenCalledWith(1);
    expect(handlers.onInsertImage).toHaveBeenCalledWith(IMAGE_ID, 3);
    expect(handlers.onBlocksStructureChange).toHaveBeenCalledWith(
      expect.arrayContaining([{ type: "paragraph", text: "문단입니다." }]),
    );
    expect(handlers.onBlocksStructureChange).toHaveBeenCalledWith(
      expect.arrayContaining([{ type: "quote", text: "문단입니다." }]),
    );
  });

  it("inserts, duplicates, deletes, and drag-reorders blocks without flattening the canvas", () => {
    const handlers = { ...HANDLERS, onBlocksStructureChange: vi.fn() };
    const root = document.createElement("main");
    document.body.textContent = "";
    document.body.append(root);
    renderWriting(root, withDraft(initialWritingState(), draft()), handlers);

    const firstTools = root.querySelectorAll('[data-block-index="0"] .block-tools button');
    (firstTools[2] as HTMLButtonElement).click();
    (firstTools[3] as HTMLButtonElement).click();
    const appendDivider = [
      ...root.querySelectorAll<HTMLButtonElement>(".block-insert button"),
    ].find((item) => item.textContent === "+ 구분선");
    appendDivider?.click();

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { getData: () => "2" },
    });
    root.querySelector('[data-block-index="0"]')?.dispatchEvent(drop);

    expect(handlers.onBlocksStructureChange).toHaveBeenCalledWith([
      { type: "heading", text: "첫 구역" },
      { type: "heading", text: "첫 구역" },
      { type: "paragraph", text: "문단입니다." },
      { type: "image", image_id: IMAGE_ID, caption: "사진" },
    ]);
    expect(handlers.onBlocksStructureChange).toHaveBeenCalledWith([
      { type: "heading", text: "첫 구역" },
      { type: "paragraph", text: "문단입니다." },
      { type: "image", image_id: IMAGE_ID, caption: "사진" },
    ]);
    expect(handlers.onBlocksStructureChange).toHaveBeenCalledWith(
      expect.arrayContaining([{ type: "divider" }]),
    );
    expect(handlers.onBlocksStructureChange).toHaveBeenCalledWith([
      { type: "image", image_id: IMAGE_ID, caption: "사진" },
      { type: "heading", text: "첫 구역" },
      { type: "paragraph", text: "문단입니다." },
      { type: "divider" },
    ]);
  });
});
