import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunStreamFactory, RunStreamHandlers } from "../../src/app/api/run-stream";
import { ApiError } from "../../src/app/api/client";
import type {
  ArticleExtraction,
  CommentGeneration,
  EngagementRun,
  Recommendation,
} from "../../src/app/api/types";
import { CommentController } from "../../src/app/controllers/comment";
import { RunController } from "../../src/app/controllers/run";

const POST_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

const EXTRACTION: ArticleExtraction = {
  sourceUrl: "https://blog.naver.com/example/223456789012",
  title: "합성 제목",
  selectorKind: "modern",
  originalLength: 120,
  transmittedLength: 120,
  truncated: false,
  preview: "합성 본문",
};

const RECOMMENDATION: Recommendation = {
  id: "22222222-2222-4222-8222-222222222222",
  sourceUrl: EXTRACTION.sourceUrl,
  title: "합성 제목",
  summary: "합성 요약",
  topics: ["전시"],
  candidates: [
    { id: "c1", tone: "warm", comment: "따뜻한 후보", referencedDetail: "근거1" },
    { id: "c2", tone: "curious", comment: "궁금한 후보?", referencedDetail: "근거2" },
    { id: "c3", tone: "supportive", comment: "응원하는 후보", referencedDetail: "근거3" },
  ],
  createdAt: "2026-08-08T00:00:00Z",
  updatedAt: null,
  selectedCandidateId: null,
  editedComment: null,
  reviewStatus: "drafted",
  relationshipLevel: "friendly",
  speechStyle: "honorific",
  commentLength: "medium",
  commentMood: "warm",
  qualityWarnings: [],
  personalizationApplied: false,
  personalizationMode: "off",
  personalizationSampleCount: 0,
  personalizationEligible: true,
};

const GENERATION: CommentGeneration = {
  attempt: 1,
  extraction: EXTRACTION,
  recommendation: RECOMMENDATION,
  replayed: false,
};

const RUN: EngagementRun = {
  id: RUN_ID,
  approvalId: "44444444-4444-4444-8444-444444444444",
  discoveryPostId: POST_ID,
  recommendationId: RECOMMENDATION.id,
  source: "neighbor",
  state: "running",
  steps: [
    { name: "like", position: 0, state: "pending", resultCode: null, updatedAt: "2026-07-31" },
    { name: "comment", position: 1, state: "pending", resultCode: null, updatedAt: "2026-07-31" },
  ],
  createdAt: "2026-07-31",
  updatedAt: "2026-07-31",
};

class FakeStream {
  handlers: RunStreamHandlers | null = null;
  closes = 0;

  readonly factory: RunStreamFactory = (_url, handlers) => {
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

function commentApi() {
  return {
    appSetting: vi.fn(async () => ({
      kind: "closing_phrase",
      schemaVersion: 1,
      payload: { phrase: "" },
      updatedAt: null,
    })),
    generateComment: vi.fn(async () => GENERATION),
    generateCommentFanout: vi.fn(async () => ({
      attempt: 1,
      extraction: EXTRACTION,
      items: [
        {
          provider: "openai" as const,
          model: "gpt-test",
          status: "succeeded" as const,
          resultCode: null,
          replayed: false,
          retryAfter: null,
          recommendation: RECOMMENDATION,
        },
      ],
    })),
    llmProviders: vi.fn(async () => [
      { provider: "openai" as const, configured: true, model: "gpt-test" },
    ]),
    recommendation: vi.fn(async () => RECOMMENDATION),
    refineRecommendation: vi.fn(async () => ({
      text: "더 자연스러운 댓글",
      provider: "openai" as const,
      model: "gpt-test",
    })),
    reviewRecommendation: vi.fn(async () => ({
      ...RECOMMENDATION,
      reviewStatus: "approved" as const,
      selectedCandidateId: "c1",
      editedComment: "따뜻한 후보",
    })),
  } as never;
}

type MutableCommentApi = {
  appSetting: ReturnType<typeof vi.fn>;
  generateComment: ReturnType<typeof vi.fn>;
  generateCommentFanout: ReturnType<typeof vi.fn>;
  llmProviders: ReturnType<typeof vi.fn>;
  recommendation: ReturnType<typeof vi.fn>;
  refineRecommendation: ReturnType<typeof vi.fn>;
  reviewRecommendation: ReturnType<typeof vi.fn>;
};

function mutableCommentApi(overrides: Partial<MutableCommentApi> = {}): MutableCommentApi {
  return {
    ...(commentApi() as unknown as MutableCommentApi),
    ...overrides,
  };
}

function runApi() {
  return {
    completeEngagementManually: vi.fn(async () => RUN),
    engagementRun: vi.fn(async () => ({ ...RUN, state: "succeeded" as const })),
    engagementRunEventsUrl: (id: string) => `/api/v1/automation/engagement-runs/${id}/events`,
    startEngagementRun: vi.fn(async () => RUN),
  } as never;
}

describe("comment workspace execution", () => {
  let root: HTMLElement;
  let stream: FakeStream;
  let controller: CommentController;
  let client: ReturnType<typeof runApi>;

  beforeEach(() => {
    document.body.textContent = "";
    root = document.createElement("main");
    document.body.append(root);
    stream = new FakeStream();
    client = runApi();
    controller = new CommentController(root, {
      api: commentApi(),
      run: new RunController({ api: client, stream: stream.factory }),
    });
    controller.run;
  });

  function rerender(): void {
    controller.render();
  }

  it("shows one final action before approval and keeps retry separate after a refusal", async () => {
    controller.open(EXTRACTION, POST_ID, "neighbor");
    await controller.generate();

    expect(document.getElementById("execute-comment-button")).not.toBeNull();
    expect(document.getElementById("run-button")).toBeNull();

    await controller.approve();
    rerender();

    expect(document.getElementById("run-button")).toBeNull();
  });

  it("approves and starts one run from a single final click", async () => {
    controller.open(EXTRACTION, POST_ID, "neighbor");
    await controller.generate();

    (document.getElementById("execute-comment-button") as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(
      (client as unknown as { startEngagementRun: { mock: { calls: unknown[][] } } })
        .startEngagementRun.mock.calls[0],
    ).toEqual([POST_ID, RECOMMENDATION.id]);
  });

  it("does not execute without a queued post identifier", async () => {
    controller.open(EXTRACTION);
    await controller.generate();
    await controller.approve();

    await controller.startRun();

    expect(
      (client as unknown as { startEngagementRun: { mock: { calls: unknown[][] } } })
        .startEngagementRun.mock.calls,
    ).toHaveLength(0);
  });

  it("renders streamed step results in the panel", async () => {
    controller.open(EXTRACTION, POST_ID, "neighbor");
    await controller.generate();
    await controller.approve();
    await controller.startRun();

    stream.emit("step_completed", {
      step: "comment",
      state: "succeeded",
      result_code: "comment_published",
    });

    const step = root.querySelector('[data-step="comment"]');
    expect(step?.getAttribute("data-state")).toBe("succeeded");
    expect(step?.textContent).toContain("댓글을 등록했습니다.");
  });

  it("forgets the previous run when another post opens", async () => {
    controller.open(EXTRACTION, POST_ID, "neighbor");
    await controller.generate();
    await controller.approve();
    await controller.startRun();

    controller.open(EXTRACTION, POST_ID);

    expect(controller.run.state.phase).toBe("idle");
    expect(stream.closes).toBe(1);
  });

  it("keeps optional comment settings safe and uses the configured provider for refinement", async () => {
    const client = mutableCommentApi({
      appSetting: vi.fn(async (kind: string) => {
        if (kind === "closing_phrase") throw new ApiError("missing", { status: 404 });
        throw new Error("paired client");
      }),
      llmProviders: vi.fn(async () => [
        { provider: "openai" as const, configured: false, model: "gpt-test" },
        { provider: "gemini" as const, configured: true, model: "gemini-test" },
      ]),
    });
    const nextController = new CommentController(root, { api: client as never });

    await nextController.loadClosingPhrase();
    nextController.open(EXTRACTION);
    await nextController.generate();
    await nextController.refine("natural", "");

    expect(nextController.state.closingPhrase).toBe("");
    expect(nextController.state.neighborMessage).toBe("");
    expect(nextController.state.configuredProviders).toHaveLength(2);
    expect(client.refineRecommendation).toHaveBeenCalledWith(
      RECOMMENDATION.id,
      expect.objectContaining({ provider: "gemini" }),
    );
  });

  it("refreshes an active run after returning from a backgrounded browser", async () => {
    const runClient = runApi() as unknown as {
      engagementRun: ReturnType<typeof vi.fn>;
    };
    const run = new RunController({ api: runClient as never, stream: stream.factory });
    const nextController = new CommentController(root, { api: commentApi(), run });
    nextController.open(EXTRACTION, POST_ID, "neighbor");
    await nextController.generate();
    await nextController.approve();
    await nextController.startRun();

    await nextController.refresh();

    expect(runClient.engagementRun).toHaveBeenCalledWith(RUN_ID);
    expect(nextController.run.state.phase).toBe("finished");
  });

  it("starts generation immediately when opening a direct URL or opting into generation", async () => {
    const onRecommendationReady = vi.fn();
    const client = mutableCommentApi();
    const nextController = new CommentController(root, {
      api: client as never,
      onRecommendationReady,
    });

    nextController.openUrl(EXTRACTION.sourceUrl, POST_ID, "search");
    await vi.waitFor(() => expect(client.generateComment).toHaveBeenCalledOnce());
    expect(nextController.state.phase).toBe("review");
    expect(nextController.state.source).toBe("search");

    nextController.open(EXTRACTION, POST_ID, "neighbor", { generate: true });
    await vi.waitFor(() => expect(client.generateComment).toHaveBeenCalledTimes(2));
    expect(onRecommendationReady).toHaveBeenCalledTimes(2);
  });

  it("re-appends a saved closing phrase without duplicating it", async () => {
    const client = mutableCommentApi({
      appSetting: vi.fn(async (kind: string) => ({
        kind,
        schemaVersion: 1,
        payload: kind === "closing_phrase" ? { phrase: "감사합니다" } : { message: "" },
        updatedAt: null,
      })),
    });
    const nextController = new CommentController(root, { api: client as never });
    nextController.open(EXTRACTION);
    await nextController.loadClosingPhrase();
    await nextController.generate();

    nextController.applyClosingPhrase();
    const first = nextController.state.draft;
    nextController.applyClosingPhrase();

    expect(first).toBe("따뜻한 후보 감사합니다");
    expect(nextController.state.draft).toBe(first);
  });

  it("keeps a restore failure visible with the service error detail", async () => {
    const client = mutableCommentApi({
      recommendation: vi.fn(async () => {
        throw new ApiError("추천을 찾을 수 없습니다.", { status: 404 });
      }),
    });
    const nextController = new CommentController(root, { api: client as never });

    await nextController.restore(RECOMMENDATION.id, POST_ID, "neighbor");

    expect(nextController.state.phase).toBe("failed");
    expect(nextController.state.error).toBe("추천을 찾을 수 없습니다.");
  });

  it("ignores a late restore response after the user opens a fresh post", async () => {
    let resolveRecommendation!: (recommendation: Recommendation) => void;
    const client = mutableCommentApi({
      recommendation: vi.fn(
        () => new Promise<Recommendation>((resolve) => (resolveRecommendation = resolve)),
      ),
    });
    const nextController = new CommentController(root, { api: client as never });
    const restoring = nextController.restore(RECOMMENDATION.id, POST_ID, "neighbor");
    nextController.open({ ...EXTRACTION, title: "새 글" }, POST_ID, "neighbor");
    resolveRecommendation(RECOMMENDATION);

    await restoring;

    expect(nextController.state.extraction?.title).toBe("새 글");
    expect(nextController.state.recommendation).toBeNull();
    expect(nextController.state.phase).toBe("preview");
  });

  it("does not compare providers until at least two providers are configured", async () => {
    const client = mutableCommentApi();
    const nextController = new CommentController(root, { api: client as never });
    nextController.open(EXTRACTION);

    await nextController.compareProviders();

    expect(client.generateCommentFanout).not.toHaveBeenCalled();
    expect(nextController.state.phase).toBe("preview");
  });

  it("surfaces a provider comparison refusal without retrying the fan-out", async () => {
    const client = mutableCommentApi({
      llmProviders: vi.fn(async () => [
        { provider: "openai" as const, configured: true, model: "gpt-test" },
        { provider: "gemini" as const, configured: true, model: "gemini-test" },
      ]),
      generateCommentFanout: vi.fn(async () => {
        throw new ApiError("comparison failed", {
          problem: {
            code: "provider_unavailable",
            detail: "비교 provider를 사용할 수 없습니다.",
          } as never,
          status: 503,
        });
      }),
    });
    const nextController = new CommentController(root, { api: client as never });
    await nextController.loadClosingPhrase();
    nextController.open(EXTRACTION);

    await nextController.compareProviders();

    expect(nextController.state.phase).toBe("failed");
    expect(nextController.state.error).toBe("비교 provider를 사용할 수 없습니다.");
    expect(client.generateCommentFanout).toHaveBeenCalledOnce();
  });

  it("ignores a late provider comparison after another post opens", async () => {
    let resolveFanout!: (value: {
      attempt: number;
      extraction: ArticleExtraction;
      items: never[];
    }) => void;
    const onRecommendationReady = vi.fn();
    const client = mutableCommentApi({
      llmProviders: vi.fn(async () => [
        { provider: "openai" as const, configured: true, model: "gpt-test" },
        { provider: "gemini" as const, configured: true, model: "gemini-test" },
      ]),
      generateCommentFanout: vi.fn(
        () =>
          new Promise<{ attempt: number; extraction: ArticleExtraction; items: never[] }>(
            (resolve) => (resolveFanout = resolve),
          ),
      ),
    });
    const nextController = new CommentController(root, {
      api: client as never,
      onRecommendationReady,
    });
    await nextController.loadClosingPhrase();
    nextController.open(EXTRACTION, POST_ID, "neighbor");
    const comparing = nextController.compareProviders();
    nextController.open({ ...EXTRACTION, title: "두 번째 글" }, POST_ID, "neighbor");
    resolveFanout({ attempt: 1, extraction: EXTRACTION, items: [] });

    await comparing;

    expect(nextController.state.extraction?.title).toBe("두 번째 글");
    expect(nextController.state.recommendation).toBeNull();
    expect(onRecommendationReady).not.toHaveBeenCalled();
  });

  it("does not send a duplicate approval while the first review is pending", async () => {
    let resolveReview!: (recommendation: Recommendation) => void;
    const client = mutableCommentApi({
      reviewRecommendation: vi.fn(
        () => new Promise<Recommendation>((resolve) => (resolveReview = resolve)),
      ),
    });
    const nextController = new CommentController(root, { api: client as never });
    nextController.open(EXTRACTION);
    await nextController.generate();

    const first = nextController.approve();
    const second = nextController.approve();
    expect(client.reviewRecommendation).toHaveBeenCalledOnce();
    resolveReview({ ...RECOMMENDATION, reviewStatus: "approved", selectedCandidateId: "c1" });

    expect(await second).toBeNull();
    expect(await first).toMatchObject({ reviewStatus: "approved" });
  });

  it("preserves the latest candidate selection while an earlier approval is in flight", async () => {
    let resolveReview!: (recommendation: Recommendation) => void;
    const client = mutableCommentApi({
      reviewRecommendation: vi.fn(
        () => new Promise<Recommendation>((resolve) => (resolveReview = resolve)),
      ),
    });
    const nextController = new CommentController(root, { api: client as never });
    nextController.open(EXTRACTION);
    await nextController.generate();

    const approving = nextController.approve();
    root.querySelector<HTMLButtonElement>('[data-candidate-id="c2"]')?.click();
    resolveReview({ ...RECOMMENDATION, reviewStatus: "approved", selectedCandidateId: "c1" });
    await approving;

    expect(client.reviewRecommendation).toHaveBeenCalledWith(
      RECOMMENDATION.id,
      expect.objectContaining({ selectedCandidateId: "c1" }),
    );
    expect(nextController.state.selectedCandidateId).toBe("c2");
    expect(nextController.state.draft).toBe("궁금한 후보?");
  });

  it("executes an already approved recommendation without reviewing it again", async () => {
    const runClient = runApi() as unknown as {
      startEngagementRun: ReturnType<typeof vi.fn>;
    };
    const client = mutableCommentApi();
    const nextController = new CommentController(root, {
      api: client as never,
      run: new RunController({ api: runClient as never, stream: stream.factory }),
    });
    nextController.open(EXTRACTION, POST_ID, "neighbor");
    await nextController.generate();
    await nextController.approve();
    await nextController.execute();

    expect(client.reviewRecommendation).toHaveBeenCalledOnce();
    expect(runClient.startEngagementRun).toHaveBeenCalledOnce();
  });

  it("does not start execution when approval fails", async () => {
    const runClient = runApi() as unknown as {
      startEngagementRun: ReturnType<typeof vi.fn>;
    };
    const client = mutableCommentApi({
      reviewRecommendation: vi.fn(async () => {
        throw new ApiError("review refused", {
          problem: { code: "review_conflict", detail: "검토 상태가 변경되었습니다." } as never,
          status: 409,
        });
      }),
    });
    const nextController = new CommentController(root, {
      api: client as never,
      run: new RunController({ api: runClient as never, stream: stream.factory }),
    });
    nextController.open(EXTRACTION, POST_ID, "neighbor");
    await nextController.generate();

    await nextController.execute();

    expect(nextController.state.error).toBe("검토 상태가 변경되었습니다.");
    expect(runClient.startEngagementRun).not.toHaveBeenCalled();
  });

  it("does not execute a direct comment without a discovery source", async () => {
    const runClient = runApi() as unknown as {
      startEngagementRun: ReturnType<typeof vi.fn>;
    };
    const nextController = new CommentController(root, {
      api: commentApi(),
      run: new RunController({ api: runClient as never, stream: stream.factory }),
    });
    nextController.open(EXTRACTION);
    await nextController.generate();
    await nextController.approve();

    await nextController.execute();

    expect(runClient.startEngagementRun).not.toHaveBeenCalled();
  });

  it("does not send duplicate refinement requests while the first one is pending", async () => {
    let resolveRefinement!: (value: { text: string; provider: "openai"; model: string }) => void;
    const client = mutableCommentApi({
      refineRecommendation: vi.fn(
        () =>
          new Promise<{ text: string; provider: "openai"; model: string }>(
            (resolve) => (resolveRefinement = resolve),
          ),
      ),
    });
    const nextController = new CommentController(root, { api: client as never });
    nextController.open(EXTRACTION);
    await nextController.generate();

    const first = nextController.refine("natural", "");
    const second = nextController.refine("natural", "");
    expect(client.refineRecommendation).toHaveBeenCalledOnce();
    resolveRefinement({ text: "다듬은 댓글", provider: "openai", model: "gpt-test" });

    await first;
    await second;
    expect(nextController.state.draft).toBe("다듬은 댓글");
  });

  it("sends a trimmed free-form refinement request without a preset", async () => {
    const client = mutableCommentApi();
    const nextController = new CommentController(root, { api: client as never });
    nextController.open(EXTRACTION);
    await nextController.generate();

    await nextController.refine(undefined, "  전시장의 색감을 더 구체적으로 언급해 주세요  ");

    expect(client.refineRecommendation).toHaveBeenCalledWith(
      RECOMMENDATION.id,
      expect.objectContaining({
        request: "전시장의 색감을 더 구체적으로 언급해 주세요",
        currentComment: "따뜻한 후보",
      }),
    );
    expect(client.refineRecommendation.mock.calls[0]?.[1]).not.toHaveProperty("preset");
  });

  it("ignores an empty free-form refinement instead of creating an API request", async () => {
    const client = mutableCommentApi();
    const nextController = new CommentController(root, { api: client as never });
    nextController.open(EXTRACTION);
    await nextController.generate();

    await nextController.refine(undefined, "   ");

    expect(client.refineRecommendation).not.toHaveBeenCalled();
    expect(nextController.state.refinementBusy).toBe(false);
  });

  it("does not apply a late approval response to a newly opened post", async () => {
    let resolveReview!: (recommendation: Recommendation) => void;
    const reviewRecommendation = vi.fn(
      () => new Promise<Recommendation>((resolve) => (resolveReview = resolve)),
    );
    const client = commentApi() as unknown as {
      reviewRecommendation: ReturnType<typeof vi.fn>;
    };
    client.reviewRecommendation = reviewRecommendation as never;
    const nextExtraction = { ...EXTRACTION, title: "새로 연 글" };
    const nextController = new CommentController(root, {
      api: client as never,
      run: new RunController({ api: runApi(), stream: stream.factory }),
    });
    nextController.open(EXTRACTION, POST_ID, "neighbor");
    await nextController.generate();

    const approval = nextController.approve();
    expect(reviewRecommendation).toHaveBeenCalledOnce();
    nextController.open(nextExtraction, POST_ID, "neighbor");
    resolveReview({ ...RECOMMENDATION, reviewStatus: "approved", selectedCandidateId: "c1" });

    expect(await approval).toBeNull();
    expect(nextController.state.extraction?.title).toBe("새로 연 글");
    expect(nextController.state.recommendation).toBeNull();
  });

  it("does not apply a late refinement response after the user opens another post", async () => {
    let resolveRefinement!: (value: { text: string; provider: "openai"; model: string }) => void;
    const refineRecommendation = vi.fn(
      () =>
        new Promise<{ text: string; provider: "openai"; model: string }>(
          (resolve) => (resolveRefinement = resolve),
        ),
    );
    const client = commentApi() as unknown as {
      refineRecommendation: ReturnType<typeof vi.fn>;
    };
    client.refineRecommendation = refineRecommendation as never;
    const nextController = new CommentController(root, {
      api: client as never,
      run: new RunController({ api: runApi(), stream: stream.factory }),
    });
    nextController.open(EXTRACTION, POST_ID, "neighbor");
    await nextController.generate();

    const refining = nextController.refine("natural", "");
    nextController.open({ ...EXTRACTION, title: "다른 글" }, POST_ID, "neighbor");
    resolveRefinement({ text: "늦게 도착한 댓글", provider: "openai", model: "gpt-test" });

    await refining;
    expect(nextController.state.extraction?.title).toBe("다른 글");
    expect(nextController.state.draft).toBe("");
  });

  it("keeps an execution refusal explicit instead of retrying automatically", async () => {
    const client = runApi() as unknown as {
      startEngagementRun: ReturnType<typeof vi.fn>;
    };
    client.startEngagementRun.mockRejectedValue(
      new ApiError("browser stopped", {
        problem: {
          code: "browser_session_not_running",
          detail: "브라우저가 실행되지 않았습니다.",
          status: 409,
          title: "Browser session required",
        },
        status: 409,
      }),
    );
    const controller = new CommentController(root, {
      api: commentApi(),
      run: new RunController({ api: client as never, stream: stream.factory }),
    });
    controller.open(EXTRACTION, POST_ID, "neighbor");
    await controller.generate();
    await controller.approve();

    await controller.startRun();

    expect(controller.run.state.phase).toBe("refused");
    expect(controller.run.state.error).toBe("설정에서 브라우저 세션을 먼저 실행하세요.");
    expect(client.startEngagementRun).toHaveBeenCalledOnce();
  });

  it("reports a generic refinement failure and creates an idempotency key without Web Crypto", async () => {
    const client = commentApi() as unknown as {
      refineRecommendation: ReturnType<typeof vi.fn>;
    };
    client.refineRecommendation = vi.fn(async () => {
      throw new Error("offline");
    });
    const controller = new CommentController(root, { api: client as never });
    controller.open(EXTRACTION);
    await controller.generate();
    vi.stubGlobal("crypto", undefined);

    await controller.refine("natural", "");

    expect(controller.state.refinementError).toBe("알 수 없는 오류가 발생했습니다.");
    const request = client.refineRecommendation.mock.calls[0]?.[1] as {
      idempotencyKey: string;
    };
    expect(request.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    vi.unstubAllGlobals();
  });
});
