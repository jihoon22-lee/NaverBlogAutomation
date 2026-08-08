import { describe, expect, it, vi } from "vitest";

import type { DraftRevision, PostDraft, PublishRun } from "../../src/app/api/types";
import {
  activeRevision,
  blocksFromText,
  canGenerate,
  canStage,
  initialWritingState,
  revisionText,
  selectedTags,
  withDraft,
  withFailure,
  withLoaded,
  withOptions,
  withRun,
  withSeed,
  withStagingEvent,
} from "../../src/app/state/writing";
import { renderWriting, wordDiff } from "../../src/app/views/writing";

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

function run(): PublishRun {
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
  });

  it("records a failure message", () => {
    const failed = withFailure(initialWritingState(), "실패했습니다.");

    expect(failed.phase).toBe("failed");
    expect(failed.error).toBe("실패했습니다.");
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
    ).toContain("요청한 1~3번 block 중 앞 3개를 순서대로 검증했습니다.");
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
      "#sync-categories-button",
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
    const seed = root.querySelector<HTMLTextAreaElement>("#seed-text") as HTMLTextAreaElement;
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
      expect.arrayContaining([{ type: "quote", text: "첫 구역" }]),
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
    ]);
  });
});
