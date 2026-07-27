import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClientError, type LocalApiClient } from "../../src/api/client";
import type {
  ApiResult,
  CreateRecommendationRequest,
  DiscoveryPost,
  EngagementRun,
  Recommendation,
  ReviewRecommendationRequest,
} from "../../src/api/types";
import type { TabCaptureGateway, TabInvalidation } from "../../src/browser/tab-capture-gateway";
import type {
  CommentInputGateway,
  CommentInputResult,
} from "../../src/browser/comment-input-gateway";
import type { EngagementApprovalToken } from "../../src/engagement/approval-session";
import type {
  EngagementExecutionRequest,
  EngagementExecutionResult,
} from "../../src/engagement/run-controller";
import type { ActiveTab, FrameExecution } from "../../src/extraction/types";
import {
  IdempotencyRegistry,
  type RegistryMutationLock,
  type StorageArea,
} from "../../src/idempotency/registry";
import { CommentLengthPreferenceStore } from "../../src/preferences/store";
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
  commentMood: "warm",
  createdAt: "2026-07-17T00:00:00Z",
  editedComment: null,
  id: "00000000-0000-4000-8000-000000000070",
  relationshipLevel: "friendly",
  qualityWarnings: [],
  personalizationApplied: false,
  personalizationEligible: true,
  personalizationMode: "completed_examples",
  personalizationSampleCount: 0,
  reviewStatus: "drafted",
  selectedCandidateId: null,
  sourceUrl: tab.url,
  speechStyle: "honorific",
  summary: "합성 전시 후기 요약",
  title: tab.title,
  topics: ["전시", "동선"],
  updatedAt: null,
};

const discoveryPost: DiscoveryPost = {
  createdAt: "2026-07-28T00:00:00Z",
  id: "00000000-0000-4000-8000-000000000074",
  neighborId: "00000000-0000-4000-8000-000000000075",
  publishedAt: "2026-07-28T00:00:00Z",
  publisherBlogId: null,
  publisherName: "합성 이웃",
  searchId: null,
  source: "neighbor",
  sourceUrl: tab.url,
  state: "opened",
  title: tab.title,
  updatedAt: "2026-07-28T00:00:00Z",
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
    this.value = { ...this.value, ...structuredClone(items) };
  }
}

class MemoryLock implements RegistryMutationLock {
  #pending: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation, operation);
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
  options: {
    api?: Api;
    approval?: {
      cancelPendingApproval(): void;
      requestApproval(details: {
        comment: string;
        neighborMessage?: string;
        sourceUrl: string;
        steps: readonly ("comment" | "like" | "mutual_neighbor")[];
        title: string;
      }): Promise<EngagementApprovalToken | null>;
    };
    commentInput?: CommentInputGateway;
    digest?: (payload: CreateRecommendationRequest) => Promise<string>;
    engagement?: {
      execute(request: EngagementExecutionRequest): Promise<EngagementExecutionResult>;
    };
    gateway?: Gateway;
    lengthStore?: CommentLengthPreferenceStore;
    now?: () => number;
    wait?: () => Promise<void>;
  } = {},
) {
  const order: string[] = [];
  const storage = new MemoryStorage(order);
  const registry = new IdempotencyRegistry(storage, options.now ?? (() => 1_000), new MemoryLock());
  const api = options.api ?? new Api();
  api.create.mockImplementation(async () => {
    order.push("post");
    return { replayed: false, value: drafted };
  });
  const gateway = options.gateway ?? new Gateway();
  const view = new View();
  const controller = new SidePanelController(gateway, view, {
    api: api.asClient(),
    ...(options.approval === undefined ? {} : { approval: options.approval }),
    commentInput:
      options.commentInput ??
      ({
        fill: vi.fn(async (): Promise<CommentInputResult> => "filled"),
      } satisfies CommentInputGateway),
    digest: options.digest ?? vi.fn(async () => DIGEST),
    ...(options.engagement === undefined ? {} : { engagement: options.engagement }),
    lengthStore: options.lengthStore ?? new CommentLengthPreferenceStore(storage),
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
    expect(first.api.create.mock.calls[0]?.[0]).toEqual({
      body: frames[0]?.result?.body,
      comment_length: "medium",
      comment_mood: "warm",
      personalization_mode: "completed_examples",
      relationship_level: "friendly",
      source_url: tab.url,
      speech_style: "honorific",
      title: tab.title,
    });
    expect(JSON.stringify(first.storage.value)).not.toMatch(/본문|제목|blog\.naver|comment|body/u);

    const replay = setup();
    replay.api.create.mockImplementation(async () => ({ replayed: true, value: drafted }));
    await extractAndGenerate(replay.view, replay.controller);
    expect(replay.view.states.at(-1)?.kind).toBe("review");
  });

  it("sends close, banmal, long, and lively preferences as one validated snapshot", async () => {
    const fixture = setup();
    await fixture.controller.captureActivePost();
    fixture.view.actions?.changeRelationship("close");
    fixture.view.actions?.changeSpeechStyle("banmal");
    fixture.view.actions?.changeCommentLength("long");
    fixture.view.actions?.changeCommentMood("lively");
    fixture.api.create.mockResolvedValue({
      replayed: false,
      value: {
        ...drafted,
        commentLength: "long",
        commentMood: "lively",
        personalizationMode: "completed_examples",
        relationshipLevel: "close",
        speechStyle: "banmal",
      },
    });
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));

    expect(fixture.api.create.mock.calls[0]?.[0]).toMatchObject({
      comment_length: "long",
      comment_mood: "lively",
      relationship_level: "close",
      speech_style: "banmal",
    });
  });

  it("sends an explicit opt-out when style personalization is turned off", async () => {
    const fixture = setup();
    await fixture.controller.captureActivePost();
    fixture.view.actions?.changePersonalizationMode("off");
    fixture.api.create.mockResolvedValue({
      replayed: false,
      value: { ...drafted, personalizationMode: "off" },
    });
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));

    expect(fixture.api.create.mock.calls[0]?.[0]).toMatchObject({ personalization_mode: "off" });
  });

  it("resets banmal synchronously when the relationship is no longer close", async () => {
    const fixture = setup();
    await fixture.controller.captureActivePost();
    fixture.view.actions?.changeRelationship("close");
    fixture.view.actions?.changeSpeechStyle("banmal");
    fixture.view.actions?.changeRelationship("polite");

    expect(fixture.view.states.at(-1)).toMatchObject({
      kind: "preview",
      preferences: { relationshipLevel: "polite", speechStyle: "honorific" },
    });
  });

  it("retains an explicitly saved default profile when reading a new article", async () => {
    const fixture = setup();
    await fixture.controller.captureActivePost();
    fixture.view.actions?.changeRelationship("close");
    fixture.view.actions?.changeSpeechStyle("banmal");
    fixture.view.actions?.changeCommentLength("long");
    fixture.view.actions?.changeCommentMood("lively");
    fixture.view.actions?.changeClosingPhrase("오늘도 좋은 하루 보내세요!");
    fixture.view.actions?.savePreferences();
    await vi.waitFor(() =>
      expect(fixture.storage.value.commentLengthPreferenceV1).toEqual({
        closingPhrase: "오늘도 좋은 하루 보내세요!",
        commentLength: "long",
        commentMood: "lively",
        personalizationMode: "completed_examples",
        relationshipLevel: "close",
        schemaVersion: 5,
        speechStyle: "banmal",
      }),
    );

    await fixture.controller.captureActivePost();
    expect(fixture.view.states.at(-1)).toMatchObject({
      closingPhrase: "오늘도 좋은 하루 보내세요!",
      kind: "preview",
      preferences: {
        commentLength: "long",
        commentMood: "lively",
        relationshipLevel: "close",
        speechStyle: "banmal",
      },
    });
    expect(fixture.storage.value.generationRegistryV1).toBeUndefined();
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

  it("retains click-time preferences while polling", async () => {
    let fixture: ReturnType<typeof setup>;
    fixture = setup({
      wait: async () => {
        fixture.view.actions?.changeRelationship("friendly");
        fixture.view.actions?.changeCommentLength("short");
        fixture.view.actions?.changeCommentMood("warm");
      },
    });
    const custom = {
      ...drafted,
      commentLength: "long" as const,
      commentMood: "calm" as const,
      relationshipLevel: "close" as const,
      speechStyle: "banmal" as const,
    };
    fixture.api.create
      .mockRejectedValueOnce(problem("generation_in_progress", 409))
      .mockResolvedValueOnce({ replayed: true, value: custom });
    await fixture.controller.captureActivePost();
    fixture.view.actions?.changeRelationship("close");
    fixture.view.actions?.changeSpeechStyle("banmal");
    fixture.view.actions?.changeCommentLength("long");
    fixture.view.actions?.changeCommentMood("calm");
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));

    expect(fixture.api.create.mock.calls).toHaveLength(2);
    expect(fixture.api.create.mock.calls[1]?.[0]).toMatchObject({
      comment_length: "long",
      comment_mood: "calm",
      relationship_level: "close",
      speech_style: "banmal",
    });
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

  it("quarantines a restored recommendation with mismatched preference provenance", async () => {
    const fixture = setup();
    await fixture.registry.getOrCreate(DIGEST);
    await fixture.registry.transition(DIGEST, "reviewing", drafted.id);
    fixture.api.get.mockResolvedValue({ ...drafted, commentLength: "long" });

    await fixture.controller.captureActivePost();
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("error"));
    expect(fixture.view.states.at(-1)).toMatchObject({
      failure: { action: "cleanup", code: "registry_invalid" },
    });
    expect((await fixture.registry.find(DIGEST))?.state).toBe("reviewing");
  });

  it("marks a submitted result indeterminate when preference provenance mismatches", async () => {
    const fixture = setup();
    fixture.api.create.mockResolvedValue({
      replayed: false,
      value: { ...drafted, relationshipLevel: "polite" },
    });
    await fixture.controller.captureActivePost();
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("error"));
    expect(fixture.view.states.at(-1)).toMatchObject({
      failure: { action: "replace", code: "generation_indeterminate" },
    });
    expect((await fixture.registry.find(DIGEST))?.state).toBe("indeterminate");
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

  it("regenerates directly with a fresh key and unchanged captured content", async () => {
    const fixture = setup();
    await extractAndGenerate(fixture.view, fixture.controller);
    const firstKey = fixture.api.create.mock.calls[0]?.[1];
    const regenerated: Recommendation = {
      ...drafted,
      id: "00000000-0000-4000-8000-000000000080",
    };
    fixture.api.create.mockResolvedValueOnce({ replayed: false, value: regenerated });

    fixture.view.actions?.regenerate();
    await vi.waitFor(() =>
      expect(
        fixture.view.states.at(-1)?.kind === "review" &&
          "recommendation" in (fixture.view.states.at(-1) ?? {})
          ? (fixture.view.states.at(-1) as Extract<PanelState, { kind: "review" }>).recommendation
              .id
          : null,
      ).toBe(regenerated.id),
    );
    expect(fixture.api.create).toHaveBeenCalledTimes(2);
    expect(fixture.api.create.mock.calls[1]?.[0]).toEqual(fixture.api.create.mock.calls[0]?.[0]);
    expect(fixture.api.create.mock.calls[1]?.[1]).not.toBe(firstKey);
  });

  it("returns to Preview without another API request when the article changed", async () => {
    const changedFrames: readonly FrameExecution[] = [
      {
        frameId: 0,
        result: {
          ...(frames[0]?.result ?? {}),
          body: "수정된 합성 본문으로 digest가 달라졌습니다.",
        } as FrameExecution["result"],
      },
    ];
    const gateway = new Gateway();
    gateway.captureAllFrames = vi
      .fn<() => Promise<readonly FrameExecution[]>>()
      .mockResolvedValueOnce(frames)
      .mockResolvedValueOnce(changedFrames);
    const fixture = setup({
      digest: vi.fn(async (payload) =>
        payload.body.startsWith("수정된") ? "b".repeat(64) : DIGEST,
      ),
      gateway,
    });
    await extractAndGenerate(fixture.view, fixture.controller);

    fixture.view.actions?.regenerate();

    await vi.waitFor(() =>
      expect(fixture.view.states.at(-1)).toMatchObject({
        kind: "preview",
        preferenceNotice: expect.stringContaining("글 내용이 달라져"),
      }),
    );
    expect(fixture.api.create).toHaveBeenCalledOnce();
  });

  it("preserves the original registry entry when regenerated preferences change digest", async () => {
    const otherDigest = "b".repeat(64);
    const fixture = setup({
      digest: vi.fn(async (payload) => (payload.comment_length === "long" ? otherDigest : DIGEST)),
    });
    await extractAndGenerate(fixture.view, fixture.controller);
    fixture.api.create.mockResolvedValueOnce({
      replayed: false,
      value: { ...drafted, commentLength: "long", id: "00000000-0000-4000-8000-000000000081" },
    });

    fixture.view.actions?.changeOptions();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("preview"));
    fixture.view.actions?.changeCommentLength("long");
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));

    expect(await fixture.registry.find(DIGEST)).toMatchObject({
      recommendationId: drafted.id,
      state: "reviewing",
    });
    expect(await fixture.registry.find(otherDigest)).toMatchObject({
      recommendationId: "00000000-0000-4000-8000-000000000081",
      state: "reviewing",
    });
  });

  it("clears regeneration intent on navigation and restores without a fresh POST", async () => {
    const fixture = setup();
    fixture.controller.start();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("preview"));
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));
    fixture.view.actions?.changeOptions();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("preview"));
    fixture.gateway.invalidation?.({ kind: "updated", tabId: tab.id });
    expect(fixture.view.states.at(-1)).toEqual({ failure: { code: "stale_page" }, kind: "error" });

    await fixture.controller.captureActivePost();
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));
    expect(fixture.api.create).toHaveBeenCalledOnce();
    expect(fixture.api.get).toHaveBeenCalledWith(drafted.id, expect.any(AbortSignal));
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

  it("binds a queue post to one final approval and renders persisted engagement results", async () => {
    const token: EngagementApprovalToken = {
      details: {
        comment: "사용자가 다듬은 합성 댓글",
        sourceUrl: tab.url,
        steps: ["like", "comment"],
        title: tab.title,
      },
      id: "00000000-0000-4000-8000-000000000076",
    };
    const approval = {
      cancelPendingApproval: vi.fn(),
      requestApproval: vi.fn(async () => token),
    };
    const completedRun: EngagementRun = {
      approvalId: token.id,
      createdAt: "2026-07-28T00:00:00Z",
      discoveryPostId: discoveryPost.id,
      id: "00000000-0000-4000-8000-000000000077",
      recommendationId: drafted.id,
      source: "neighbor",
      state: "succeeded",
      steps: [
        {
          name: "like",
          position: 0,
          resultCode: "clicked",
          state: "succeeded",
          updatedAt: "2026-07-28T00:00:01Z",
        },
        {
          name: "comment",
          position: 1,
          resultCode: "submitted",
          state: "succeeded",
          updatedAt: "2026-07-28T00:00:02Z",
        },
      ],
      updatedAt: "2026-07-28T00:00:02Z",
    };
    let finishEngagement:
      | ((result: { code: string; run: EngagementRun; status: "completed" }) => void)
      | undefined;
    const engagement = {
      execute: vi.fn(
        () =>
          new Promise<EngagementExecutionResult>((resolve) => {
            finishEngagement = resolve;
          }),
      ),
    };
    const fixture = setup({ approval, engagement });
    await fixture.controller.captureDiscoveryPost(discoveryPost, tab.id);
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));
    const selected = candidates[0];
    if (selected === undefined) throw new Error("Synthetic candidate missing");
    fixture.view.actions?.select(selected.id);
    fixture.view.actions?.edit("사용자가 다듬은 합성 댓글");
    fixture.view.actions?.approve();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("approved"));
    fixture.api.get.mockResolvedValue({
      ...drafted,
      editedComment: "사용자가 다듬은 합성 댓글",
      reviewStatus: "completed",
      selectedCandidateId: selected.id,
    });

    fixture.view.actions?.engage();

    await vi.waitFor(() => expect(engagement.execute).toHaveBeenCalledOnce());
    fixture.gateway.invalidation?.({ kind: "activated", tabId: 99 });
    expect(fixture.view.states.at(-1)?.kind).toBe("engaging");
    finishEngagement?.({
      code: "engagement_completed",
      run: completedRun,
      status: "completed",
    });
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("completed"));
    expect(approval.requestApproval).toHaveBeenCalledWith({
      comment: "사용자가 다듬은 합성 댓글",
      sourceUrl: tab.url,
      steps: ["like", "comment"],
      title: tab.title,
    });
    expect(engagement.execute).toHaveBeenCalledWith({
      discoveryPost,
      recommendation: expect.objectContaining({
        editedComment: "사용자가 다듬은 합성 댓글",
        reviewStatus: "approved",
      }),
      tabId: tab.id,
      tokenId: token.id,
    });
    expect(fixture.view.states.at(-1)).toMatchObject({
      discoveryPost: { id: discoveryPost.id },
      engagementRun: { id: completedRun.id, state: "succeeded" },
      notice: expect.stringContaining("완료"),
    });
  });

  it("does not offer automatic execution for a recommendation opened outside the queue", async () => {
    const approval = {
      cancelPendingApproval: vi.fn(),
      requestApproval: vi.fn(),
    };
    const engagement = { execute: vi.fn() };
    const fixture = setup({ approval, engagement });
    await extractAndGenerate(fixture.view, fixture.controller);
    const selected = candidates[0];
    if (selected === undefined) throw new Error("Synthetic candidate missing");
    fixture.view.actions?.select(selected.id);
    fixture.view.actions?.approve();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("approved"));

    fixture.view.actions?.engage();

    expect(fixture.view.states.at(-1)).toMatchObject({
      kind: "approved",
      notice: expect.stringContaining("탐색 대기열"),
    });
    expect(approval.requestApproval).not.toHaveBeenCalled();
    expect(engagement.execute).not.toHaveBeenCalled();
  });

  it("keeps manual generation available when the opened page differs from the queue item", async () => {
    const fixture = setup();

    await fixture.controller.captureDiscoveryPost(
      { ...discoveryPost, sourceUrl: "https://blog.naver.com/synthetic/other" },
      tab.id,
    );

    expect(fixture.view.states.at(-1)).toMatchObject({
      kind: "preview",
      preferenceNotice: expect.stringContaining("자동 실행 연결을 해제"),
    });
    await fixture.controller.captureDiscoveryPost(discoveryPost, 99);
    expect(fixture.view.states.at(-1)).toMatchObject({
      kind: "preview",
      preferenceNotice: expect.stringContaining("자동 실행 연결을 해제"),
    });
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));
    expect(fixture.api.create).toHaveBeenCalledOnce();
  });

  it("keeps automatic execution linked across equivalent Naver post URL shapes", async () => {
    const fixture = setup();

    await fixture.controller.captureDiscoveryPost(
      {
        ...discoveryPost,
        sourceUrl: "https://blog.naver.com/PostView.naver?blogId=synthetic&logNo=7&redirect=Dlog",
      },
      tab.id,
    );

    expect(fixture.view.states.at(-1)).toMatchObject({ kind: "preview" });
    expect(fixture.view.states.at(-1)).not.toMatchObject({
      preferenceNotice: expect.stringContaining("자동 실행 연결을 해제"),
    });
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));
    expect(fixture.view.states.at(-1)).toMatchObject({
      discoveryPost: { id: discoveryPost.id },
      kind: "review",
    });
  });

  it("keeps the approved fallback when final engagement confirmation is cancelled", async () => {
    const approval = {
      cancelPendingApproval: vi.fn(),
      requestApproval: vi.fn(async () => null),
    };
    const engagement = { execute: vi.fn() };
    const fixture = setup({ approval, engagement });
    await fixture.controller.captureDiscoveryPost(discoveryPost, tab.id);
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));
    const selected = candidates[0];
    if (selected === undefined) throw new Error("Synthetic candidate missing");
    fixture.view.actions?.select(selected.id);
    fixture.view.actions?.approve();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("approved"));

    fixture.view.actions?.engage();

    await vi.waitFor(() =>
      expect(fixture.view.states.at(-1)).toMatchObject({
        kind: "approved",
        notice: expect.stringContaining("최종 확인"),
      }),
    );
    expect(engagement.execute).not.toHaveBeenCalled();
  });

  it("shows a failed first step without completing the approved recommendation", async () => {
    const token: EngagementApprovalToken = {
      details: {
        comment: candidates[0]?.comment ?? "",
        sourceUrl: tab.url,
        steps: ["like", "comment"],
        title: tab.title,
      },
      id: "00000000-0000-4000-8000-000000000078",
    };
    const failedRun: EngagementRun = {
      approvalId: token.id,
      createdAt: "2026-07-28T00:00:00Z",
      discoveryPostId: discoveryPost.id,
      id: "00000000-0000-4000-8000-000000000079",
      recommendationId: drafted.id,
      source: "neighbor",
      state: "failed",
      steps: [
        {
          name: "like",
          position: 0,
          resultCode: "state_unknown",
          state: "failed",
          updatedAt: "2026-07-28T00:00:01Z",
        },
        {
          name: "comment",
          position: 1,
          resultCode: null,
          state: "pending",
          updatedAt: "2026-07-28T00:00:00Z",
        },
      ],
      updatedAt: "2026-07-28T00:00:01Z",
    };
    const fixture = setup({
      approval: {
        cancelPendingApproval: vi.fn(),
        requestApproval: vi.fn(async () => token),
      },
      engagement: {
        execute: vi.fn(async () => ({
          code: "state_unknown",
          run: failedRun,
          status: "failed" as const,
        })),
      },
    });
    await fixture.controller.captureDiscoveryPost(discoveryPost, tab.id);
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));
    const selected = candidates[0];
    if (selected === undefined) throw new Error("Synthetic candidate missing");
    fixture.view.actions?.useEdited();
    fixture.view.actions?.select(selected.id);
    fixture.view.actions?.approve();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("approved"));

    fixture.view.actions?.engage();

    await vi.waitFor(() =>
      expect(fixture.view.states.at(-1)).toMatchObject({
        engagementRun: { id: failedRun.id, state: "failed" },
        kind: "approved",
        notice: expect.stringContaining("중단"),
      }),
    );
    expect(fixture.api.get).not.toHaveBeenCalled();
  });

  it("approves and fills a candidate through the two-click quick flow", async () => {
    const fill = vi.fn(async (): Promise<CommentInputResult> => "filled");
    const fixture = setup({ commentInput: { fill } });
    await extractAndGenerate(fixture.view, fixture.controller);
    const selected = candidates[0];
    if (selected === undefined) throw new Error("Synthetic candidate missing");

    fixture.view.actions?.useCandidate(selected.id);

    await vi.waitFor(() => expect(fill).toHaveBeenCalledWith(tab.id, selected.comment));
    expect(fixture.api.review).toHaveBeenCalledWith(
      drafted.id,
      {
        edited_comment: selected.comment,
        review_status: "approved",
        selected_candidate_id: selected.id,
      },
      expect.any(AbortSignal),
    );
    expect(fixture.view.states.at(-1)).toMatchObject({
      kind: "approved",
      notice: expect.stringContaining("입력란에 초안을"),
    });
  });

  it("applies a local-only closing phrase without adding it to the generation request", async () => {
    const fill = vi.fn(async (): Promise<CommentInputResult> => "filled");
    const fixture = setup({ commentInput: { fill } });
    await fixture.controller.captureActivePost();
    fixture.view.actions?.changeClosingPhrase("  오늘도   좋은 하루 보내세요!  ");
    fixture.view.actions?.generate();
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("review"));
    const selected = candidates[0];
    if (selected === undefined) throw new Error("Synthetic candidate missing");

    fixture.view.actions?.useCandidate(selected.id);

    const personalized = `${selected.comment} 오늘도 좋은 하루 보내세요!`;
    await vi.waitFor(() => expect(fill).toHaveBeenCalledWith(tab.id, personalized));
    expect(JSON.stringify(fixture.api.create.mock.calls[0]?.[0])).not.toContain("좋은 하루");
    expect(fixture.api.review).toHaveBeenCalledWith(
      drafted.id,
      {
        edited_comment: personalized,
        review_status: "approved",
        selected_candidate_id: selected.id,
      },
      expect.any(AbortSignal),
    );
  });

  it("keeps the approved comment available when safe page insertion is unavailable", async () => {
    const fill = vi.fn(async (): Promise<CommentInputResult> => "occupied");
    const fixture = setup({ commentInput: { fill } });
    await extractAndGenerate(fixture.view, fixture.controller);

    fixture.view.actions?.useCandidate(candidates[1]?.id ?? "");

    await vi.waitFor(() =>
      expect(fixture.view.states.at(-1)).toMatchObject({
        kind: "approved",
        notice: expect.stringContaining("덮어쓰지 않았습니다"),
      }),
    );
    expect(fixture.view.states.at(-1)).toMatchObject({ editedComment: candidates[1]?.comment });
  });

  it("retries page insertion for the approved comment without another review request", async () => {
    const fill = vi
      .fn<() => Promise<CommentInputResult>>()
      .mockResolvedValueOnce("not_found")
      .mockResolvedValueOnce("filled");
    const fixture = setup({ commentInput: { fill } });
    await extractAndGenerate(fixture.view, fixture.controller);

    fixture.view.actions?.useCandidate(candidates[1]?.id ?? "");
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("approved"));
    fixture.view.actions?.refill();

    await vi.waitFor(() => expect(fill).toHaveBeenCalledTimes(2));
    expect(fixture.api.review).toHaveBeenCalledOnce();
    expect(fixture.view.states.at(-1)).toMatchObject({
      kind: "approved",
      notice: expect.stringContaining("입력란에 초안을"),
    });
  });

  it("keeps copy fallback guidance when retrying approved page insertion fails", async () => {
    const fill = vi
      .fn<() => Promise<CommentInputResult>>()
      .mockResolvedValueOnce("filled")
      .mockRejectedValueOnce(new Error("synthetic injection failure"));
    const fixture = setup({ commentInput: { fill } });
    await extractAndGenerate(fixture.view, fixture.controller);

    fixture.view.actions?.useCandidate(candidates[1]?.id ?? "");
    await vi.waitFor(() => expect(fixture.view.states.at(-1)?.kind).toBe("approved"));
    fixture.view.actions?.refill();

    await vi.waitFor(() =>
      expect(fixture.view.states.at(-1)).toMatchObject({
        kind: "approved",
        notice: expect.stringContaining("복사해서 붙여넣어"),
      }),
    );
    expect(fixture.api.review).toHaveBeenCalledOnce();
  });

  it("explains when the comment editor could not be opened", async () => {
    const fill = vi.fn(async (): Promise<CommentInputResult> => "open_failed");
    const fixture = setup({ commentInput: { fill } });
    await extractAndGenerate(fixture.view, fixture.controller);

    fixture.view.actions?.useCandidate(candidates[1]?.id ?? "");

    await vi.waitFor(() =>
      expect(fixture.view.states.at(-1)).toMatchObject({
        kind: "approved",
        notice: expect.stringContaining("댓글 쓰기를 열었지만"),
      }),
    );
    expect(fixture.view.states.at(-1)).toMatchObject({ editedComment: candidates[1]?.comment });
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

  it("does not resume initialization after navigation while length storage is pending", async () => {
    let resolveLoad: ((value: Record<string, unknown>) => void) | undefined;
    const lengthStore = new CommentLengthPreferenceStore({
      get: () => new Promise((resolve) => (resolveLoad = resolve)),
      set: async () => undefined,
    });
    const fixture = setup({ lengthStore });
    fixture.controller.start();
    fixture.gateway.invalidation?.({ kind: "activated", tabId: 99 });
    resolveLoad?.({});
    await Promise.resolve();
    await Promise.resolve();

    expect(fixture.view.states.at(-1)).toEqual({
      failure: { code: "stale_page" },
      kind: "error",
    });
  });

  it("does not render or capture after disposal while length storage is pending", async () => {
    let resolveLoad: ((value: Record<string, unknown>) => void) | undefined;
    const lengthStore = new CommentLengthPreferenceStore({
      get: () => new Promise((resolve) => (resolveLoad = resolve)),
      set: async () => undefined,
    });
    const fixture = setup({ lengthStore });
    fixture.controller.start();
    fixture.controller.dispose();
    resolveLoad?.({});
    await Promise.resolve();
    await Promise.resolve();

    expect(fixture.view.states).toEqual([]);
  });
});
