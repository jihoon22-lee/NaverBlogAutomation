import { describe, expect, it } from "vitest";

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
} from "../../src/app/state/writing";
import { renderWriting } from "../../src/app/views/writing";

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
  onCompose: () => undefined,
  onCreateDraft: () => undefined,
  onDeleteImage: () => undefined,
  onGenerateTags: () => undefined,
  onOpenDraft: () => undefined,
  onOptionChange: () => undefined,
  onRefine: () => undefined,
  onSaveBody: () => undefined,
  onSeedChange: () => undefined,
  onStage: () => undefined,
  onSyncCategories: () => undefined,
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

  it("renders the body, tags, and staging controls for a composed draft", () => {
    const state = withLoaded(withDraft(initialWritingState(), draft()), {
      categories: [{ categoryNo: 7, name: "전시 후기", postCount: 3, syncedAt: null }],
      drafts: [draft()],
      providers: [{ provider: "openai", configured: true, model: "gpt-test" }],
    });

    const root = render(state);

    expect((root.querySelector("#body-text") as HTMLTextAreaElement).value).toContain("첫 구역");
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

  it("lists the uploaded images with a remove control", () => {
    const root = render(withDraft(initialWritingState(), draft()));

    expect(root.querySelectorAll(".image-list li")).toHaveLength(1);
    expect(root.querySelector(".image-remove")?.getAttribute("data-image-id")).toBe(IMAGE_ID);
  });

  it("shows the failure message in the status line", () => {
    const root = render(withFailure(withDraft(initialWritingState(), draft()), "실패했습니다."));

    expect(root.querySelector("#writing-status")?.textContent).toBe("실패했습니다.");
  });
});
