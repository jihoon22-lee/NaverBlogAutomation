import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, LocalApiClient } from "../../src/app/api/client";
import type { RunStreamFactory, RunStreamHandlers } from "../../src/app/api/run-stream";
import type { PostDraft, PublishRun } from "../../src/app/api/types";
import { WritingController } from "../../src/app/controllers/writing";

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

  readonly factory: RunStreamFactory = (url, handlers) => {
    this.urls.push(url);
    this.handlers = handlers;
    return {
      close: () => {
        this.closes += 1;
      },
    };
  };

  emit(event: string, payload: Record<string, unknown> = {}): void {
    this.handlers?.onEvent({ event, payload });
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

function api(overrides: Record<string, unknown> = {}) {
  return {
    blogCategories: vi.fn(async () => []),
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

  it("loads providers, categories, and drafts", async () => {
    const writing = controller();

    await writing.load();

    expect(writing.state.phase).toBe("seed");
    expect(writing.state.drafts).toHaveLength(1);
    expect(writing.state.options.provider).toBe("openai");
  });

  it("refuses to create a draft without a title", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });

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

  it("does not compose without a draft", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });

    expect(await writing.compose()).toBeNull();
  });

  it("keeps image blocks when saving edited text", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    await writing.saveBody("고친 문단");

    const call = (client as unknown as { saveDraftBody: { mock: { calls: unknown[][] } } })
      .saveDraftBody.mock.calls[0];
    expect(call?.[1]).toMatchObject({
      title: "합성 초안",
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
    ).toMatchObject({ title: "고친 제목", baseContentVersion: 4 });
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
        title: "합성 초안",
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

  it("drops a queued autosave on a content conflict instead of overwriting the latest copy", async () => {
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
    const client = api({
      draft: vi.fn(async () => current),
      saveDraftBody: vi.fn(
        () =>
          new Promise<PostDraft>((_resolve, reject) => {
            rejectFirstSave = reject;
          }),
      ),
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
    expect(writing.state.blocks).toEqual([{ type: "paragraph", text: "다른 기기의 최신 본문" }]);
    expect(writing.state.error).toBe(
      "다른 기기의 최신 본문을 불러왔습니다. 변경 내용은 덮어쓰지 않았습니다.",
    );
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

  it("refuses to save an empty body", async () => {
    const client = api();
    const writing = new WritingController(root, { api: client, stream: stream.factory });
    await writing.openDraft(DRAFT_BODY.id);

    expect(await writing.saveBody("   ")).toBeNull();
    expect(writing.state.error).toBe("저장할 본문이 없습니다.");
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

  it("stages the draft and subscribes to its stream", async () => {
    const writing = controller();
    await writing.openDraft(DRAFT_BODY.id);

    const run = await writing.stage();

    expect(run?.id).toBe(RUN_BODY.id);
    expect(writing.state.phase).toBe("staging");
    expect(stream.urls).toEqual([`/api/v1/drafts/${DRAFT_BODY.id}/stage/events`]);
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
    expect(
      (client as unknown as { draft: { mock: { calls: unknown[] } } }).draft.mock.calls.length,
    ).toBeGreaterThan(1);
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
    expect(writing.state.error).toBe("선택한 provider가 구성되지 않았습니다.");
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
