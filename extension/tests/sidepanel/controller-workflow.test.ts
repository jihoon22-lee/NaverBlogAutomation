import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClientError, type LocalApiClient } from "../../src/api/client";
import type {
  ApiResult,
  CreateRecommendationRequest,
  Recommendation,
  ReviewRecommendationRequest,
} from "../../src/api/types";
import type { TabCaptureGateway, TabInvalidation } from "../../src/browser/tab-capture-gateway";
import type { ActiveTab, FrameExecution } from "../../src/extraction/types";
import { IdempotencyRegistry, type StorageArea } from "../../src/idempotency/registry";
import { SidePanelController } from "../../src/sidepanel/controller";
import type { PanelActions, PanelState, PanelView } from "../../src/sidepanel/state";

const DIGEST = "a".repeat(64);
const tab: ActiveTab = {
  id: 7,
  title: "합성 전시 후기",
  url: "https://blog.naver.com/synthetic/7",
};
const candidates = [
  {
    comment: "따뜻한 합성 댓글입니다.",
    id: "00000000-0000-4000-8000-000000000071",
    referencedDetail: "합성 전시 동선",
    tone: "warm" as const,
  },
  {
    comment: "궁금한 합성 댓글입니다.",
    id: "00000000-0000-4000-8000-000000000072",
    referencedDetail: "합성 작품 설명",
    tone: "curious" as const,
  },
  {
    comment: "응원하는 합성 댓글입니다.",
    id: "00000000-0000-4000-8000-000000000073",
    referencedDetail: "합성 재방문 계획",
    tone: "supportive" as const,
  },
];

const drafted: Recommendation = {
  candidates,
  commentLength: "medium",
  createdAt: "2026-07-17T00:00:00Z",
  editedComment: null,
  id: "00000000-0000-4000-8000-000000000070",
  relationshipLevel: "friendly",
  reviewStatus: "drafted",
  selectedCandidateId: null,
  sourceUrl: tab.url,
  speechStyle: "honorific",
  summary: "합성 전시 후기 요약",
  title: tab.title,
  topics: ["전시", "동선"],
  updatedAt: null,
};

const frames: readonly FrameExecution[] = [
  {
    frameId: 0,
    result: {
      body: "관람한 작품과 이동 동선을 충분히 자세하게 기록한 합성 테스트 본문입니다.",
      canonicalUrl: tab.url,
      frameUrl: tab.url,
      originalLength: 38,
      selectorConfidence: 500,
      selectorKind: "modern",
      title: tab.title,
    },
  },
];

class MemoryStorage implements StorageArea {
  readonly order: string[];
  pendingReject: ((error: unknown) => void) | null = null;
  rejectWriteNumber: number | null = null;
  value: Record<string, unknown> = {};
  writeCount = 0;

  constructor(order: string[] = []) {
    this.order = order;
  }

  async get(): Promise<Record<string, unknown>> {
    return structuredClone(this.value);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.writeCount += 1;
    this.order.push("storage");
    if (this.writeCount === this.rejectWriteNumber) {
      await new Promise<void>((_resolve, reject) => {
        this.pendingReject = reject;
      });
      return;
    }
    this.value = structuredClone(items);
  }
}

class Gateway implements TabCaptureGateway {
  invalidation: ((event: TabInvalidation) => void) | null = null;

  async captureAllFrames(): Promise<readonly FrameExecution[]> {
    return frames;
  }

  async getActiveTab(): Promise<ActiveTab> {
    return tab;
  }

  subscribeToInvalidation(listener: (event: TabInvalidation) => void): () => void {
    this.invalidation = listener;
    return () => {
      this.invalidation = null;
    };
  }
}

class View implements PanelView {
  actions: PanelActions | null = null;
  copiedValues: string[] = [];
  copyResult = true;
  readonly states: PanelState[] = [];

  bind(actions: PanelActions): void {
    this.actions = actions;
  }

  clearSensitiveContent(): void {}

  async copyText(value: string): Promise<boolean> {
    this.copiedValues.push(value);
    return this.copyResult;
  }

  render(state: PanelState): void {
    this.states.push(state);
  }
}

class Api {
  create = vi.fn<
    (
      payload: CreateRecommendationRequest,
      key: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<Recommendation>>
  >(async () => ({ replayed: false, value: drafted }));
  get = vi.fn<(id: string, signal?: AbortSignal) => Promise<Recommendation>>(async () => drafted);
  healthCheck = vi.fn<(signal?: AbortSignal) => Promise<void>>(async () => undefined);
  review = vi.fn<
    (
      id: string,
      payload: ReviewRecommendationRequest,
      signal?: AbortSignal,
    ) => Promise<Recommendation>
  >(async (_id, payload) => ({
    ...drafted,
    editedComment: payload.edited_comment ?? null,
    reviewStatus: payload.review_status ?? "drafted",
    selectedCandidateId: payload.selected_candidate_id ?? null,
  }));

  asClient(): LocalApiClient {
    return {
      createRecommendation: this.create,
      getRecommendation: this.get,
      health: this.healthCheck,
      reviewRecommendation: this.review,
    } as unknown as LocalApiClient;
  }
}

function problem(
  code: string,
  status: number,
  options: { replayed?: boolean; retry?: number } = {},
) {
  return new ApiClientError("safe synthetic problem", {
    problem: {
      code,
      detail: "safe synthetic problem",
      requestId: "00000000-0000-4000-8000-000000000099",
      status,
      title: "Synthetic problem",
      type: "about:blank",
    },
    retryAfterSeconds: options.retry ?? null,
    status,
    ...(options.replayed === undefined ? {} : { replayed: options.replayed }),
  });
}

function setup(
  options: { api?: Api; gateway?: Gateway; now?: () => number; wait?: () => Promise<void> } = {},
) {
  const order: string[] = [];
  const storage = new MemoryStorage(order);
  const registry = new IdempotencyRegistry(storage, options.now ?? (() => 1_000));
  const api = options.api ?? new Api();
  api.create.mockImplementation(async () => {
    order.push("post");
    return { replayed: false, value: drafted };
  });
  const gateway = options.gateway ?? new Gateway();
  const view = new View();
  const controller = new SidePanelController(gateway, view, {
    api: api.asClient(),
    digest: vi.fn(async () => DIGEST),
    now: options.now ?? (() => 1_000),
    registry,
    wait: options.wait ?? (async () => undefined),
  });
  return { api, controller, gateway, order, registry, storage, view };
}

async function extractAndGenerate(view: View, controller: SidePanelController): Promise<void> {
  await controller.captureActivePost();
  view.actions?.generate();
  await vi.waitFor(() => expect(view.states.at(-1)?.kind).toBe("review"));
}

beforeEach(() => vi.restoreAllMocks());

describe("integrated Side Panel workflow", () => {
  it("persists the key before POST and renders 201 or 200 replay identically", async () => {
    const first = setup();
    await extractAndGenerate(first.view, first.controller);
    expect(first.order.indexOf("storage")).toBeLessThan(first.order.indexOf("post"));
    expect(first.api.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(first.storage.value)).not.toMatch(/본문|제목|blog\.naver|comment|body/u);

    const replay = setup();
    replay.api.create.mockImplementation(async () => ({ replayed: true, value: drafted }));
    await extractAndGenerate(replay.view, replay.controller);
    expect(replay.view.states.at(-1)?.kind).toBe("review");
  });

  it("disables duplicate generation synchronously", async () => {
    const pending: { resolve?: () => void } = {};
    const fixture = setup();
    fixture.api.healthCheck.mockImplementation(
      () => new Promise<void>((resolve) => (pending.resolve = resolve)),
    );
    await fixture.controller.captureActivePost();
    fixture.view.actions?.generate();
    fixture.view.actions?.generate();
    expect(fixture.api.healthCheck).toHaveBeenCalledOnce();
    pending.resolve?.();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));
  });

  it("treats a health connection failure as retryable preflight without a dead replacement", async () => {
    const fixture = setup();
    fixture.api.healthCheck.mockRejectedValue(new ApiClientError("로컬 API 연결 실패"));
    await fixture.controller.captureActivePost();
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("error"));

    expect(fixture.view.states.at(-1)).toMatchObject({
      failure: { action: "retry", code: "api_unavailable" },
      kind: "error",
    });
    expect(fixture.api.create).not.toHaveBeenCalled();
    expect(fixture.storage.order).toEqual([]);
  });

  it("polls the same key after in-progress by re-extracting the matching article", async () => {
    const fixture = setup();
    fixture.api.create
      .mockRejectedValueOnce(problem("generation_in_progress", 409))
      .mockResolvedValueOnce({ replayed: true, value: drafted });
    await extractAndGenerate(fixture.view, fixture.controller);
    expect(fixture.api.create).toHaveBeenCalledTimes(2);
    expect(fixture.api.create.mock.calls[0]?.[1]).toBe(fixture.api.create.mock.calls[1]?.[1]);
  });

  it("reopens a known recommendation with GET and restores approved review state", async () => {
    const fixture = setup();
    const approved: Recommendation = {
      ...drafted,
      editedComment: "저장된 편집 댓글",
      reviewStatus: "approved",
      selectedCandidateId: candidates[0]?.id ?? null,
    };
    await fixture.registry.getOrCreate(DIGEST);
    await fixture.registry.transition(DIGEST, "reviewing", drafted.id);
    fixture.api.get.mockResolvedValue(approved);

    await fixture.controller.captureActivePost();
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("approved"));
    expect(fixture.api.create).not.toHaveBeenCalled();
    expect(fixture.api.get).toHaveBeenCalledWith(drafted.id, expect.any(AbortSignal));
    expect(fixture.view.states.at(-1)).toMatchObject({
      editedComment: "저장된 편집 댓글",
      selectedCandidateId: candidates[0]?.id,
    });
  });

  it("keeps a known recommendation pinned when its restore GET fails transiently", async () => {
    const fixture = setup();
    await fixture.registry.getOrCreate(DIGEST);
    await fixture.registry.transition(DIGEST, "reviewing", drafted.id);
    fixture.api.get.mockRejectedValue(new ApiClientError("일시적인 GET 실패"));

    await fixture.controller.captureActivePost();
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("error"));
    expect(fixture.view.states.at(-1)).toMatchObject({ failure: { action: "retry" } });
    expect((await fixture.registry.find(DIGEST))?.state).toBe("reviewing");
  });

  it("honors an over-deadline Retry-After without issuing a second POST", async () => {
    const fixture = setup();
    fixture.api.create.mockRejectedValue(problem("generation_rate_limited", 429, { retry: 61 }));
    await fixture.controller.captureActivePost();
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("error"));
    expect(fixture.api.create).toHaveBeenCalledOnce();
    expect(fixture.view.states.at(-1)).toMatchObject({
      failure: { code: "polling_stopped" },
      kind: "error",
    });
  });

  it("requires explicit replacement after an indeterminate result", async () => {
    const fixture = setup();
    fixture.api.create.mockRejectedValueOnce(problem("generation_indeterminate", 409));
    await fixture.controller.captureActivePost();
    fixture.view.actions?.generate();
    await vi.waitFor(() =>
      expect(fixture.view.states.at(-1)).toMatchObject({
        failure: { action: "replace" },
        kind: "error",
      }),
    );
    const firstKey = fixture.api.create.mock.calls[0]?.[1];

    fixture.view.actions?.replace();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("preview"));
    fixture.api.create.mockResolvedValueOnce({ replayed: false, value: drafted });
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));
    expect(fixture.api.create.mock.calls[1]?.[1]).not.toBe(firstKey);
  });

  it("selects, edits, approves, copies, and separately completes", async () => {
    const fixture = setup();
    await extractAndGenerate(fixture.view, fixture.controller);
    const selected = candidates[1];
    if (selected === undefined) {
      throw new Error("Synthetic candidate missing");
    }
    fixture.view.actions?.select(selected.id);
    fixture.view.actions?.edit("사용자가 다듬은 합성 댓글");
    fixture.view.actions?.approve();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("approved"));
    expect(fixture.api.review.mock.calls[0]?.[1]).toEqual({
      edited_comment: "사용자가 다듬은 합성 댓글",
      review_status: "approved",
      selected_candidate_id: selected.id,
    });

    fixture.view.actions?.copy();
    await vi.waitFor(() =>
      expect(fixture.view.copiedValues).toEqual(["사용자가 다듬은 합성 댓글"]),
    );
    expect(fixture.api.review).toHaveBeenCalledTimes(1);
    fixture.view.actions?.complete();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("completed"));
    expect(fixture.api.review).toHaveBeenCalledTimes(2);
    expect(fixture.api.review.mock.calls[1]?.[1]).toEqual({ review_status: "completed" });
  });

  it("refreshes GET after review_conflict without reapplying stale edits", async () => {
    const latest = {
      ...drafted,
      editedComment: "다른 곳에서 저장된 댓글",
      selectedCandidateId: candidates[0]?.id ?? null,
    };
    const fixture = setup();
    fixture.api.review.mockRejectedValue(problem("review_conflict", 409));
    fixture.api.get.mockResolvedValue(latest);
    await extractAndGenerate(fixture.view, fixture.controller);
    fixture.view.actions?.select(candidates[0]?.id ?? "");
    fixture.view.actions?.approve();
    await vi.waitFor(() => expect(fixture.api.get).toHaveBeenCalledOnce());
    expect(fixture.api.review).toHaveBeenCalledOnce();
    expect(fixture.view.states.at(-1)).toMatchObject({
      kind: "review",
      notice: expect.stringContaining("최신"),
    });
  });

  it("applies completion TTL when conflict refresh finds a completed recommendation", async () => {
    const latest: Recommendation = {
      ...drafted,
      editedComment: "서버에서 완료된 댓글",
      reviewStatus: "completed",
      selectedCandidateId: candidates[0]?.id ?? null,
    };
    const fixture = setup();
    fixture.api.review.mockRejectedValue(problem("review_conflict", 409));
    fixture.api.get.mockResolvedValue(latest);
    await extractAndGenerate(fixture.view, fixture.controller);
    fixture.view.actions?.select(candidates[0]?.id ?? "");
    fixture.view.actions?.approve();

    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("completed"));
    expect(await fixture.registry.find(DIGEST)).toMatchObject({
      expiresAt: 3_601_000,
      state: "completed",
    });
  });

  it("rejects stale generation after navigation and keeps current error state", async () => {
    const pending: { resolve?: (value: ApiResult<Recommendation>) => void } = {};
    const fixture = setup();
    fixture.api.create.mockImplementation(
      () => new Promise<ApiResult<Recommendation>>((resolve) => (pending.resolve = resolve)),
    );
    await fixture.controller.captureActivePost();
    fixture.controller.start();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("preview"));
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(pending.resolve).toBeDefined());
    fixture.gateway.invalidation?.({ kind: "updated", tabId: tab.id });
    pending.resolve?.({ replayed: false, value: drafted });
    await Promise.resolve();
    expect(fixture.view.states.at(-1)).toEqual({ failure: { code: "stale_page" }, kind: "error" });
  });

  it("ignores a delayed generation rejection after navigation", async () => {
    const pending: { reject?: (error: unknown) => void } = {};
    const fixture = setup();
    fixture.api.create.mockImplementation(
      () => new Promise((_resolve, reject) => (pending.reject = reject)),
    );
    fixture.controller.start();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("preview"));
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(pending.reject).toBeDefined());
    fixture.gateway.invalidation?.({ kind: "updated", tabId: tab.id });
    pending.reject?.(problem("generation_indeterminate", 409));
    await Promise.resolve();

    expect(fixture.view.states.at(-1)).toEqual({ failure: { code: "stale_page" }, kind: "error" });
    expect((await fixture.registry.find(DIGEST))?.state).toBe("active");
  });

  it("ignores a delayed registry rejection after navigation", async () => {
    const fixture = setup();
    fixture.storage.rejectWriteNumber = 2;
    fixture.api.create.mockRejectedValue(problem("generation_invalid", 502));
    fixture.controller.start();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("preview"));
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.storage.pendingReject).not.toBeNull());

    fixture.gateway.invalidation?.({ kind: "updated", tabId: tab.id });
    fixture.storage.pendingReject?.(new Error("delayed synthetic storage failure"));
    await Promise.resolve();

    expect(fixture.view.states.at(-1)).toEqual({ failure: { code: "stale_page" }, kind: "error" });
  });

  it("ignores a delayed approval rejection after navigation", async () => {
    const pending: { reject?: (error: unknown) => void } = {};
    const fixture = setup();
    fixture.controller.start();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("preview"));
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));
    fixture.api.review.mockImplementation(
      () => new Promise((_resolve, reject) => (pending.reject = reject)),
    );
    fixture.view.actions?.select(candidates[0]?.id ?? "");
    fixture.view.actions?.approve();
    await vi.waitFor(() => expect(pending.reject).toBeDefined());
    fixture.gateway.invalidation?.({ kind: "updated", tabId: tab.id });
    pending.reject?.(problem("review_conflict", 409));
    await Promise.resolve();

    expect(fixture.api.get).not.toHaveBeenCalled();
    expect(fixture.view.states.at(-1)).toEqual({ failure: { code: "stale_page" }, kind: "error" });
  });

  it("marks a user-cancelled submitted attempt indeterminate", async () => {
    const pending: { resolve?: (value: ApiResult<Recommendation>) => void } = {};
    const fixture = setup();
    fixture.api.create.mockImplementation(
      () => new Promise<ApiResult<Recommendation>>((resolve) => (pending.resolve = resolve)),
    );
    await fixture.controller.captureActivePost();
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(pending.resolve).toBeDefined());
    fixture.view.actions?.cancel();
    await vi.waitFor(() =>
      expect(fixture.view.states.at(-1)).toMatchObject({
        failure: { action: "replace", code: "generation_indeterminate" },
        kind: "error",
      }),
    );
    expect((await fixture.registry.find(DIGEST))?.state).toBe("indeterminate");
    pending.resolve?.({ replayed: false, value: drafted });
  });
});
