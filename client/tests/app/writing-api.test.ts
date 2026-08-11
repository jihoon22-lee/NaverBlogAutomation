import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, LocalApiClient } from "../../src/app/api/client";
import type { RunStreamFactory, RunStreamHandlers } from "../../src/app/api/run-stream";
import type { PostDraft, PublishRun } from "../../src/app/api/types";
import { WritingController } from "../../src/app/controllers/writing";
import {
  canStage,
  initialWritingState,
  withDraft,
  withoutActiveDraft,
} from "../../src/app/state/writing";

const DRAFT_BODY = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "합성 초안",
  category_no: 7,
  status: "composed",
  use_image_vision: false,
  seed_text: "메모입니다.",
  revisions: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      round_no: 1,
      kind: "composed",
      provider: "openai",
      model: "gpt-test",
      title: "생성된 제목",
      summary: "요약",
      is_active: true,
      blocks: [{ type: "paragraph", text: "문단입니다." }],
      created_at: "2026-07-31T00:00:00Z",
    },
  ],
  images: [],
  tags: [{ tag: "전시", ordinal: 0, source: "generated", selected: true }],
  created_at: "2026-07-31T00:00:00Z",
  updated_at: "2026-07-31T00:00:00Z",
};

const RUN_BODY = {
  id: "33333333-3333-4333-8333-333333333333",
  draft_id: DRAFT_BODY.id,
  revision_id: DRAFT_BODY.revisions[0]?.id,
  state: "running",
  result_code: null,
  steps: ["title", "body", "images", "tags", "save"].map((name, index) => ({
    name,
    position: index,
    state: "pending",
    result_code: null,
    updated_at: null,
  })),
  created_at: null,
  updated_at: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class FakeStream {
  handlers: RunStreamHandlers | null = null;
  closes = 0;
  urls: string[] = [];
  subscriptions: RunStreamHandlers[] = [];

  readonly factory: RunStreamFactory = (url, handlers) => {
    this.urls.push(url);
    this.handlers = handlers;
    this.subscriptions.push(handlers);
    return {
      close: () => {
        this.closes += 1;
      },
    };
  };

  emit(event: string, payload: Record<string, unknown> = {}): void {
    this.handlers?.onEvent({ event, payload });
  }

  emitFrom(index: number, event: string, payload: Record<string, unknown> = {}): void {
    this.subscriptions[index]?.onEvent({ event, payload });
  }

  emitError(): void {
    this.handlers?.onError();
  }
}

function readDraft(): PostDraft {
  return {
    id: DRAFT_BODY.id,
    title: DRAFT_BODY.title,
    categoryNo: 7,
    status: "composed",
    useImageVision: false,
    seedText: DRAFT_BODY.seed_text,
    revisions: [
      {
        id: DRAFT_BODY.revisions[0]?.id as string,
        roundNo: 1,
        kind: "composed",
        provider: "openai",
        model: "gpt-test",
        title: "생성된 제목",
        summary: "요약",
        isActive: true,
        blocks: [{ type: "paragraph", text: "문단입니다." }],
        createdAt: "2026-07-31T00:00:00Z",
      },
    ],
    images: [],
    tags: [{ tag: "전시", ordinal: 0, source: "generated", selected: true }],
    createdAt: "2026-07-31T00:00:00Z",
    updatedAt: "2026-07-31T00:00:00Z",
  };
}

function readCollectingDraft(id = DRAFT_BODY.id): PostDraft {
  return {
    ...readDraft(),
    id,
    title: "수집 초안",
    status: "collecting",
    revisions: [],
    workingCopy: null,
  };
}

function readDraftWithEditorTools(): PostDraft {
  const draft = readDraft();
  const active = draft.revisions[0];
  return {
    ...draft,
    images: [
      {
        id: "image-1",
        ordinal: 0,
        originalFilename: "photo.png",
        byteSize: 2_048,
        mime: "image/png",
        altText: "전시 사진",
      },
    ],
    revisions:
      active === undefined
        ? draft.revisions
        : [
            active,
            {
              ...active,
              id: "33333333-3333-4333-8333-333333333333",
              roundNo: 2,
              title: "두 번째 제목",
              isActive: false,
              blocks: [{ type: "paragraph", text: "두 번째 본문" }],
            },
          ],
    tags: [...draft.tags, { tag: "여행", ordinal: 1, source: "user", selected: false }],
  };
}

function api(overrides: Record<string, unknown> = {}) {
  return {
    blogCategories: vi.fn(async () => []),
    checkpointDraft: vi.fn(async () => readDraft()),
    composeDraft: vi.fn(async () => readDraft()),
    createDraft: vi.fn(async () => readDraft()),
    deleteDraftImage: vi.fn(async () => readDraft()),
    draft: vi.fn(async () => readDraft()),
    drafts: vi.fn(async () => [readDraft()]),
    generateDraftTags: vi.fn(async () => readDraft()),
    llmProviders: vi.fn(async () => [
      { provider: "openai" as const, configured: true, model: "gpt-test" },
    ]),
    patchDraft: vi.fn(async () => readDraft()),
    patchDraftTags: vi.fn(async () => readDraft()),
    refineDraft: vi.fn(async () => readDraft()),
    saveDraftBody: vi.fn(async () => readDraft()),
    stageDraft: vi.fn(async () => RUN_AS_DOMAIN),
    stagingEventsUrl: (id: string) => `/api/v1/drafts/${id}/stage/events`,
    syncBlogCategories: vi.fn(async () => [
      { categoryNo: 7, name: "전시 후기", postCount: 3, syncedAt: null },
    ]),
    uploadDraftImage: vi.fn(async () => readDraft()),
    ...overrides,
  } as never;
}

const RUN_AS_DOMAIN: PublishRun = {
  id: RUN_BODY.id,
  draftId: RUN_BODY.draft_id,
  revisionId: RUN_BODY.revision_id as string,
  state: "running",
  resultCode: null,
  steps: RUN_BODY.steps.map((step) => ({
    name: step.name as PublishRun["steps"][number]["name"],
    position: step.position,
    state: "pending",
    resultCode: null,
    updatedAt: null,
  })),
  createdAt: null,
  updatedAt: null,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("draft transport", () => {
  it("creates a draft with snake_case fields", async () => {
    const handler = vi.fn(async () => jsonResponse(DRAFT_BODY, 201));
    const client = new LocalApiClient({ fetch: handler as never });

    const created = await client.createDraft({
      title: "합성 초안",
      seedText: "메모입니다.",
      categoryNo: 7,
    });

    expect(created.status).toBe("composed");
    const call = handler.mock.calls[0] as unknown[];
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      title: "합성 초안",
      seed_text: "메모입니다.",
      category_no: 7,
    });
  });

  it("sends only the generation options that were set", async () => {
    const handler = vi.fn(async () => jsonResponse(DRAFT_BODY));
    const client = new LocalApiClient({ fetch: handler as never });

    await client.composeDraft(DRAFT_BODY.id, { provider: "gemini", length: "long" });

    const call = handler.mock.calls[0] as unknown[];
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      provider: "gemini",
      length: "long",
    });
  });

  it("uploads an image as multipart", async () => {
    const handler = vi.fn(async () => jsonResponse(DRAFT_BODY, 201));
    const client = new LocalApiClient({ fetch: handler as never });
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });

    await client.uploadDraftImage(DRAFT_BODY.id, file, "설명");

    const call = handler.mock.calls[0] as unknown[];
    expect((call[1] as RequestInit).body).toBeInstanceOf(FormData);
  });

  it("reads a staging run", async () => {
    const client = new LocalApiClient({
      fetch: vi.fn(async () => jsonResponse(RUN_BODY, 202)) as never,
    });

    const run = await client.stageDraft(DRAFT_BODY.id);

    expect(run.steps).toHaveLength(5);
    expect(run.state).toBe("running");
  });

  it("builds the documented stream path", () => {
    const client = new LocalApiClient({ fetch: vi.fn() as never });

    expect(client.stagingEventsUrl("d1")).toBe("/api/v1/drafts/d1/stage/events");
  });

  it.each([
    ["status", { ...DRAFT_BODY, status: "unknown" }],
    ["revision kind", { ...DRAFT_BODY, revisions: [{ ...DRAFT_BODY.revisions[0], kind: "x" }] }],
    [
      "block type",
      {
        ...DRAFT_BODY,
        revisions: [{ ...DRAFT_BODY.revisions[0], blocks: [{ type: "table" }] }],
      },
    ],
    ["tag source", { ...DRAFT_BODY, tags: [{ ...DRAFT_BODY.tags[0], source: "robot" }] }],
    ["collections", { ...DRAFT_BODY, images: null }],
  ])("rejects a draft whose %s violates the contract", async (_field, body) => {
    const client = new LocalApiClient({ fetch: vi.fn(async () => jsonResponse(body)) as never });

    await expect(client.draft(DRAFT_BODY.id)).rejects.toThrow(/계약/u);
  });

  it("rejects a run with the wrong number of steps", async () => {
    const client = new LocalApiClient({
      fetch: vi.fn(async () => jsonResponse({ ...RUN_BODY, steps: [] })) as never,
    });

    await expect(client.stageDraft(DRAFT_BODY.id)).rejects.toThrow(/계약/u);
  });
});

describe("WritingController", () => {
  let root: HTMLElement;
  let stream: FakeStream;

  beforeEach(() => {
    document.body.textContent = "";
    root = document.createElement("main");
    document.body.append(root);
    stream = new FakeStream();
  });

  function controller(overrides: Record<string, unknown> = {}): WritingController {
    return new WritingController(root, { api: api(overrides), stream: stream.factory });
  }

  it("closes only the active draft while preserving writing defaults and context", () => {
    const draft = readDraft();
    const state = {
      ...initialWritingState(),
      autoSave: "saved" as const,
      blocks: [{ type: "paragraph" as const, text: "편집 중" }],
      bodyText: "편집 중",
      categories: [{ categoryNo: 7, name: "전시 후기", postCount: 3, syncedAt: null }],
      draft,
      drafts: [draft],
      providers: [{ provider: "openai" as const, configured: true, model: "gpt-test" }],
      seedTitle: "다음 글 제목",
      seedText: "다음 글 메모",
      selectedCategoryNo: 7,
      notice: null,
    };

    const next = withoutActiveDraft(state);

    expect(next.draft).toBeNull();
    expect(next.blocks).toEqual([]);
    expect(next.bodyText).toBe("");
    expect(next.drafts).toEqual([draft]);
    expect(next.providers).toBe(state.providers);
    expect(next.categories).toBe(state.categories);
    expect(next.seedTitle).toBe("");
    expect(next.seedText).toBe("");
    expect(next.selectedCategoryNo).toBe(7);
    expect(next.notice).toBe("새 글 작성을 시작합니다.");
    expect(state.draft).toBe(draft);
  });

  it("loads providers, categories, and drafts", async () => {
    const writing = controller();

    await writing.load();

    expect(writing.state.phase).toBe("seed");
    expect(writing.state.drafts).toHaveLength(1);
    expect(writing.state.options.provider).toBe("openai");
  });

  it("applies only valid writing-profile settings from the optional app setting", async () => {
    const writing = controller({
      appSetting: vi.fn(async () => ({
        payload: {
          reference_post_count: 6,
          target_length: "long",
          tone: "calm",
          structure: "story",
          use_image_vision: true,
          // A future server value must not silently widen the client option union.
          unknown_option: "ignore-me",
        },
      })),
    });

    await writing.load();

    expect(writing.state.referenceLimit).toBe(6);
    expect(writing.state.options).toMatchObject({
      length: "long",
      tone: "calm",
      structure: "story",
    });
    expect(writing.state.useImageVision).toBe(true);
  });

  it("keeps a newer load when an older selected-draft request fails", async () => {
    const draftA = readDraft();
    const draftB = {
      ...draftA,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "B 초안",
      revisions: draftA.revisions.map((revision) => ({ ...revision, title: "B 제목" })),
    };
    let rejectA: (error: Error) => void = () => {
      throw new Error("first load did not start");
    };
    const first = new Promise<PostDraft>((_resolve, reject) => {
      rejectA = reject;
    });
    const client = api({
      draft: vi.fn((id: string) => (id === draftA.id ? first : Promise.resolve(draftB))),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });

    const firstLoad = writing.load({ draftId: draftA.id });
    const secondLoad = writing.load({ draftId: draftB.id });
    await secondLoad;
    rejectA(new Error("old response failed"));
    await firstLoad;

    expect(writing.state.draft?.id).toBe(draftB.id);
    expect(writing.state.phase).not.toBe("failed");
  });

  it("does not let a late open response replace a draft loaded by navigation", async () => {
    const draftA = readDraft();
    const draftB = {
      ...draftA,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "B 초안",
      revisions: draftA.revisions.map((revision) => ({ ...revision, title: "B 제목" })),
    };
    let finishOpen: (draft: PostDraft) => void = () => {
      throw new Error("open response did not start");
    };
    const client = api({
      draft: vi.fn((id: string) =>
        id === draftA.id
          ? new Promise<PostDraft>((resolve) => {
              finishOpen = resolve;
            })
          : Promise.resolve(draftB),
      ),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    const opening = writing.openDraft(draftA.id);
    await writing.load({ draftId: draftB.id });
    finishOpen(draftA);
    await opening;

    expect(writing.state.draft?.id).toBe(draftB.id);
    expect(writing.state.draft?.title).toBe("B 제목");
  });

  it("applies only the newest concurrent load response", async () => {
    const draftA = readDraft();
    const draftB = {
      ...draftA,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "B 초안",
      workingCopy: {
        title: "B 초안",
        blocks: [{ type: "paragraph" as const, text: "B 본문" }],
        summary: "",
        contentVersion: 1,
      },
    };
    const loadA = deferred<PostDraft>();
    const loadB = deferred<PostDraft>();
    const client = api({
      draft: vi.fn((id: string) => (id === draftA.id ? loadA.promise : loadB.promise)),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });

    const first = writing.load({ draftId: draftA.id });
    const second = writing.load({ draftId: draftB.id });
    loadB.resolve(draftB);
    await second;

    expect(writing.state.draft?.id).toBe(draftB.id);
    loadA.resolve(draftA);
    await first;

    expect(writing.state.draft?.id).toBe(draftB.id);
    expect(writing.state.draft?.title).toBe(draftB.title);
  });

  it("keeps state updates while inactive without rendering another view", async () => {
    let active = false;
    const writing = new WritingController(root, {
      api: api(),
      isActive: () => active,
      stream: stream.factory,
    });

    await writing.openDraft(DRAFT_BODY.id);

    expect(writing.state.draft?.id).toBe(DRAFT_BODY.id);
    expect(root.textContent).toBe("");
    active = true;
    writing.render();
    expect(root.querySelector(".writing-shell")).not.toBeNull();
  });

  it("refuses to create a draft without a title", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });

    expect(await writing.createDraft()).toBeNull();
    expect(
      (client as unknown as { createDraft: { mock: { calls: unknown[] } } }).createDraft.mock.calls,
    ).toHaveLength(0);
  });

  it("refuses to create a draft with whitespace-only seed text", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    writing.setSeed("title", "제목");
    writing.setSeed("text", "   ");

    expect(await writing.createDraft()).toBeNull();
    expect(
      (client as unknown as { createDraft: { mock: { calls: unknown[] } } }).createDraft.mock.calls,
    ).toHaveLength(0);
  });

  it("creates a draft from the seed fields", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    writing.setSeed("title", "합성 초안");
    writing.setSeed("text", "메모입니다.");
    writing.setSeed("category", "7");

    await writing.createDraft();

    expect(
      (client as unknown as { createDraft: { mock: { calls: unknown[][] } } }).createDraft.mock
        .calls[0],
    ).toEqual([
      { title: "합성 초안", seedText: "메모입니다.", categoryNo: 7, useImageVision: false },
    ]);
  });

  it("completes a seed with one explicit create-and-compose action", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    writing.setSeed("title", "합성 초안");
    writing.setSeed("text", "메모입니다.");

    await writing.completeWithAi();

    expect(
      (client as unknown as { createDraft: { mock: { calls: unknown[][] } } }).createDraft.mock
        .calls,
    ).toHaveLength(1);
    expect(
      (client as unknown as { composeDraft: { mock: { calls: unknown[][] } } }).composeDraft.mock
        .calls,
    ).toHaveLength(1);
  });

  it("clears the category when the empty option is chosen", async () => {
    const writing = controller();
    writing.setSeed("category", "7");
    writing.setSeed("category", "");

    expect(writing.state.selectedCategoryNo).toBeNull();
  });

  it("composes with the chosen options", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.load();
    await writing.openDraft(DRAFT_BODY.id);
    writing.setOption("length", "long");
    writing.setOption("tone", "calm");

    await writing.compose();

    expect(
      (client as unknown as { composeDraft: { mock: { calls: unknown[][] } } }).composeDraft.mock
        .calls[0]?.[1],
    ).toMatchObject({ provider: "openai", length: "long", tone: "calm" });
  });

  it("blocks AI compose while the working copy has uncheckpointed edits", async () => {
    const current = {
      ...readDraft(),
      workingCopy: {
        title: "편집 중 제목",
        blocks: [{ type: "paragraph" as const, text: "편집 중 본문" }],
        summary: "요약",
        contentVersion: 3,
      },
    };
    const composeDraft = vi.fn(async () => readDraft());
    const client = api({ draft: vi.fn(async () => current), composeDraft });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    expect(await writing.compose()).toBeNull();
    expect(composeDraft).not.toHaveBeenCalled();
    expect(writing.state.notice).toBe("먼저 현재 편집 내용을 버전으로 남겨 주세요.");
  });

  it("does not compose without a draft", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });

    expect(await writing.compose()).toBeNull();
  });

  it("starts a new seed without deleting the previous draft", async () => {
    const client = api({ deleteDraft: vi.fn(async () => undefined) });
    const onDraftClosed = vi.fn();
    const writing = new WritingController(root, {
      api: client,
      onDraftClosed,
      stream: stream.factory,
    });
    await writing.load();
    await writing.openDraft(DRAFT_BODY.id);
    writing.setSeed("title", "새 글 제목");
    writing.setSeed("text", "새 글 메모");
    writing.setSeed("category", "7");

    await expect(writing.startNew()).resolves.toBe(true);

    expect(writing.state.draft).toBeNull();
    expect(writing.state.drafts).toHaveLength(1);
    expect(writing.state.seedTitle).toBe("");
    expect(writing.state.seedText).toBe("");
    expect(writing.state.selectedCategoryNo).toBe(7);
    expect(root.querySelector(".seed-panel")).not.toBeNull();
    expect(onDraftClosed).toHaveBeenCalledOnce();
    expect(
      (client as unknown as { deleteDraft: { mock: { calls: unknown[][] } } }).deleteDraft.mock
        .calls,
    ).toHaveLength(0);
  });

  it("refuses to start a new draft when there is no active draft or an uncheckpointed transient edit", async () => {
    const writing = controller();
    await expect(writing.startNew()).resolves.toBe(false);

    await writing.openDraft(DRAFT_BODY.id);
    writing.onBlocksChange([{ type: "paragraph", text: "   " }]);

    await expect(writing.startNew()).resolves.toBe(false);
    expect(writing.state.notice).toBe("제목과 본문을 먼저 유효하게 저장한 뒤 새 글을 시작하세요.");
  });

  it("does not switch drafts while an automatic save is still in flight", async () => {
    vi.useFakeTimers();
    let finishSave: (draft: PostDraft) => void = () => {
      throw new Error("autosave did not start");
    };
    const saveDraftBody = vi.fn(
      () =>
        new Promise<PostDraft>((resolve) => {
          finishSave = resolve;
        }),
    );
    const client = api({ saveDraftBody });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onBlocksChange([{ type: "paragraph", text: "저장 중 본문" }]);
    await vi.advanceTimersByTimeAsync(700);

    const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await expect(writing.openDraft(otherId)).resolves.toBeNull();
    expect(writing.state.draft?.id).toBe(DRAFT_BODY.id);
    expect(writing.state.notice).toBe("자동 저장이 끝난 뒤 다른 초안을 열 수 있습니다.");

    finishSave(readDraft());
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it("refuses a new draft while an autosave is scheduled", async () => {
    vi.useFakeTimers();
    const writing = controller();
    await writing.openDraft(DRAFT_BODY.id);
    writing.onBlocksChange([{ type: "paragraph", text: "아직 저장하지 않은 편집" }]);

    await expect(writing.startNew()).resolves.toBe(false);

    expect(writing.state.draft?.id).toBe(DRAFT_BODY.id);
    expect(writing.state.notice).toBe("자동 저장이 끝난 뒤 새 글을 시작할 수 있습니다.");
    await vi.advanceTimersByTimeAsync(700);
    vi.useRealTimers();
  });

  it("refuses a new draft while an autosave request is in flight", async () => {
    vi.useFakeTimers();
    let finishSave: (draft: PostDraft) => void = () => {
      throw new Error("autosave did not start");
    };
    const client = api({
      saveDraftBody: vi.fn(
        () =>
          new Promise<PostDraft>((resolve) => {
            finishSave = resolve;
          }),
      ),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onBlocksChange([{ type: "paragraph", text: "저장 중 편집" }]);
    await vi.advanceTimersByTimeAsync(700);

    await expect(writing.startNew()).resolves.toBe(false);
    expect(writing.state.draft?.id).toBe(DRAFT_BODY.id);
    expect(writing.state.notice).toBe("자동 저장이 끝난 뒤 새 글을 시작할 수 있습니다.");

    finishSave(readDraft());
    await vi.advanceTimersByTimeAsync(0);
    await expect(writing.startNew()).resolves.toBe(true);
    expect(writing.state.draft).toBeNull();
    vi.useRealTimers();
  });

  it("refuses a new draft after an autosave failure until the edit is saved", async () => {
    vi.useFakeTimers();
    const client = api({
      saveDraftBody: vi.fn(async () => {
        throw new Error("save failed");
      }),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onBlocksChange([{ type: "paragraph", text: "저장 실패 편집" }]);
    await vi.advanceTimersByTimeAsync(700);

    expect(writing.state.autoSave).toBe("failed");
    await expect(writing.startNew()).resolves.toBe(false);
    expect(writing.state.draft?.id).toBe(DRAFT_BODY.id);
    expect(writing.state.notice).toBe("자동 저장에 실패한 변경 내용을 먼저 저장하세요.");
    vi.useRealTimers();
  });

  it("does not send invalid transient edits until a valid body and title return", async () => {
    vi.useFakeTimers();
    const saveDraftBody = vi.fn(async () => readDraft());
    const client = api({ saveDraftBody });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    writing.onBlocksChange([{ type: "paragraph", text: "   " }]);
    await vi.advanceTimersByTimeAsync(700);
    expect(saveDraftBody).not.toHaveBeenCalled();

    writing.onBlocksChange([{ type: "paragraph", text: "유효한 본문" }]);
    writing.onTitleChange("   ");
    await vi.advanceTimersByTimeAsync(700);
    expect(saveDraftBody).not.toHaveBeenCalled();

    writing.onTitleChange("유효한 제목");
    await vi.advanceTimersByTimeAsync(700);
    expect(saveDraftBody).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("flushes draft A before switching to draft B", async () => {
    vi.useFakeTimers();
    const draftA = readDraft();
    const draftB = { ...draftA, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "B 초안" };
    const draft = vi.fn(async (id: string) => (id === draftA.id ? draftA : draftB));
    const saveDraftBody = vi.fn(
      async (
        id: string,
        payload: {
          title: string;
          blocks: PostDraft["revisions"][number]["blocks"];
          summary?: string;
        },
      ) => ({
        ...(id === draftA.id ? draftA : draftB),
        title: payload.title,
        workingCopy: {
          title: payload.title,
          blocks: payload.blocks,
          summary: payload.summary ?? "",
          contentVersion: 2,
        },
      }),
    );
    const client = api({ draft, saveDraftBody });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(draftA.id);
    writing.onBlocksChange([{ type: "paragraph", text: "A 최신 본문" }]);

    await expect(writing.openDraft(draftB.id)).resolves.toMatchObject({ id: draftB.id });

    expect(saveDraftBody).toHaveBeenCalledWith(
      draftA.id,
      expect.objectContaining({ blocks: [{ type: "paragraph", text: "A 최신 본문" }] }),
    );
    expect(draft.mock.calls.map((call) => call[0])).toEqual([draftA.id, draftB.id]);
    expect(writing.state.draft?.id).toBe(draftB.id);
    vi.useRealTimers();
  });

  it("requires an active revision when deciding whether a working copy can be staged", () => {
    const workingCopyOnly = {
      ...readDraft(),
      revisions: [],
      workingCopy: {
        title: "작업 중 제목",
        blocks: [{ type: "paragraph" as const, text: "작업 중 본문" }],
        summary: "",
        contentVersion: 1,
      },
    };
    const state = withDraft(initialWritingState(), workingCopyOnly);

    expect(state.blocks).toHaveLength(1);
    expect(canStage(state)).toBe(false);
  });

  it("flushes a scheduled title edit before checkpointing and cancels its timer", async () => {
    vi.useFakeTimers();
    const saveDraftBody = vi.fn(async () => readDraft());
    const checkpointDraft = vi.fn(async () => readDraft());
    const client = api({ saveDraftBody, checkpointDraft });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onTitleChange("최신 제목");

    await expect(writing.checkpoint()).resolves.not.toBeNull();
    expect(saveDraftBody).toHaveBeenCalledOnce();
    expect((saveDraftBody.mock.calls as unknown[][])[0]?.[1]).toMatchObject({
      title: "최신 제목",
      summary: "요약",
    });
    expect(checkpointDraft).toHaveBeenCalledOnce();
    expect(saveDraftBody.mock.invocationCallOrder[0]).toBeLessThan(
      checkpointDraft.mock.invocationCallOrder[0] as number,
    );
    await vi.advanceTimersByTimeAsync(700);
    expect(saveDraftBody).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("flushes scheduled body edits before staging and preserves call order", async () => {
    vi.useFakeTimers();
    const saveDraftBody = vi.fn(async () => readDraft());
    const stageDraft = vi.fn(async () => RUN_AS_DOMAIN);
    const client = api({ saveDraftBody, stageDraft });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onBlocksChange([{ type: "paragraph", text: "최신 본문" }]);

    await expect(writing.stage()).resolves.toMatchObject({ id: RUN_BODY.id });
    expect(saveDraftBody).toHaveBeenCalledOnce();
    expect((saveDraftBody.mock.calls as unknown[][])[0]?.[1]).toMatchObject({
      blocks: [{ type: "paragraph", text: "최신 본문" }],
      summary: "요약",
    });
    expect(stageDraft).toHaveBeenCalledOnce();
    expect(saveDraftBody.mock.invocationCallOrder[0]).toBeLessThan(
      stageDraft.mock.invocationCallOrder[0] as number,
    );
    await vi.advanceTimersByTimeAsync(700);
    expect(saveDraftBody).toHaveBeenCalledOnce();
    expect((saveDraftBody.mock.calls as unknown[][])[0]?.[1]).toMatchObject({ summary: "요약" });
    vi.useRealTimers();
  });

  it("does not skip the freshness PUT when a saved draft has no working copy", async () => {
    const saveDraftBody = vi.fn(async () => readDraft());
    const checkpointDraft = vi.fn(async () => readDraft());
    const client = api({ saveDraftBody, checkpointDraft });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    await writing.checkpoint();

    expect(saveDraftBody).toHaveBeenCalledOnce();
    expect((saveDraftBody.mock.calls as unknown[][])[0]?.[1]).toMatchObject({
      baseContentVersion: 0,
      summary: "요약",
    });
    expect(checkpointDraft).toHaveBeenCalledOnce();
  });

  it("skips an unnecessary body PUT when a saved working copy is current", async () => {
    const current = {
      ...readDraft(),
      workingCopy: {
        title: "합성 초안",
        blocks: [{ type: "paragraph" as const, text: "문단입니다." }],
        summary: "",
        contentVersion: 3,
      },
    };
    const saveDraftBody = vi.fn(async () => current);
    const checkpointDraft = vi.fn(async () => current);
    const client = api({
      draft: vi.fn(async () => current),
      saveDraftBody,
      checkpointDraft,
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    await writing.checkpoint();

    expect(saveDraftBody).not.toHaveBeenCalled();
    expect(checkpointDraft).toHaveBeenCalledOnce();
  });

  it("does not call checkpoint or stage when the freshness save fails", async () => {
    const saveDraftBody = vi.fn(async () => {
      throw new Error("save failed");
    });
    const checkpointDraft = vi.fn(async () => readDraft());
    const stageDraft = vi.fn(async () => RUN_AS_DOMAIN);
    const client = api({ saveDraftBody, checkpointDraft, stageDraft });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onBlocksChange([{ type: "paragraph", text: "저장 실패 본문" }]);

    await expect(writing.checkpoint()).resolves.toBeNull();
    await expect(writing.stage()).resolves.toBeNull();

    expect(saveDraftBody).toHaveBeenCalledTimes(2);
    expect(checkpointDraft).not.toHaveBeenCalled();
    expect(stageDraft).not.toHaveBeenCalled();
  });

  it("reports a title validation error for an explicit save", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onTitleChange("   ");

    expect(await writing.saveBlocks(writing.state.blocks)).toBeNull();
    expect(writing.state.error).toBe("제목을 입력하세요.");
    expect(writing.state.notice).toBe("제목을 입력한 뒤 저장하세요.");
    expect(
      (client as unknown as { saveDraftBody: { mock: { calls: unknown[] } } }).saveDraftBody.mock
        .calls,
    ).toHaveLength(0);
  });

  it("does not apply a body autosave response after a navigation load changes drafts", async () => {
    vi.useFakeTimers();
    let finishSave: (draft: PostDraft) => void = () => {
      throw new Error("autosave did not start");
    };
    const draftB = {
      ...readDraft(),
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "B 초안",
    };
    const saveDraftBody = vi.fn(
      () =>
        new Promise<PostDraft>((resolve) => {
          finishSave = resolve;
        }),
    );
    const client = api({
      saveDraftBody,
      drafts: vi.fn(async () => [draftB]),
      draft: vi.fn(async (id: string) => (id === draftB.id ? draftB : readDraft())),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onBlocksChange([{ type: "paragraph", text: "A 로컬 본문" }]);
    await vi.advanceTimersByTimeAsync(700);

    const loading = writing.load({ draftId: draftB.id });
    await loading;
    expect(writing.state.draft?.id).toBe(draftB.id);

    finishSave(readDraft());
    await vi.advanceTimersByTimeAsync(0);

    expect(writing.state.draft?.id).toBe(draftB.id);
    expect(writing.state.blocks).toEqual(draftB.revisions[0]?.blocks ?? []);
    vi.useRealTimers();
  });

  it("blocks checkpoint, stage, and manual save while autosave is in flight", async () => {
    vi.useFakeTimers();
    let finishSave: (draft: PostDraft) => void = () => {
      throw new Error("autosave did not start");
    };
    const saveDraftBody = vi.fn(
      () =>
        new Promise<PostDraft>((resolve) => {
          finishSave = resolve;
        }),
    );
    const checkpointDraft = vi.fn(async () => readDraft());
    const stageDraft = vi.fn(async () => RUN_AS_DOMAIN);
    const client = api({ saveDraftBody, checkpointDraft, stageDraft });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onBlocksChange([{ type: "paragraph", text: "자동 저장 중 본문" }]);
    await vi.advanceTimersByTimeAsync(700);

    await expect(writing.checkpoint()).resolves.toBeNull();
    await expect(writing.stage()).resolves.toBeNull();
    await expect(writing.saveBlocks(writing.state.blocks)).resolves.toBeNull();

    expect(saveDraftBody).toHaveBeenCalledOnce();
    expect(checkpointDraft).not.toHaveBeenCalled();
    expect(stageDraft).not.toHaveBeenCalled();
    expect(writing.state.notice).toBe("자동 저장이 끝난 뒤 본문을 저장할 수 있습니다.");

    finishSave(readDraft());
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it("ignores local edits while generation is busy", async () => {
    let finishCompose: (draft: PostDraft) => void = () => {
      throw new Error("compose did not start");
    };
    const client = api({
      composeDraft: vi.fn(
        () =>
          new Promise<PostDraft>((resolve) => {
            finishCompose = resolve;
          }),
      ),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    const originalBlocks = writing.state.blocks;
    const composing = writing.compose();

    writing.onBlocksChange([{ type: "paragraph", text: "덮어쓰면 안 되는 편집" }]);
    writing.onTitleChange("덮어쓰면 안 되는 제목");
    writing.onBlocksStructureChange([{ type: "heading", text: "구조 편집" }]);
    writing.insertImage("image-id");

    expect(writing.state.busy).toBe(true);
    expect(writing.state.blocks).toEqual(originalBlocks);
    expect(writing.state.draft?.title).toBe("생성된 제목");
    expect(writing.state.notice).toBe("현재 작업이 끝난 뒤 본문을 편집할 수 있습니다.");

    finishCompose(readDraft());
    await composing;
  });

  it("restores focus after block and option renders", async () => {
    const writing = controller();
    await writing.openDraft(DRAFT_BODY.id);

    const body = root.querySelector<HTMLTextAreaElement>('[data-block-index="0"] textarea');
    expect(body).not.toBeNull();
    body?.focus();
    writing.onBlocksStructureChange(writing.state.blocks);
    expect(document.activeElement).toBe(root.querySelector('[data-block-index="0"] textarea'));

    const option = root.querySelector<HTMLButtonElement>(
      '[data-option="length"][data-value="medium"]',
    );
    expect(option).not.toBeNull();
    option?.focus();
    writing.setOption("length", "long");
    expect(document.activeElement).toBe(
      root.querySelector('[data-option="length"][data-value="medium"]'),
    );
  });

  it("clamps the next image insertion point to the current canvas", async () => {
    const writing = controller();
    await writing.openDraft(DRAFT_BODY.id);

    writing.setImageInsertionPoint(-10);
    expect(writing.state.imageInsertAt).toBe(0);
    writing.setImageInsertionPoint(100);
    expect(writing.state.imageInsertAt).toBe(writing.state.blocks.length);
  });

  it("keeps image blocks when saving edited text", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    await writing.saveBody("고친 문단");

    const call = (client as unknown as { saveDraftBody: { mock: { calls: unknown[][] } } })
      .saveDraftBody.mock.calls[0];
    expect(call?.[1]).toMatchObject({
      title: "생성된 제목",
      blocks: [{ type: "paragraph", text: "고친 문단" }],
    });
  });

  it("debounces body edits into an automatic save", async () => {
    vi.useFakeTimers();
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    writing.onBodyChange("자동 저장할 문단");
    await vi.advanceTimersByTimeAsync(700);

    expect(
      (client as unknown as { saveDraftBody: { mock: { calls: unknown[][] } } }).saveDraftBody.mock
        .calls[0]?.[1],
    ).toMatchObject({ blocks: [{ type: "paragraph", text: "자동 저장할 문단" }] });
    vi.useRealTimers();
  });

  it("autosaves a title-only edit for an empty collecting draft", async () => {
    vi.useFakeTimers();
    const collecting = readCollectingDraft();
    const patchDraft = vi.fn(async (_id: string, patch: { title?: string }) => ({
      ...collecting,
      title: patch.title ?? collecting.title,
    }));
    const client = api({
      draft: vi.fn(async () => collecting),
      patchDraft,
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(collecting.id);

    writing.onTitleChange("새 제목");
    await vi.advanceTimersByTimeAsync(700);

    expect(patchDraft).toHaveBeenCalledWith(collecting.id, { title: "새 제목" });
    expect(writing.state.draft?.title).toBe("새 제목");
    expect(writing.state.blocks).toEqual([]);
    vi.useRealTimers();
  });

  it("does not patch a title-only draft while the title is blank", async () => {
    vi.useFakeTimers();
    const collecting = readCollectingDraft();
    const patchDraft = vi.fn(async () => collecting);
    const client = api({
      draft: vi.fn(async () => collecting),
      patchDraft,
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(collecting.id);

    writing.onTitleChange("   ");
    await vi.advanceTimersByTimeAsync(700);

    expect(patchDraft).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("flushes a title-only timer before switching drafts", async () => {
    vi.useFakeTimers();
    const draftA = readCollectingDraft();
    const draftB = readCollectingDraft("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const draft = vi.fn(async (id: string) => (id === draftA.id ? draftA : draftB));
    const patchDraft = vi.fn(async (id: string, patch: { title?: string }) => ({
      ...(id === draftA.id ? draftA : draftB),
      title: patch.title ?? (id === draftA.id ? draftA.title : draftB.title),
    }));
    const client = api({ draft, patchDraft });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(draftA.id);
    writing.onTitleChange("A 새 제목");

    await expect(writing.openDraft(draftB.id)).resolves.toMatchObject({ id: draftB.id });

    expect(patchDraft).toHaveBeenCalledWith(draftA.id, { title: "A 새 제목" });
    expect(patchDraft.mock.invocationCallOrder[0]).toBeLessThan(
      draft.mock.invocationCallOrder[1] as number,
    );
    expect(writing.state.draft?.id).toBe(draftB.id);
    vi.useRealTimers();
  });

  it("ignores a late title response from draft A after draft B is loaded", async () => {
    vi.useFakeTimers();
    const draftA = readCollectingDraft();
    const draftB = readCollectingDraft("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    let finishPatch: (draft: PostDraft) => void = () => {
      throw new Error("title patch did not start");
    };
    const patchDraft = vi.fn(
      () =>
        new Promise<PostDraft>((resolve) => {
          finishPatch = resolve;
        }),
    );
    const client = api({
      draft: vi.fn(async (id: string) => (id === draftA.id ? draftA : draftB)),
      patchDraft,
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(draftA.id);
    writing.onTitleChange("A 새 제목");
    await vi.advanceTimersByTimeAsync(700);

    await writing.load({ draftId: draftB.id });
    finishPatch({ ...draftA, title: "A 늦은 응답" });
    await vi.advanceTimersByTimeAsync(0);

    expect(writing.state.draft?.id).toBe(draftB.id);
    expect(writing.state.draft?.title).toBe(draftB.title);
    vi.useRealTimers();
  });

  it("includes a changed title in the next automatic body save", async () => {
    vi.useFakeTimers();
    const current = {
      ...readDraft(),
      workingCopy: {
        title: "기존 working copy 제목",
        blocks: [{ type: "paragraph" as const, text: "문단입니다." }],
        summary: "",
        contentVersion: 4,
      },
    };
    const client = api({ draft: vi.fn(async () => current) });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    writing.onTitleChange("고친 제목");
    await vi.advanceTimersByTimeAsync(700);

    expect(
      (client as unknown as { saveDraftBody: { mock: { calls: unknown[][] } } }).saveDraftBody.mock
        .calls[0]?.[1],
    ).toMatchObject({ title: "고친 제목", baseContentVersion: 4, summary: "" });
    vi.useRealTimers();
  });

  it("keeps only the newest edit when an autosave is already in flight", async () => {
    vi.useFakeTimers();
    let finishFirstSave: (draft: PostDraft) => void = () => {
      throw new Error("autosave did not start");
    };
    const current = {
      ...readDraft(),
      workingCopy: {
        title: "생성된 제목",
        blocks: [{ type: "paragraph" as const, text: "문단입니다." }],
        summary: "",
        contentVersion: 4,
      },
    };
    const saved = {
      ...current,
      workingCopy: {
        ...current.workingCopy,
        blocks: [{ type: "paragraph" as const, text: "첫 편집" }],
        contentVersion: 5,
      },
    };
    const client = api({
      draft: vi.fn(async () => current),
      saveDraftBody: vi.fn(
        () =>
          new Promise<PostDraft>((resolve) => {
            finishFirstSave = resolve;
          }),
      ),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    writing.onBlocksChange([{ type: "paragraph", text: "첫 편집" }]);
    await vi.advanceTimersByTimeAsync(700);
    writing.onBlocksChange([{ type: "paragraph", text: "마지막 편집" }]);
    await vi.advanceTimersByTimeAsync(700);
    finishFirstSave(saved);
    await vi.advanceTimersByTimeAsync(0);

    const calls = (client as unknown as { saveDraftBody: { mock: { calls: unknown[][] } } })
      .saveDraftBody.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]).toMatchObject({
      blocks: [{ type: "paragraph", text: "마지막 편집" }],
      baseContentVersion: 5,
    });
    vi.useRealTimers();
  });

  it("keeps the local canvas after a content conflict and retries from the fresh base", async () => {
    vi.useFakeTimers();
    let rejectFirstSave: (error: Error) => void = () => {
      throw new Error("autosave did not start");
    };
    const current = {
      ...readDraft(),
      workingCopy: {
        title: "다른 기기의 제목",
        blocks: [{ type: "paragraph" as const, text: "다른 기기의 최신 본문" }],
        summary: "",
        contentVersion: 8,
      },
    };
    const conflict = new ApiError("충돌", {
      problem: {
        code: "draft_content_conflict",
        detail: "다른 기기에서 변경했습니다.",
        status: 409,
        title: "Draft content conflict",
      },
      status: 409,
    });
    const saveDraftBody = vi
      .fn(
        async (
          _id: string,
          _payload: { title: string; blocks: PostDraft["revisions"][number]["blocks"] },
        ) =>
          new Promise<PostDraft>((_resolve, reject) => {
            rejectFirstSave = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<PostDraft>((_resolve, reject) => {
            rejectFirstSave = reject;
          }),
      )
      .mockImplementation(
        async (
          _id: string,
          payload: { title: string; blocks: PostDraft["revisions"][number]["blocks"] },
        ) => ({
          ...current,
          workingCopy: {
            ...current.workingCopy,
            title: payload.title,
            blocks: payload.blocks,
            contentVersion: 9,
          },
        }),
      );
    const client = api({
      draft: vi.fn(async () => current),
      saveDraftBody,
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    writing.onBlocksChange([{ type: "paragraph", text: "첫 편집" }]);
    await vi.advanceTimersByTimeAsync(700);
    writing.onBlocksChange([{ type: "paragraph", text: "충돌 뒤 대기 중인 편집" }]);
    await vi.advanceTimersByTimeAsync(700);
    rejectFirstSave(conflict);
    await vi.advanceTimersByTimeAsync(0);

    const typed = client as unknown as {
      draft: { mock: { calls: unknown[][] } };
      saveDraftBody: { mock: { calls: unknown[][] } };
    };
    expect(typed.saveDraftBody.mock.calls).toHaveLength(1);
    expect(typed.draft.mock.calls).toHaveLength(2);
    expect(writing.state.blocks).toEqual([{ type: "paragraph", text: "충돌 뒤 대기 중인 편집" }]);
    expect(writing.state.autoSave).toBe("failed");
    expect(writing.state.error).toBe(
      "다른 기기의 최신 본문을 불러왔습니다. 변경 내용은 덮어쓰지 않았습니다.",
    );
    expect(writing.state.notice).toBe(
      "다른 기기 저장과 충돌했습니다. 현재 편집 내용을 유지했습니다. 다시 저장하세요.",
    );

    writing.onBlocksChange([{ type: "paragraph", text: "명시적으로 다시 저장할 편집" }]);
    await vi.advanceTimersByTimeAsync(700);
    expect(typed.saveDraftBody.mock.calls).toHaveLength(2);
    expect(typed.saveDraftBody.mock.calls[1]?.[1]).toMatchObject({
      baseContentVersion: 8,
      blocks: [{ type: "paragraph", text: "명시적으로 다시 저장할 편집" }],
    });
    vi.useRealTimers();
  });

  it("keeps the edit visible when the conflict metadata refresh also fails", async () => {
    vi.useFakeTimers();
    let rejectSave: (error: Error) => void = () => {
      throw new Error("autosave did not start");
    };
    const conflict = new ApiError("충돌", {
      problem: {
        code: "draft_content_conflict",
        detail: "다른 기기에서 변경했습니다.",
        status: 409,
        title: "Draft content conflict",
      },
      status: 409,
    });
    const current = readDraft();
    const draft = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockRejectedValueOnce(new Error("refresh offline"));
    const saveDraftBody = vi.fn(
      () =>
        new Promise<PostDraft>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const client = api({ draft, saveDraftBody });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onBlocksChange([{ type: "paragraph", text: "충돌 뒤에도 남겨야 할 본문" }]);
    await vi.advanceTimersByTimeAsync(700);
    rejectSave(conflict);
    await vi.advanceTimersByTimeAsync(0);

    expect(writing.state.blocks).toEqual([
      { type: "paragraph", text: "충돌 뒤에도 남겨야 할 본문" },
    ]);
    expect(writing.state.autoSave).toBe("failed");
    expect(writing.state.notice).toContain("충돌했습니다");
    expect(writing.state.error).toBe("알 수 없는 오류가 발생했습니다.");
    vi.useRealTimers();
  });

  it("requires a second explicit press before deleting the open draft", async () => {
    const client = api({ deleteDraft: vi.fn(async () => undefined) });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    await writing.deleteDraft();
    expect(
      (client as unknown as { deleteDraft: { mock: { calls: unknown[][] } } }).deleteDraft.mock
        .calls,
    ).toHaveLength(0);
    await writing.deleteDraft();

    expect(
      (client as unknown as { deleteDraft: { mock: { calls: unknown[][] } } }).deleteDraft.mock
        .calls,
    ).toEqual([[DRAFT_BODY.id]]);
    expect(writing.state.draft).toBeNull();
  });

  it("does not delete while an automatic save is in flight", async () => {
    vi.useFakeTimers();
    let finishSave: (draft: PostDraft) => void = () => {
      throw new Error("autosave did not start");
    };
    const client = api({
      saveDraftBody: vi.fn(
        () =>
          new Promise<PostDraft>((resolve) => {
            finishSave = resolve;
          }),
      ),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onBlocksChange([{ type: "paragraph", text: "저장 중 본문" }]);
    await vi.advanceTimersByTimeAsync(700);

    await writing.deleteDraft();

    expect(writing.state.notice).toBe("자동 저장이 끝난 뒤 초안을 삭제할 수 있습니다.");
    expect(writing.state.deleteConfirmation).toBe(false);
    finishSave(readDraft());
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it("reports a failed draft deletion without discarding the local draft", async () => {
    const client = api({
      deleteDraft: vi.fn(async () => {
        throw new Error("delete failed");
      }),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    await writing.deleteDraft();
    await writing.deleteDraft();

    expect(writing.state.draft?.id).toBe(DRAFT_BODY.id);
    expect(writing.state.phase).toBe("failed");
    expect(writing.state.error).toBe("알 수 없는 오류가 발생했습니다.");
  });

  it("refuses to save an empty body", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    expect(await writing.saveBody("   ")).toBeNull();
    expect(writing.state.error).toBe("저장할 본문이 없습니다.");
  });

  it("rejects checkpointing when the active draft has no persistable body", async () => {
    const collecting = readCollectingDraft();
    const client = api({ draft: vi.fn(async () => collecting) });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(collecting.id);

    expect(await writing.checkpoint()).toBeNull();
    expect(writing.state.error).toBe("저장할 본문이 없습니다.");
    expect(
      (client as unknown as { checkpointDraft: { mock: { calls: unknown[] } } }).checkpointDraft
        .mock.calls,
    ).toHaveLength(0);
  });

  it("toggles one tag without touching the others", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    await writing.toggleTag("전시");

    expect(
      (client as unknown as { patchDraftTags: { mock: { calls: unknown[][] } } }).patchDraftTags
        .mock.calls[0]?.[1],
    ).toEqual({ selected: [] });
  });

  it("selects an unselected tag while retaining the already selected tags", async () => {
    const tagged = {
      ...readDraft(),
      tags: [
        { tag: "전시", ordinal: 0, source: "generated" as const, selected: true },
        { tag: "기록", ordinal: 1, source: "user" as const, selected: false },
      ],
    };
    const client = api({ draft: vi.fn(async () => tagged) });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    await writing.toggleTag("기록");

    expect(
      (client as unknown as { patchDraftTags: { mock: { calls: unknown[][] } } }).patchDraftTags
        .mock.calls,
    ).toContainEqual([DRAFT_BODY.id, { selected: ["전시", "기록"] }]);
  });

  it("adds typed tags", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    await writing.addTags(["기록", "메모"]);

    expect(
      (client as unknown as { patchDraftTags: { mock: { calls: unknown[][] } } }).patchDraftTags
        .mock.calls[0]?.[1],
    ).toEqual({ added: ["기록", "메모"] });
  });

  it("blocks draft-replacing actions while local content is waiting for autosave and a checkpoint", async () => {
    vi.useFakeTimers();
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onTitleChange("로컬 제목");
    writing.onBlocksChange([{ type: "paragraph", text: "로컬 본문" }]);

    await expect(writing.selectRevision(DRAFT_BODY.revisions[0]?.id as string)).resolves.toBeNull();
    await expect(writing.toggleTag("전시")).resolves.toBeNull();
    await expect(writing.addTags(["기록"])).resolves.toBeNull();
    await expect(
      writing.uploadImage(new File(["image"], "photo.png", { type: "image/png" })),
    ).resolves.toBeNull();
    await expect(writing.deleteImage("image-id")).resolves.toBeNull();

    const typed = client as unknown as {
      patchDraft: { mock: { calls: unknown[] } };
      patchDraftTags: { mock: { calls: unknown[] } };
      uploadDraftImage: { mock: { calls: unknown[] } };
      deleteDraftImage: { mock: { calls: unknown[] } };
    };
    expect(typed.patchDraft.mock.calls).toHaveLength(0);
    expect(typed.patchDraftTags.mock.calls).toHaveLength(0);
    expect(typed.uploadDraftImage.mock.calls).toHaveLength(0);
    expect(typed.deleteDraftImage.mock.calls).toHaveLength(0);
    expect(writing.state.draft?.title).toBe("로컬 제목");
    expect(writing.state.blocks).toEqual([{ type: "paragraph", text: "로컬 본문" }]);
    expect(writing.state.notice).toBe("자동 저장이 끝난 뒤 현재 편집 내용을 버전으로 남겨 주세요.");

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps draft-replacing actions blocked after autosave until the local copy is checkpointed", async () => {
    vi.useFakeTimers();
    const localBlocks = [{ type: "paragraph" as const, text: "저장된 로컬 본문" }];
    const saveDraftBody = vi.fn(async () => ({
      ...readDraft(),
      title: "저장된 로컬 제목",
      workingCopy: {
        title: "저장된 로컬 제목",
        blocks: localBlocks,
        summary: "요약",
        contentVersion: 2,
      },
    }));
    const client = api({ saveDraftBody });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onTitleChange("저장된 로컬 제목");
    writing.onBlocksChange(localBlocks);
    await vi.advanceTimersByTimeAsync(700);

    expect(writing.state.autoSave).toBe("saved");
    expect(await writing.toggleTag("전시")).toBeNull();
    expect(
      (client as unknown as { patchDraftTags: { mock: { calls: unknown[] } } }).patchDraftTags.mock
        .calls,
    ).toHaveLength(0);
    expect(writing.state.notice).toBe("현재 편집 내용을 먼저 버전으로 남겨 주세요.");

    vi.useRealTimers();
  });

  it("requires a valid title before protected draft actions", async () => {
    const collecting = readCollectingDraft();
    const client = api({ draft: vi.fn(async () => collecting) });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(collecting.id);
    writing.onTitleChange("   ");

    expect(await writing.toggleTag("전시")).toBeNull();
    expect(writing.state.notice).toBe("제목을 입력한 뒤 저장하고 버전으로 남겨 주세요.");
    expect(
      (client as unknown as { patchDraftTags: { mock: { calls: unknown[] } } }).patchDraftTags.mock
        .calls,
    ).toHaveLength(0);
  });

  it("stages the draft and subscribes to its stream", async () => {
    const writing = controller();
    await writing.openDraft(DRAFT_BODY.id);

    const run = await writing.stage();

    expect(run?.id).toBe(RUN_BODY.id);
    expect(writing.state.phase).toBe("staging");
    expect(stream.urls).toEqual([`/api/v1/drafts/${DRAFT_BODY.id}/stage/events`]);
  });

  it("refuses staging when the canvas has no active revision", async () => {
    const collecting = {
      ...readCollectingDraft(),
      workingCopy: {
        title: "작업 제목",
        blocks: [{ type: "paragraph" as const, text: "작업 본문" }],
        summary: "",
        contentVersion: 1,
      },
    };
    const client = api({ draft: vi.fn(async () => collecting) });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(collecting.id);

    expect(await writing.stage()).toBeNull();
    expect(writing.state.notice).toBe("먼저 본문을 생성하거나 저장하세요.");
    expect(
      (client as unknown as { stageDraft: { mock: { calls: unknown[] } } }).stageDraft.mock.calls,
    ).toHaveLength(0);
  });

  it("does not start a second staging run while the current run is active", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    await writing.stage();

    expect(await writing.stage()).toBeNull();
    expect(
      (client as unknown as { stageDraft: { mock: { calls: unknown[] } } }).stageDraft.mock.calls,
    ).toHaveLength(1);
    expect(writing.state.notice).toBe("현재 임시저장이 진행 중입니다.");
  });

  it("closes the stream and refreshes on a terminal event", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    await writing.stage();

    stream.emit("run_finished");
    await Promise.resolve();
    await Promise.resolve();

    expect(stream.closes).toBe(1);
    expect(writing.state.run?.state).toBe("succeeded");
    expect(
      (client as unknown as { draft: { mock: { calls: unknown[] } } }).draft.mock.calls.length,
    ).toBeGreaterThan(1);
  });

  it("surfaces a terminal refresh failure instead of leaving the run busy", async () => {
    const draft = vi
      .fn()
      .mockResolvedValueOnce(readDraft())
      .mockRejectedValueOnce(new Error("refresh offline"));
    const client = api({ draft });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    await writing.stage();

    stream.emit("run_finished");
    await vi.waitFor(() => expect(writing.state.phase).toBe("failed"));

    expect(writing.state.busy).toBe(false);
    expect(writing.state.error).toBe("알 수 없는 오류가 발생했습니다.");
  });

  it("preserves a local canvas edit made while terminal refresh is in flight", async () => {
    let finishRefresh: (draft: PostDraft) => void = () => {
      throw new Error("terminal refresh did not start");
    };
    const draft = vi.fn((_id: string) => {
      if (draft.mock.calls.length === 1) return Promise.resolve(readDraft());
      return new Promise<PostDraft>((resolve) => {
        finishRefresh = resolve;
      });
    });
    const client = api({ draft });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    await writing.stage();

    stream.emit("run_finished");
    await Promise.resolve();
    writing.onBlocksChange([{ type: "paragraph", text: "새로 입력한 임시 본문" }]);
    finishRefresh({
      ...readDraft(),
      workingCopy: {
        title: "생성된 제목",
        blocks: [{ type: "paragraph", text: "서버에서 갱신된 본문" }],
        summary: "",
        contentVersion: 9,
      },
    });
    await Promise.resolve();

    expect(writing.state.blocks).toEqual([{ type: "paragraph", text: "새로 입력한 임시 본문" }]);
    expect(writing.state.draft?.workingCopy?.blocks).toEqual([
      { type: "paragraph", text: "서버에서 갱신된 본문" },
    ]);
  });

  it("preserves the canvas when resume refresh starts with a scheduled autosave", async () => {
    vi.useFakeTimers();
    let finishRefresh: (draft: PostDraft) => void = () => {
      throw new Error("resume refresh did not start");
    };
    const draft = vi.fn((_id: string) => {
      if (draft.mock.calls.length === 1) return Promise.resolve(readDraft());
      return new Promise<PostDraft>((resolve) => {
        finishRefresh = resolve;
      });
    });
    const client = api({ draft });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onBlocksChange([{ type: "paragraph", text: "저장 대기 중인 본문" }]);

    const refresh = writing.refreshActive();
    await Promise.resolve();
    finishRefresh(readDraft());
    await refresh;

    expect(writing.state.blocks).toEqual([{ type: "paragraph", text: "저장 대기 중인 본문" }]);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("preserves an invalid transient title during a resume refresh", async () => {
    let finishRefresh: (draft: PostDraft) => void = () => {
      throw new Error("resume refresh did not start");
    };
    const draft = vi.fn((_id: string) => {
      if (draft.mock.calls.length === 1) return Promise.resolve(readDraft());
      return new Promise<PostDraft>((resolve) => {
        finishRefresh = resolve;
      });
    });
    const client = api({ draft });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    writing.onTitleChange("");

    const refresh = writing.refreshActive();
    await Promise.resolve();
    finishRefresh(readDraft());
    await refresh;

    expect(writing.state.draft?.title).toBe("");
    expect(writing.state.autoSave).toBe("idle");
  });

  it("marks a staging run unconfirmed when its stream errors", async () => {
    const writing = controller();
    await writing.openDraft(DRAFT_BODY.id);
    await writing.stage();

    stream.emitError();

    expect(writing.state.run?.state).toBe("unconfirmed");
    expect(stream.closes).toBe(1);
  });

  it("closes the active staging stream before opening another draft", async () => {
    const draftA = readDraft();
    const draftB = { ...draftA, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "B 초안" };
    const client = api({
      draft: vi.fn(async (id: string) => (id === draftB.id ? draftB : draftA)),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(draftA.id);
    await writing.stage();

    expect(stream.closes).toBe(0);
    await writing.openDraft(draftB.id);

    expect(stream.closes).toBe(1);
    expect(writing.state.draft?.id).toBe(draftB.id);
  });

  it("ignores a late event from an old stream without closing the current stream", async () => {
    const draftA = readDraft();
    const draftB = { ...draftA, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "B 초안" };
    const client = api({
      draft: vi.fn(async (id: string) => (id === draftB.id ? draftB : draftA)),
      saveDraftBody: vi.fn(async (id: string) => (id === draftB.id ? draftB : draftA)),
      stageDraft: vi.fn(async (id: string) => ({
        ...RUN_AS_DOMAIN,
        id: `run-${id}`,
        draftId: id,
      })),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(draftA.id);
    await writing.stage();
    await writing.openDraft(draftB.id);
    await writing.stage();

    stream.emitFrom(0, "run_finished");

    expect(stream.closes).toBe(1);
    expect(writing.state.draft?.id).toBe(draftB.id);
    expect(writing.state.run?.state).toBe("running");
  });

  it("ignores a terminal refresh from draft A after switching to draft B", async () => {
    let finishRefresh: (draft: PostDraft) => void = () => {
      throw new Error("refresh did not start");
    };
    const draftA = readDraft();
    const draftB = { ...draftA, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "B 초안" };
    const draft = vi.fn(async (id: string) => {
      if (id === draftA.id && draft.mock.calls.length === 1) return draftA;
      if (id === draftB.id) return draftB;
      return new Promise<PostDraft>((resolve) => {
        finishRefresh = resolve;
      });
    });
    const client = api({ draft });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(draftA.id);
    await writing.stage();

    stream.emit("run_finished");
    await Promise.resolve();
    await writing.openDraft(draftB.id);
    finishRefresh({ ...draftA, title: "A 늦은 응답" });
    await Promise.resolve();

    expect(writing.state.draft?.id).toBe(draftB.id);
    expect(writing.state.draft?.title).toBe("생성된 제목");
  });

  it("reports a refusal with a mapped message", async () => {
    const writing = controller({
      composeDraft: vi.fn(async () => {
        throw new ApiError("거부", {
          problem: {
            code: "generation_unavailable",
            detail: "provider가 없습니다.",
            status: 503,
            title: "Generation unavailable",
          },
          status: 503,
        });
      }),
    });
    await writing.openDraft(DRAFT_BODY.id);

    await writing.compose();

    expect(writing.state.phase).toBe("failed");
    expect(writing.state.error).toBe("선택한 AI 연결이 구성되지 않았습니다.");
  });

  it("keeps the service message for an unmapped refusal", async () => {
    const writing = controller({
      composeDraft: vi.fn(async () => {
        throw new ApiError("거부", {
          problem: {
            code: "browser_session_busy",
            detail: "세션이 사용 중입니다.",
            status: 409,
            title: "Conflict",
          },
          status: 409,
        });
      }),
    });
    await writing.openDraft(DRAFT_BODY.id);

    await writing.compose();

    expect(writing.state.error).toBe("세션이 사용 중입니다.");
  });

  it("reports a synced category list", async () => {
    const writing = controller();
    await writing.load();

    await writing.syncCategories();

    expect(writing.state.categories).toHaveLength(1);
    expect(writing.state.notice).toBe("카테고리를 새로 읽었습니다.");
  });

  it("does not refresh categories while another generation action owns the workspace", async () => {
    let finishCompose: (draft: PostDraft) => void = () => {
      throw new Error("compose did not start");
    };
    const syncBlogCategories = vi.fn(async () => [
      { categoryNo: 8, name: "호출되면 안 됨", postCount: 0, syncedAt: null },
    ]);
    const client = api({
      composeDraft: vi.fn(
        () =>
          new Promise<PostDraft>((resolve) => {
            finishCompose = resolve;
          }),
      ),
      syncBlogCategories,
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);
    const composing = writing.compose();

    await writing.syncCategories();

    expect(syncBlogCategories).not.toHaveBeenCalled();
    finishCompose(readDraft());
    await composing;
  });

  it("runs the remaining draft editing operations against the active draft", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    await writing.refine();
    await writing.generateTags();
    await writing.selectRevision(DRAFT_BODY.revisions[0]?.id as string);
    await writing.uploadImage(new File(["image"], "photo.png", { type: "image/png" }));
    await writing.deleteImage("image-id");

    const typed = client as unknown as {
      refineDraft: { mock: { calls: unknown[] } };
      generateDraftTags: { mock: { calls: unknown[] } };
      patchDraft: { mock: { calls: unknown[] } };
      uploadDraftImage: { mock: { calls: unknown[] } };
      deleteDraftImage: { mock: { calls: unknown[] } };
    };
    expect(typed.refineDraft.mock.calls).toHaveLength(1);
    expect(typed.generateDraftTags.mock.calls).toHaveLength(1);
    expect(typed.patchDraft.mock.calls).toHaveLength(1);
    expect(typed.uploadDraftImage.mock.calls).toHaveLength(1);
    expect(typed.deleteDraftImage.mock.calls).toHaveLength(1);
  });

  it("blocks refine and tags until the edited working copy becomes a version", async () => {
    const current = {
      ...readDraft(),
      workingCopy: {
        title: "편집 중 제목",
        blocks: [{ type: "paragraph" as const, text: "편집 중 본문" }],
        summary: "요약",
        contentVersion: 3,
      },
    };
    const refineDraft = vi.fn(async () => readDraft());
    const generateDraftTags = vi.fn(async () => readDraft());
    const client = api({
      draft: vi.fn(async () => current),
      refineDraft,
      generateDraftTags,
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    expect(await writing.refine()).toBeNull();
    expect(await writing.generateTags()).toBeNull();
    expect(refineDraft).not.toHaveBeenCalled();
    expect(generateDraftTags).not.toHaveBeenCalled();
    expect(writing.state.notice).toBe("먼저 현재 편집 내용을 버전으로 남겨 주세요.");
  });

  it("rejects an empty added-tag list without asking the service", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    expect(await writing.addTags([])).toBeNull();
    expect(
      (client as unknown as { patchDraftTags: { mock: { calls: unknown[] } } }).patchDraftTags.mock
        .calls,
    ).toHaveLength(0);
  });

  it("keeps request text, ignores unknown options, and selects a revision from the UI option", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    writing.setOption("request", "마무리를 간결하게");
    writing.setOption("unknown", "ignored");
    writing.setOption("revision", DRAFT_BODY.revisions[0]?.id as string);
    await Promise.resolve();
    await Promise.resolve();

    expect(writing.state.options.request).toBe("마무리를 간결하게");
    expect(
      (client as unknown as { patchDraft: { mock: { calls: unknown[] } } }).patchDraft.mock.calls,
    ).toHaveLength(1);
  });

  it("reports a failed staging request instead of opening a stream", async () => {
    const writing = controller({
      stageDraft: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await writing.openDraft(DRAFT_BODY.id);

    expect(await writing.stage()).toBeNull();
    expect(writing.state.phase).toBe("failed");
    expect(stream.urls).toEqual([]);
  });

  it("keeps the staging stream open for non-terminal events", async () => {
    const writing = controller();
    await writing.openDraft(DRAFT_BODY.id);
    await writing.stage();

    stream.emit("step_started");

    expect(stream.closes).toBe(0);
  });

  it("renders each staging step from its live progress event before the terminal refresh", async () => {
    const writing = controller();
    await writing.openDraft(DRAFT_BODY.id);
    await writing.stage();

    stream.emit("step_completed", {
      step: "body",
      state: "succeeded",
      result_code: "blocks_staged_1",
      detail: {
        requested_range_start: 1,
        requested_range_end: 1,
        observed_prefix_count: 1,
      },
    });

    expect(writing.state.run?.steps.find((step) => step.name === "body")?.resultCode).toBe(
      "blocks_staged_1",
    );
    expect(writing.state.stagingBodyVerification?.observedPrefixCount).toBe(1);
    expect(stream.closes).toBe(0);
  });

  it("reports a category refresh failure", async () => {
    const writing = controller({
      syncBlogCategories: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await writing.load();

    await writing.syncCategories();

    expect(writing.state.phase).toBe("failed");
    expect(writing.state.error).toBe("알 수 없는 오류가 발생했습니다.");
  });

  it("routes rendered seed controls through state and draft lifecycle actions", async () => {
    const newDraft = readCollectingDraft("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const createDraft = vi.fn(async () => newDraft);
    const syncBlogCategories = vi.fn(async () => [
      { categoryNo: 9, name: "새 카테고리", postCount: 0, syncedAt: null },
    ]);
    const client = api({
      blogCategories: vi.fn(async () => [
        { categoryNo: 7, name: "전시 후기", postCount: 3, syncedAt: null },
      ]),
      composeDraft: vi.fn(async () => newDraft),
      createDraft,
      syncBlogCategories,
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.load();

    const title = root.querySelector<HTMLInputElement>("#seed-title");
    const text = root.querySelector<HTMLTextAreaElement>("#seed-text");
    const category = root.querySelector<HTMLSelectElement>("#seed-category");
    if (title === null || text === null || category === null) {
      throw new Error("seed controls did not render");
    }
    title.value = "렌더된 제목";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    text.value = "렌더된 메모";
    text.dispatchEvent(new Event("input", { bubbles: true }));
    category.value = "7";
    category.dispatchEvent(new Event("change", { bubbles: true }));

    root.querySelector<HTMLButtonElement>("#sync-categories-button")?.click();
    await flushPromises();
    expect(syncBlogCategories).toHaveBeenCalledOnce();
    expect(writing.state.categories[0]?.categoryNo).toBe(9);

    root.querySelector<HTMLButtonElement>("#create-draft-button")?.click();
    await flushPromises();
    expect(createDraft).toHaveBeenCalledWith({
      title: "렌더된 제목",
      seedText: "렌더된 메모",
      categoryNo: 7,
      useImageVision: false,
    });
    expect(writing.state.draft?.id).toBe(newDraft.id);

    root.querySelector<HTMLButtonElement>("#start-new-draft-button")?.click();
    await flushPromises();
    expect(writing.state.draft).toBeNull();
    expect(root.querySelector("#seed-title")).not.toBeNull();

    const freshTitle = root.querySelector<HTMLInputElement>("#seed-title");
    const freshText = root.querySelector<HTMLTextAreaElement>("#seed-text");
    if (freshTitle === null || freshText === null) throw new Error("seed form disappeared");
    freshTitle.value = "AI 제목";
    freshTitle.dispatchEvent(new Event("input", { bubbles: true }));
    freshText.value = "AI 메모";
    freshText.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>("#complete-draft-button")?.click();
    await flushPromises();
    expect(createDraft).toHaveBeenCalledTimes(2);
    expect(
      (client as unknown as { composeDraft: { mock: { calls: unknown[][] } } }).composeDraft.mock
        .calls,
    ).toHaveLength(1);

    root.querySelector<HTMLButtonElement>("#start-new-draft-button")?.click();
    await flushPromises();
    const existingDraft = root.querySelector<HTMLButtonElement>(
      `[data-draft-id="${DRAFT_BODY.id}"]`,
    );
    existingDraft?.click();
    await flushPromises();
    expect(writing.state.draft?.id).toBe(DRAFT_BODY.id);
  });

  it("routes rendered editor controls to observable API and state outcomes", async () => {
    vi.useFakeTimers();
    const toolsDraft = readDraftWithEditorTools();
    const savedDraft = (blocks: PostDraft["revisions"][number]["blocks"], title: string) => ({
      ...toolsDraft,
      title,
      workingCopy: { title, blocks, summary: "편집 요약", contentVersion: 4 },
    });
    const saveDraftBody = vi.fn(
      async (
        _draftId: string,
        payload: {
          title: string;
          blocks: PostDraft["revisions"][number]["blocks"];
        },
      ) => savedDraft(payload.blocks, payload.title),
    );
    const checkpointDraft = vi.fn(async () =>
      savedDraft([{ type: "paragraph", text: "체크포인트 본문" }], "체크포인트 제목"),
    );
    const refineDraft = vi.fn(async () => toolsDraft);
    const composeDraft = vi.fn(async () => toolsDraft);
    const generateDraftTags = vi.fn(async () => toolsDraft);
    const patchDraft = vi.fn(async () => toolsDraft);
    const patchDraftTags = vi.fn(async () => toolsDraft);
    const uploadDraftImage = vi.fn(async () => toolsDraft);
    const deleteDraftImage = vi.fn(async () => toolsDraft);
    const stageDraft = vi.fn(async () => RUN_AS_DOMAIN);
    const client = api({
      checkpointDraft,
      composeDraft,
      deleteDraftImage,
      draft: vi.fn(async () => toolsDraft),
      generateDraftTags,
      patchDraft,
      patchDraftTags,
      refineDraft,
      saveDraftBody,
      stageDraft,
      uploadDraftImage,
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.load({ draftId: toolsDraft.id });

    const request = root.querySelector<HTMLInputElement>("#refine-request");
    request?.dispatchEvent(new Event("input", { bubbles: true }));
    if (request !== null) {
      request.value = "조금 더 간결하게";
      request.dispatchEvent(new Event("input", { bubbles: true }));
    }
    root.querySelector<HTMLButtonElement>(".provider-choice")?.click();

    const secondRevision = root.querySelector<HTMLButtonElement>(
      '[data-revision-id="33333333-3333-4333-8333-333333333333"]',
    );
    secondRevision?.click();
    await flushPromises();
    expect(patchDraft).toHaveBeenCalledWith(toolsDraft.id, {
      activeRevisionId: "33333333-3333-4333-8333-333333333333",
    });

    const tag = root.querySelector<HTMLButtonElement>('[data-tag="여행"]');
    tag?.click();
    await flushPromises();
    expect(patchDraftTags).toHaveBeenCalledWith(toolsDraft.id, { selected: ["전시", "여행"] });

    const tagInput = root.querySelector<HTMLInputElement>("#tag-input");
    if (tagInput === null) throw new Error("tag controls did not render");
    tagInput.value = "산책, 기록";
    tagInput.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>("#add-tags-button")?.click();
    await flushPromises();
    expect(patchDraftTags).toHaveBeenCalledWith(toolsDraft.id, {
      added: ["산책", "기록"],
    });

    root.querySelector<HTMLButtonElement>("#generate-tags-button")?.click();
    await flushPromises();
    root.querySelector<HTMLButtonElement>("#refine-button")?.click();
    await flushPromises();
    root.querySelector<HTMLButtonElement>("#compose-button")?.click();
    await flushPromises();
    expect(generateDraftTags).toHaveBeenCalledOnce();
    expect(refineDraft).toHaveBeenCalledOnce();
    expect(composeDraft).toHaveBeenCalledOnce();

    const imageInput = root.querySelector<HTMLInputElement>("#image-input");
    if (imageInput === null) throw new Error("image controls did not render");
    const file = new File(["image"], "new-photo.png", { type: "image/png" });
    Object.defineProperty(imageInput, "files", { configurable: true, value: [file] });
    imageInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();
    expect(uploadDraftImage).toHaveBeenCalledWith(toolsDraft.id, file);

    root.querySelector<HTMLButtonElement>('.image-remove[data-image-id="image-1"]')?.click();
    await flushPromises();
    expect(deleteDraftImage).toHaveBeenCalledWith(toolsDraft.id, "image-1");

    const insertionPoint = root.querySelector<HTMLButtonElement>(".image-insertion-point");
    insertionPoint?.click();
    expect(writing.state.imageInsertAt).toBe(0);
    root.querySelector<HTMLButtonElement>(".image-insert")?.click();
    expect(writing.state.blocks[0]).toEqual({ type: "image", image_id: "image-1", caption: "" });

    const secondBlockType = root.querySelector<HTMLSelectElement>(
      'select[aria-label="2번째 블록 형식"]',
    );
    if (secondBlockType === null) throw new Error("block structure controls did not render");
    secondBlockType.value = "quote";
    secondBlockType.dispatchEvent(new Event("change", { bubbles: true }));
    const body = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="2번째 인용 내용"]');
    if (body === null) throw new Error("block text control did not render");
    body.value = "구조를 바꾼 본문";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    const title = root.querySelector<HTMLInputElement>("#draft-title");
    if (title === null) throw new Error("draft title control did not render");
    title.value = "변경된 제목";
    title.dispatchEvent(new Event("input", { bubbles: true }));

    root.querySelector<HTMLButtonElement>("#save-body-button")?.click();
    await flushPromises();
    expect(saveDraftBody).toHaveBeenCalled();
    expect(writing.state.autoSave).toBe("saved");

    body.value = "체크포인트로 남길 본문";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>("#checkpoint-body-button")?.click();
    await flushPromises();
    expect(checkpointDraft).toHaveBeenCalledWith(toolsDraft.id);

    const stageButton = root.querySelector<HTMLButtonElement>("#stage-button");
    expect(stageButton).not.toBeNull();
    expect({
      busy: writing.state.busy,
      run: writing.state.run?.state ?? null,
      blocks: writing.state.blocks,
      title: writing.state.draft?.title,
      draftId: writing.state.draft?.id,
    }).toMatchObject({ busy: false, run: null, draftId: toolsDraft.id });
    expect(stageButton?.disabled).toBe(false);
    stageButton?.click();
    await flushPromises();
    expect(stageDraft).toHaveBeenCalledWith(toolsDraft.id);
    expect(stream.urls).toContain(`/api/v1/drafts/${toolsDraft.id}/stage/events`);
    vi.useRealTimers();
  });

  it("refuses a second action while generation is in flight", async () => {
    let resolve: (draft: PostDraft) => void = () => {
      throw new Error("compose did not start");
    };
    const client = api({
      composeDraft: vi.fn(
        () =>
          new Promise<PostDraft>((complete) => {
            resolve = complete;
          }),
      ),
    });
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    const composing = writing.compose();
    expect(await writing.openDraft(DRAFT_BODY.id)).toBeNull();
    resolve(readDraft());
    await composing;
  });
});
