import { describe, expect, it, vi } from "vitest";

import type {
  DiscoveryPost,
  EngagementRun,
  EngagementStepName,
  EngagementStepState,
  Recommendation,
} from "../../src/api/types";
import { EngagementApprovalSession } from "../../src/engagement/approval-session";
import { EngagementRunController } from "../../src/engagement/run-controller";

const timestamp = "2026-07-28T00:00:00Z";
const ids = {
  approval: "00000000-0000-4000-8000-000000000001",
  post: "00000000-0000-4000-8000-000000000002",
  recommendation: "00000000-0000-4000-8000-000000000003",
  run: "00000000-0000-4000-8000-000000000004",
};

const recommendation: Recommendation = {
  candidates: [
    {
      comment: "선택한 합성 댓글",
      id: "00000000-0000-4000-8000-000000000005",
      referencedDetail: "합성 본문",
      tone: "warm",
    },
  ],
  commentLength: "medium",
  commentMood: "warm",
  createdAt: timestamp,
  editedComment: "사용자가 최종 승인한 댓글",
  id: ids.recommendation,
  personalizationApplied: false,
  personalizationEligible: true,
  personalizationMode: "off",
  personalizationSampleCount: 0,
  qualityWarnings: [],
  relationshipLevel: "friendly",
  reviewStatus: "approved",
  selectedCandidateId: "00000000-0000-4000-8000-000000000005",
  sourceUrl: "https://blog.naver.com/candidate/123",
  speechStyle: "honorific",
  summary: "합성 요약",
  title: "합성 글",
  topics: ["합성"],
  updatedAt: timestamp,
};

function post(source: "neighbor" | "search" = "neighbor"): DiscoveryPost {
  return {
    createdAt: timestamp,
    id: ids.post,
    neighborId: source === "neighbor" ? "00000000-0000-4000-8000-000000000006" : null,
    publishedAt: timestamp,
    publisherBlogId: source === "search" ? "candidate" : null,
    publisherName: "합성 작성자",
    searchId: source === "search" ? "00000000-0000-4000-8000-000000000007" : null,
    source,
    sourceUrl: recommendation.sourceUrl,
    state: "opened",
    title: recommendation.title,
    updatedAt: timestamp,
  };
}

function createRun(source: "neighbor" | "search" = "neighbor"): EngagementRun {
  const names: EngagementStepName[] =
    source === "neighbor" ? ["like", "comment"] : ["like", "comment", "mutual_neighbor"];
  return {
    approvalId: ids.approval,
    createdAt: timestamp,
    discoveryPostId: ids.post,
    id: ids.run,
    recommendationId: ids.recommendation,
    source,
    state: "running",
    steps: names.map((name, position) => ({
      name,
      position,
      resultCode: null,
      state: "pending",
      updatedAt: timestamp,
    })),
    updatedAt: timestamp,
  };
}

function fakeApi(initial: EngagementRun) {
  let run = structuredClone(initial);
  const startEngagementRun = vi.fn(async () => ({ replayed: false, value: run }));
  const transitionEngagementStep = vi.fn(
    async (
      _runId: string,
      name: EngagementStepName,
      value: { state: EngagementStepState; resultCode?: string | null },
    ) => {
      run = {
        ...run,
        steps: run.steps.map((step) =>
          step.name === name
            ? {
                ...step,
                state: value.state,
                resultCode: value.resultCode ?? null,
              }
            : step,
        ),
      };
      run = {
        ...run,
        state: run.steps.some((step) => step.state === "unconfirmed")
          ? "unconfirmed"
          : run.steps.some((step) => step.state === "failed")
            ? "failed"
            : run.steps.every((step) => step.state === "succeeded" || step.state === "skipped")
              ? "succeeded"
              : "running",
      };
      return run;
    },
  );
  return { startEngagementRun, transitionEngagementStep };
}

function approvedSession(source: "neighbor" | "search") {
  const session = new EngagementApprovalSession(() => ids.approval);
  const token = session.issue({
    comment: recommendation.editedComment ?? "",
    ...(source === "search" ? { neighborMessage: "서로이웃으로 소통하고 싶어요." } : {}),
    sourceUrl: recommendation.sourceUrl,
    steps: source === "neighbor" ? ["like", "comment"] : ["like", "comment", "mutual_neighbor"],
    title: recommendation.title,
  });
  return { session, token };
}

describe("EngagementRunController", () => {
  it("executes one approved neighbor post in order and never repeats successful steps", async () => {
    const { session, token } = approvedSession("neighbor");
    const api = fakeApi(createRun());
    const likes = { like: vi.fn().mockResolvedValue("clicked") };
    const comments = { publish: vi.fn().mockResolvedValue("submitted") };
    const controller = new EngagementRunController(session, {
      api,
      likes,
      comments,
      mutualNeighbors: { request: vi.fn() },
    });

    await expect(
      controller.execute({
        discoveryPost: post(),
        recommendation,
        tabId: 7,
        tokenId: token.id,
      }),
    ).resolves.toMatchObject({ code: "engagement_completed", status: "completed" });
    expect(likes.like).toHaveBeenCalledWith(7);
    expect(comments.publish).toHaveBeenCalledWith(7, "사용자가 최종 승인한 댓글");
    expect(api.transitionEngagementStep.mock.calls.map((call) => [call[1], call[2].state])).toEqual(
      [
        ["like", "running"],
        ["like", "succeeded"],
        ["comment", "running"],
        ["comment", "succeeded"],
      ],
    );

    const second = approvedSession("neighbor");
    api.startEngagementRun.mockResolvedValueOnce({
      replayed: true,
      value: {
        ...createRun(),
        state: "succeeded",
        steps: createRun().steps.map((step) => ({
          ...step,
          state: "succeeded",
          resultCode: step.name === "like" ? "clicked" : "submitted",
        })),
      },
    });
    const resumed = new EngagementRunController(second.session, {
      api,
      likes,
      comments,
      mutualNeighbors: { request: vi.fn() },
    });
    await expect(
      resumed.execute({
        discoveryPost: post(),
        recommendation,
        tabId: 7,
        tokenId: second.token.id,
      }),
    ).resolves.toMatchObject({ code: "already_completed", status: "completed" });
    expect(likes.like).toHaveBeenCalledOnce();
    expect(comments.publish).toHaveBeenCalledOnce();
  });

  it("accepts equivalent queue and captured URL shapes for one approved post", async () => {
    const { session, token } = approvedSession("neighbor");
    const api = fakeApi(createRun());
    const likes = { like: vi.fn().mockResolvedValue("already_liked") };
    const comments = { publish: vi.fn().mockResolvedValue("submitted") };
    const controller = new EngagementRunController(session, {
      api,
      likes,
      comments,
      mutualNeighbors: { request: vi.fn() },
    });

    await expect(
      controller.execute({
        discoveryPost: {
          ...post(),
          sourceUrl:
            "https://blog.naver.com/PostView.naver?blogId=candidate&logNo=123&redirect=Dlog",
        },
        recommendation,
        tabId: 7,
        tokenId: token.id,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(likes.like).toHaveBeenCalledOnce();
    expect(comments.publish).toHaveBeenCalledOnce();
  });

  it("executes the search-only mutual-neighbor step with the exact approved message", async () => {
    const { session, token } = approvedSession("search");
    const api = fakeApi(createRun("search"));
    const mutualNeighbors = {
      request: vi.fn().mockResolvedValue({ code: "already_mutual" }),
    };
    const controller = new EngagementRunController(session, {
      api,
      likes: { like: vi.fn().mockResolvedValue("already_liked") },
      comments: { publish: vi.fn().mockResolvedValue("submitted") },
      mutualNeighbors,
    });

    const result = await controller.execute({
      discoveryPost: post("search"),
      recommendation,
      tabId: 8,
      tokenId: token.id,
    });

    expect(result).toMatchObject({ status: "completed" });
    expect(mutualNeighbors.request).toHaveBeenCalledWith(
      8,
      "candidate",
      "서로이웃으로 소통하고 싶어요.",
    );
    expect(result.run?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "mutual_neighbor",
          resultCode: "already_mutual",
          state: "skipped",
        }),
      ]),
    );
  });

  it("stops after a failed step and retries only that failed step with a new approval", async () => {
    const baseFailedRun = createRun();
    const failedRun: EngagementRun = {
      ...baseFailedRun,
      state: "failed",
      steps: baseFailedRun.steps.map((step) =>
        step.name === "like"
          ? { ...step, resultCode: "clicked", state: "succeeded" }
          : { ...step, resultCode: "captcha_required", state: "failed" },
      ),
    };
    const { session, token } = approvedSession("neighbor");
    const api = fakeApi(failedRun);
    const likes = { like: vi.fn() };
    const comments = { publish: vi.fn().mockResolvedValue("submitted") };
    const controller = new EngagementRunController(session, {
      api,
      likes,
      comments,
      mutualNeighbors: { request: vi.fn() },
    });

    await expect(
      controller.execute({
        discoveryPost: post(),
        recommendation,
        tabId: 7,
        tokenId: token.id,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(likes.like).not.toHaveBeenCalled();
    expect(comments.publish).toHaveBeenCalledOnce();
  });

  it("seals an interrupted or unconfirmed external action and does not retry it", async () => {
    const baseInterrupted = createRun();
    const interrupted: EngagementRun = {
      ...baseInterrupted,
      steps: baseInterrupted.steps.map((step) =>
        step.name === "like" ? { ...step, state: "running" } : step,
      ),
    };
    const first = approvedSession("neighbor");
    const api = fakeApi(interrupted);
    const likes = { like: vi.fn() };
    const comments = { publish: vi.fn() };
    const controller = new EngagementRunController(first.session, {
      api,
      likes,
      comments,
      mutualNeighbors: { request: vi.fn() },
    });

    await expect(
      controller.execute({
        discoveryPost: post(),
        recommendation,
        tabId: 7,
        tokenId: first.token.id,
      }),
    ).resolves.toMatchObject({
      code: "interrupted_before_confirmation",
      status: "unconfirmed",
    });
    expect(likes.like).not.toHaveBeenCalled();
    expect(comments.publish).not.toHaveBeenCalled();

    const baseUnconfirmed = createRun();
    const unconfirmed: EngagementRun = {
      ...baseUnconfirmed,
      state: "unconfirmed",
      steps: baseUnconfirmed.steps.map((step) =>
        step.name === "like"
          ? { ...step, resultCode: "submission_unconfirmed", state: "unconfirmed" }
          : step,
      ),
    };
    const second = approvedSession("neighbor");
    api.startEngagementRun.mockResolvedValueOnce({ replayed: true, value: unconfirmed });
    const resumed = new EngagementRunController(second.session, {
      api,
      likes,
      comments,
      mutualNeighbors: { request: vi.fn() },
    });
    await expect(
      resumed.execute({
        discoveryPost: post(),
        recommendation,
        tabId: 7,
        tokenId: second.token.id,
      }),
    ).resolves.toMatchObject({ status: "unconfirmed" });
    expect(likes.like).not.toHaveBeenCalled();
  });

  it("consumes and rejects a mismatched approval token before external actions", async () => {
    const { session, token } = approvedSession("neighbor");
    const api = fakeApi(createRun());
    const likes = { like: vi.fn() };
    const comments = { publish: vi.fn() };
    const controller = new EngagementRunController(session, {
      api,
      likes,
      comments,
      mutualNeighbors: { request: vi.fn() },
    });

    await expect(
      controller.execute({
        discoveryPost: { ...post(), sourceUrl: "https://blog.naver.com/candidate/999" },
        recommendation,
        tabId: 7,
        tokenId: token.id,
      }),
    ).resolves.toEqual({ code: "approval_invalid", run: null, status: "rejected" });
    await expect(
      controller.execute({
        discoveryPost: post(),
        recommendation,
        tabId: 7,
        tokenId: token.id,
      }),
    ).resolves.toMatchObject({ code: "approval_invalid" });
    expect(api.startEngagementRun).not.toHaveBeenCalled();
    expect(likes.like).not.toHaveBeenCalled();
    expect(comments.publish).not.toHaveBeenCalled();
  });

  it("rejects a concurrent click while one approved run owns the external-action lock", async () => {
    let releaseLike: ((value: "clicked") => void) | undefined;
    const first = approvedSession("neighbor");
    const second = approvedSession("neighbor");
    const api = fakeApi(createRun());
    const likes = {
      like: vi.fn(
        () =>
          new Promise<"clicked">((resolve) => {
            releaseLike = resolve;
          }),
      ),
    };
    const comments = { publish: vi.fn().mockResolvedValue("submitted") };
    const controller = new EngagementRunController(first.session, {
      api,
      likes,
      comments,
      mutualNeighbors: { request: vi.fn() },
    });
    const running = controller.execute({
      discoveryPost: post(),
      recommendation,
      tabId: 7,
      tokenId: first.token.id,
    });
    await vi.waitFor(() => expect(likes.like).toHaveBeenCalledOnce());

    await expect(
      controller.execute({
        discoveryPost: post(),
        recommendation,
        tabId: 7,
        tokenId: second.token.id,
      }),
    ).resolves.toEqual({ code: "engagement_busy", run: null, status: "rejected" });
    releaseLike?.("clicked");
    await expect(running).resolves.toMatchObject({ status: "completed" });
    expect(likes.like).toHaveBeenCalledOnce();
    expect(comments.publish).toHaveBeenCalledOnce();
  });

  it("persists an unconfirmed comment result and stops before later actions", async () => {
    const { session, token } = approvedSession("neighbor");
    const api = fakeApi(createRun());
    const controller = new EngagementRunController(session, {
      api,
      likes: { like: vi.fn().mockResolvedValue("clicked") },
      comments: { publish: vi.fn().mockResolvedValue("submission_unconfirmed") },
      mutualNeighbors: { request: vi.fn() },
    });

    await expect(
      controller.execute({
        discoveryPost: post(),
        recommendation,
        tabId: 7,
        tokenId: token.id,
      }),
    ).resolves.toMatchObject({
      code: "submission_unconfirmed",
      run: {
        state: "unconfirmed",
        steps: expect.arrayContaining([
          expect.objectContaining({ name: "comment", state: "unconfirmed" }),
        ]),
      },
      status: "unconfirmed",
    });
  });

  it.each([
    ["requested", "completed", "succeeded"],
    ["request_unconfirmed", "unconfirmed", "unconfirmed"],
    ["already_neighbor", "failed", "failed"],
  ] as const)(
    "maps mutual-neighbor result %s to a persisted %s run",
    async (code, status, stepState) => {
      const { session, token } = approvedSession("search");
      const api = fakeApi(createRun("search"));
      const controller = new EngagementRunController(session, {
        api,
        likes: { like: vi.fn().mockResolvedValue("clicked") },
        comments: { publish: vi.fn().mockResolvedValue("submitted") },
        mutualNeighbors: { request: vi.fn().mockResolvedValue({ code }) },
      });

      const result = await controller.execute({
        discoveryPost: post("search"),
        recommendation,
        tabId: 8,
        tokenId: token.id,
      });

      expect(result).toMatchObject({
        code: status === "completed" ? "engagement_completed" : code,
        status,
      });
      expect(result.run?.steps.at(-1)).toMatchObject({
        resultCode: code,
        state: stepState,
      });
    },
  );

  it.each([new Error("synthetic API failure"), "synthetic non-error rejection"])(
    "returns a safe failure when run persistence rejects",
    async (failure) => {
      const { session, token } = approvedSession("neighbor");
      const controller = new EngagementRunController(session, {
        api: {
          startEngagementRun: vi.fn().mockRejectedValue(failure),
          transitionEngagementStep: vi.fn(),
        },
        likes: { like: vi.fn() },
        comments: { publish: vi.fn() },
        mutualNeighbors: { request: vi.fn() },
      });

      await expect(
        controller.execute({
          discoveryPost: post(),
          recommendation,
          tabId: 7,
          tokenId: token.id,
        }),
      ).resolves.toMatchObject({
        code: failure instanceof Error ? "engagement_api_error" : "engagement_unknown_error",
        run: null,
        status: "failed",
      });
    },
  );
});
