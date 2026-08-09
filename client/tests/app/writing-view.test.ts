import { describe, expect, it, vi } from "vitest";

import type { BodyBlock, PostDraft } from "../../src/app/api/types";
import {
  draftLabel,
  hasPersistableBody,
  renderWriting,
  type BodyBlocksUpdater,
  type WritingHandlers,
} from "../../src/app/views/writing";
import {
  initialWritingState,
  withBlocks,
  withDraft,
  withLoaded,
} from "../../src/app/state/writing";

const IMAGE_ID = "22222222-2222-4222-8222-222222222222";

function draft(): PostDraft {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "합성 초안",
    categoryNo: null,
    status: "composed",
    useImageVision: false,
    seedText: "메모입니다.",
    revisions: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        roundNo: 1,
        kind: "composed",
        provider: "openai",
        model: "gpt-test",
        title: "합성 초안",
        summary: "",
        isActive: true,
        blocks: [
          { type: "paragraph", text: "첫 문단" },
          { type: "paragraph", text: "둘째 문단" },
          { type: "image", image_id: IMAGE_ID, caption: "사진" },
        ],
        createdAt: null,
      },
    ],
    images: [
      {
        id: IMAGE_ID,
        ordinal: 0,
        originalFilename: "photo.png",
        byteSize: 1024,
        mime: "image/png",
        altText: "",
      },
    ],
    tags: [{ tag: "기록", ordinal: 0, source: "user", selected: false }],
    createdAt: null,
    updatedAt: null,
  };
}

function handlers(overrides: Partial<WritingHandlers> = {}): WritingHandlers {
  return {
    onAddTags: vi.fn(),
    onCompose: vi.fn(),
    onCompleteWithAi: vi.fn(),
    onCreateDraft: vi.fn(),
    onDeleteDraft: vi.fn(),
    onDeleteImage: vi.fn(),
    onGenerateTags: vi.fn(),
    onOpenDraft: vi.fn(),
    onOptionChange: vi.fn(),
    onRefine: vi.fn(),
    onSeedChange: vi.fn(),
    onStage: vi.fn(),
    onSyncCategories: vi.fn(),
    onTitleChange: vi.fn(),
    onToggleTag: vi.fn(),
    onUploadImage: vi.fn(),
    ...overrides,
  };
}

function renderEditor(custom: Partial<WritingHandlers> = {}): HTMLElement {
  const root = document.createElement("main");
  document.body.replaceChildren(root);
  const state = withLoaded(withDraft(initialWritingState(), draft()), {
    categories: [],
    drafts: [draft()],
    providers: [{ provider: "openai", configured: true, model: "gpt-test" }],
  });
  renderWriting(root, state, handlers(custom));
  return root;
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing test element: ${selector}`);
  return element;
}

describe("writing view contracts", () => {
  it("applies consecutive block edits against the latest functional-update value", () => {
    let current: BodyBlock[] = [
      { type: "paragraph", text: "첫 문단" },
      { type: "paragraph", text: "둘째 문단" },
    ];
    const updates: BodyBlocksUpdater[] = [];
    const root = document.createElement("main");
    document.body.replaceChildren(root);
    const base = draft();
    const baseRevision = base.revisions.at(0);
    if (baseRevision === undefined) throw new Error("Missing test revision");
    const state = withDraft(initialWritingState(), {
      ...base,
      revisions: [{ ...baseRevision, blocks: current }],
    });
    renderWriting(
      root,
      { ...state, blocks: current },
      handlers({
        onBlocksChangeUpdate: (update) => {
          updates.push(update);
          current = update(current);
        },
      }),
    );

    const first = requiredElement<HTMLTextAreaElement>(root, '[data-block-index="0"] textarea');
    const second = requiredElement<HTMLTextAreaElement>(root, '[data-block-index="1"] textarea');
    first.value = "고친 첫 문단";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    second.value = "고친 둘째 문단";
    second.dispatchEvent(new Event("input", { bubbles: true }));

    expect(updates).toHaveLength(2);
    expect(current).toEqual([
      { type: "paragraph", text: "고친 첫 문단" },
      { type: "paragraph", text: "고친 둘째 문단" },
    ]);
  });

  it("uses the latest local canvas value for the legacy save fallback", () => {
    const onSaveBlocks = vi.fn();
    const root = renderEditor({ onSaveBlocks });
    const body = requiredElement<HTMLTextAreaElement>(root, '[data-block-index="0"] textarea');
    body.value = "저장할 최신 본문";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    (root.querySelector("#save-body-button") as HTMLButtonElement).click();

    expect(onSaveBlocks).toHaveBeenCalledWith([
      { type: "paragraph", text: "저장할 최신 본문" },
      { type: "paragraph", text: "둘째 문단" },
      { type: "image", image_id: IMAGE_ID, caption: "사진" },
    ]);
  });

  it("requires a version before AI can replace newly edited content", () => {
    const root = renderEditor();
    const compose = requiredElement<HTMLButtonElement>(root, "#compose-button");
    const checkpoint = requiredElement<HTMLButtonElement>(root, "#checkpoint-body-button");
    const body = requiredElement<HTMLTextAreaElement>(root, '[data-block-index="0"] textarea');
    expect(compose.disabled).toBe(false);
    expect(checkpoint.disabled).toBe(true);

    body.value = "아직 버전으로 남기지 않은 본문";
    body.dispatchEvent(new Event("input", { bubbles: true }));

    expect(compose.disabled).toBe(true);
    expect(checkpoint.disabled).toBe(false);
  });

  it("enables seed actions from local input without rerendering or losing focus", () => {
    const root = document.createElement("main");
    document.body.replaceChildren(root);
    const state = {
      ...initialWritingState(),
      providers: [{ provider: "openai" as const, configured: true, model: "gpt-test" }],
    };
    renderWriting(root, state, handlers());

    const title = requiredElement<HTMLInputElement>(root, "#seed-title");
    const memo = requiredElement<HTMLTextAreaElement>(root, "#seed-text");
    title.focus();
    title.value = " 새 제목 ";
    title.setSelectionRange(title.value.length, title.value.length);
    title.dispatchEvent(new Event("input", { bubbles: true }));
    expect((root.querySelector("#create-draft-button") as HTMLButtonElement).disabled).toBe(true);

    memo.value = " 짧은 메모 ";
    memo.dispatchEvent(new Event("input", { bubbles: true }));

    expect((root.querySelector("#create-draft-button") as HTMLButtonElement).disabled).toBe(false);
    expect((root.querySelector("#complete-draft-button") as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(document.activeElement).toBe(title);
    expect(title.maxLength).toBe(300);
    expect(memo.maxLength).toBe(20_000);
  });

  it("rejects transient empty blocks and keeps image out of retype choices", () => {
    expect(hasPersistableBody([{ type: "paragraph", text: " " }])).toBe(false);
    expect(hasPersistableBody([{ type: "unordered_list", items: [""] }])).toBe(false);
    expect(hasPersistableBody([{ type: "image", image_id: "", caption: "" }])).toBe(false);
    expect(hasPersistableBody([{ type: "paragraph", text: "본문" }])).toBe(true);

    const root = renderEditor();
    expect(
      [...root.querySelectorAll<HTMLSelectElement>('[data-block-index="0"] select option')].some(
        (option) => option.value === "image",
      ),
    ).toBe(false);
    expect(root.querySelectorAll('[id=""]')).toHaveLength(0);
    expect(requiredElement<HTMLButtonElement>(root, ".provider-choice").dataset.focusKey).toBe(
      "provider:openai",
    );
    expect(requiredElement<HTMLButtonElement>(root, ".option-choice").dataset.focusKey).toContain(
      "option:",
    );
    expect(requiredElement<HTMLButtonElement>(root, ".tag-choice").dataset.focusKey).toBe(
      "tag:기록",
    );
    expect(requiredElement<HTMLButtonElement>(root, ".revision-item").dataset.focusKey).toContain(
      "revision:",
    );
  });

  it("labels a recent draft with the working-copy title first", () => {
    const value = draft();
    value.workingCopy = {
      title: "최근 편집 제목",
      blocks: value.revisions.at(0)?.blocks ?? [],
      summary: "",
      contentVersion: 2,
    };

    expect(draftLabel(value)).toBe("최근 편집 제목 · 본문 준비");
  });

  it("disables busy category/revision controls and requires tag text before adding", () => {
    const startRoot = document.createElement("main");
    document.body.replaceChildren(startRoot);
    renderWriting(startRoot, { ...initialWritingState(), busy: true }, handlers());
    expect((startRoot.querySelector("#seed-category") as HTMLSelectElement).disabled).toBe(true);
    expect((startRoot.querySelector("#sync-categories-button") as HTMLButtonElement).disabled).toBe(
      true,
    );

    const busyEditor = document.createElement("main");
    document.body.replaceChildren(busyEditor);
    renderWriting(
      busyEditor,
      { ...withDraft(initialWritingState(), draft()), busy: true },
      handlers(),
    );
    expect((busyEditor.querySelector(".revision-item") as HTMLButtonElement).disabled).toBe(true);

    const editor = renderEditor();
    const add = requiredElement<HTMLButtonElement>(editor, "#add-tags-button");
    const input = requiredElement<HTMLInputElement>(editor, "#tag-input");
    expect(add.disabled).toBe(true);
    input.value = "메모";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(add.disabled).toBe(false);
  });

  it("disables draft-replacing tools until local content is checkpointed", () => {
    const root = document.createElement("main");
    document.body.replaceChildren(root);
    const base = withLoaded(withDraft(initialWritingState(), draft()), {
      categories: [],
      drafts: [draft()],
      providers: [{ provider: "openai", configured: true, model: "gpt-test" }],
    });
    const dirty = withBlocks(base, [{ type: "paragraph", text: "아직 버전으로 남기지 않은 본문" }]);
    renderWriting(root, dirty, handlers());

    expect((root.querySelector("#image-input") as HTMLInputElement).disabled).toBe(true);
    expect((root.querySelector(".image-remove") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector(".tag-choice") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector("#tag-input") as HTMLInputElement).disabled).toBe(true);
    expect((root.querySelector("#add-tags-button") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector(".revision-item") as HTMLButtonElement).disabled).toBe(true);
    expect(root.textContent).toContain("현재 편집 내용을 먼저 버전으로 남겨 주세요.");
  });

  it("updates protected tool controls immediately when the canvas becomes dirty", () => {
    const root = renderEditor();
    const body = requiredElement<HTMLTextAreaElement>(root, '[data-block-index="0"] textarea');

    body.value = "방금 입력한 본문";
    body.dispatchEvent(new Event("input", { bubbles: true }));

    expect((root.querySelector("#image-input") as HTMLInputElement).disabled).toBe(true);
    expect((root.querySelector(".tag-choice") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector(".revision-item") as HTMLButtonElement).disabled).toBe(true);
    expect(root.textContent).toContain("이미지·태그·변경 기록을 사용할 수 있습니다.");
  });

  it("exposes provider and writing options as radio groups", () => {
    const root = renderEditor();
    const providerGroup = requiredElement<HTMLElement>(root, ".provider-group");
    const provider = requiredElement<HTMLButtonElement>(root, ".provider-choice");
    const optionGroup = requiredElement<HTMLElement>(root, ".option-group");
    const option = requiredElement<HTMLButtonElement>(root, '.option-choice[aria-checked="true"]');

    expect(providerGroup.getAttribute("role")).toBe("radiogroup");
    expect(provider.getAttribute("role")).toBe("radio");
    expect(provider.getAttribute("aria-checked")).toBe("true");
    expect(optionGroup.getAttribute("role")).toBe("radiogroup");
    expect(option.getAttribute("role")).toBe("radio");
    expect(option.getAttribute("aria-checked")).toBe("true");
  });
});
