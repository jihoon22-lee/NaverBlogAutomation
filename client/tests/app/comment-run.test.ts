import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunStreamFactory, RunStreamHandlers } from "../../src/app/api/run-stream";
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
  selectedCandidateId: null,
  editedComment: null,
  reviewStatus: "drafted",
  relationshipLevel: "friendly",
  speechStyle: "honorific",
  commentLength: "medium",
  commentMood: "warm",
  qualityWarnings: [],
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
    reviewRecommendation: vi.fn(async () => ({
      ...RECOMMENDATION,
      reviewStatus: "approved" as const,
      selectedCandidateId: "c1",
      editedComment: "따뜻한 후보",
    })),
  } as never;
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
});
