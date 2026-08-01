/** Session batch screen: scope selection, progress, cancelling, and abort reasons. */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunStreamFactory, RunStreamHandlers } from "../../src/app/api/run-stream";
import type {
  AutomationSession,
  DiscoveryPost,
  SafetyStatus,
  ScheduleStatus,
} from "../../src/app/api/types";
import {
  SessionController,
  canStartScope,
  initialSessionState,
} from "../../src/app/controllers/session";

const SESSION: AutomationSession = {
  id: "11111111-1111-4111-8111-111111111111",
  trigger: "session",
  state: "running",
  approvedSteps: ["like", "comment"],
  sources: ["neighbor"],
  postIds: [],
  maxPosts: 3,
  processedCount: 0,
  abortReason: null,
  createdAt: "2026-08-01T00:00:00Z",
  startedAt: "2026-08-01T00:00:01Z",
  finishedAt: null,
};

const SCHEDULE: ScheduleStatus = {
  mode: "manual",
  hour: 9,
  minute: 30,
  maxPosts: 3,
  enabled: false,
  blockingReason: "not_scheduled",
};

const SAFETY: SafetyStatus = {
  localDate: "2026-08-01",
  allowedNow: true,
  blockingReason: null,
  allowedHours: [9, 10, 11],
  minIntervalSeconds: 60,
  consecutiveFailures: 0,
  maxConsecutiveFailures: 3,
  actions: [
    { name: "like", cap: 5, used: 0, remaining: 5 },
    { name: "comment", cap: 5, used: 0, remaining: 5 },
    { name: "mutual_neighbor", cap: 3, used: 0, remaining: 3 },
  ],
};

const QUEUED_POST: DiscoveryPost = {
  id: "22222222-2222-4222-8222-222222222222",
  source: "neighbor",
  state: "queued",
  sourceUrl: "https://example.test/post",
  title: "테스트 글",
  publisherName: "테스트 이웃",
  publisherBlogId: "tester",
  publishedAt: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

interface Harness {
  root: Element;
  controller: SessionController;
  api: {
    approveSession: ReturnType<typeof vi.fn>;
    sessions: ReturnType<typeof vi.fn>;
    session: ReturnType<typeof vi.fn>;
    cancelSession: ReturnType<typeof vi.fn>;
    sessionEventsUrl: ReturnType<typeof vi.fn>;
    schedule: ReturnType<typeof vi.fn>;
    discoveryQueue?: ReturnType<typeof vi.fn>;
    safetyStatus?: ReturnType<typeof vi.fn>;
  };
  emit(event: string, payload: Record<string, unknown>): void;
  fail(): void;
  closed(): number;
}

function harness(overrides: Partial<Harness["api"]> = {}): Harness {
  document.body.innerHTML = '<main id="workspace"></main>';
  const root = document.getElementById("workspace");
  if (root === null) throw new Error("missing root");
  const api = {
    approveSession: vi.fn(async () => SESSION),
    sessions: vi.fn(async () => [] as AutomationSession[]),
    session: vi.fn(async () => SESSION),
    cancelSession: vi.fn(async () => ({ ...SESSION, state: "cancelled" as const })),
    sessionEventsUrl: vi.fn(() => "/api/v1/automation/sessions/x/events"),
    schedule: vi.fn(async () => SCHEDULE),
    ...overrides,
  };
  let handlers: RunStreamHandlers | null = null;
  let closes = 0;
  const stream: RunStreamFactory = (_url, streamHandlers) => {
    handlers = streamHandlers;
    return {
      close: () => {
        closes += 1;
      },
    };
  };
  const controller = new SessionController(root, {
    api: api as never,
    stream,
    onChange: () => controller.render(),
  });
  return {
    root,
    controller,
    api,
    emit: (event, payload) => handlers?.onEvent({ event, payload }),
    fail: () => handlers?.onError(),
    closed: () => closes,
  };
}

function text(root: Element): string {
  return root.textContent ?? "";
}

function click(root: Element, selector: string): void {
  const button = root.querySelector<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`missing button: ${selector}`);
  button.click();
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("session scope", () => {
  it("shows like and comment as the default scope", () => {
    const { root, controller } = harness();

    controller.render();

    const pressed = Array.from(root.querySelectorAll('[aria-pressed="true"]')).map(
      (node) => (node as HTMLElement).dataset.step,
    );
    expect(pressed).toEqual(["like", "comment"]);
  });

  it("adds a step when its choice is pressed", () => {
    const { root, controller } = harness();
    controller.render();

    click(root, '[data-step="mutual_neighbor"]');

    expect(controller.state.approvedSteps).toEqual(["like", "comment", "mutual_neighbor"]);
  });

  it("keeps at least one step selected", () => {
    const { root, controller } = harness();
    controller.render();

    click(root, '[data-step="like"]');
    click(root, '[data-step="comment"]');

    expect(controller.state.approvedSteps).toEqual(["comment"]);
  });

  it("keeps the step order stable regardless of click order", () => {
    const { controller } = harness();
    controller.toggleStep("mutual_neighbor");
    controller.toggleStep("like");
    controller.toggleStep("like");

    expect(controller.state.approvedSteps).toEqual(["like", "comment", "mutual_neighbor"]);
  });

  it("rejects a max post count below one", () => {
    const { controller } = harness();

    controller.setMaxPosts(0);
    controller.setMaxPosts(51);
    controller.setMaxPosts(1.5);

    expect(controller.state.maxPosts).toBe(3);
  });

  it("accepts only distinct non-empty source choices", () => {
    const { controller } = harness();

    controller.setSources([]);
    controller.setSources(["neighbor", "neighbor"]);
    controller.setSources(["neighbor", "search"]);

    expect(controller.state.sources).toEqual(["neighbor", "search"]);
  });

  it("explains that cancelling takes effect after the current post", () => {
    const { root, controller } = harness();

    controller.render();

    expect(text(root)).toContain("취소는 지금 처리 중인 글이 끝난 뒤에 반영됩니다");
  });

  it("retains direct selection order and uses it as the approval snapshot", async () => {
    const second = {
      ...QUEUED_POST,
      id: "33333333-3333-4333-8333-333333333333",
      title: "두 번째 글",
    };
    const { controller, api } = harness({
      discoveryQueue: vi.fn(async () => [QUEUED_POST, second]),
      safetyStatus: vi.fn(async () => SAFETY),
    });
    await controller.load();
    controller.togglePost(second.id);
    controller.togglePost(QUEUED_POST.id);

    await controller.start();

    expect(api.approveSession).toHaveBeenCalledWith({
      approvedSteps: ["like", "comment"],
      maxPosts: 2,
      sources: ["neighbor"],
      postIds: [second.id, QUEUED_POST.id],
    });
  });

  it("prevents a scope that exceeds a selected action's remaining cap", async () => {
    const { root, controller, api } = harness({
      discoveryQueue: vi.fn(async () => [QUEUED_POST]),
      safetyStatus: vi.fn(async () => ({
        ...SAFETY,
        actions: [{ ...SAFETY.actions[0], remaining: 0 }, ...SAFETY.actions.slice(1)],
      })),
    });
    await controller.load();
    controller.render();

    expect(root.querySelector<HTMLButtonElement>("#start-session-button")?.disabled).toBe(true);
    await controller.start();
    expect(api.approveSession).not.toHaveBeenCalled();
  });

  it("makes both queue sources selectable and explains a time-window block", async () => {
    const searchPost = {
      ...QUEUED_POST,
      id: "33333333-3333-4333-8333-333333333333",
      source: "search" as const,
    };
    const { root, controller } = harness({
      discoveryQueue: vi.fn(async () => [QUEUED_POST, searchPost]),
      safetyStatus: vi.fn(async () => ({
        ...SAFETY,
        allowedNow: false,
        blockingReason: "outside_allowed_hours",
      })),
    });
    await controller.load();
    controller.render();

    const source = root.querySelector<HTMLSelectElement>("#batch-source");
    if (source === null) throw new Error("missing source selector");
    source.value = "both";
    source.dispatchEvent(new Event("change"));

    expect(controller.state.sources).toEqual(["neighbor", "search"]);
    expect(root.querySelectorAll("#session-queue-selection input")).toHaveLength(2);
    expect(text(root)).toContain("허용한 시간대를 벗어나 중단했습니다");
  });

  it("keeps a maximum of fifty explicit queued posts", async () => {
    const queued = Array.from({ length: 51 }, (_, index) => ({
      ...QUEUED_POST,
      id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    }));
    const { controller } = harness({ discoveryQueue: vi.fn(async () => queued) });
    await controller.load();

    controller.togglePost("not-in-queue");
    for (const post of queued) controller.togglePost(post.id);

    expect(controller.state.selectedPostIds).toHaveLength(50);
    expect(controller.state.selectedPostIds).not.toContain(queued[50]?.id);
  });

  it("requires queued posts, time permission, and every action cap for a displayed scope", () => {
    const emptyQueue = { ...initialSessionState(), queueLoaded: true };
    const selected = {
      ...emptyQueue,
      queue: [QUEUED_POST],
      selectedPostIds: [QUEUED_POST.id],
    };

    expect(canStartScope(emptyQueue, null)).toBe(false);
    expect(canStartScope(selected, null)).toBe(true);
    expect(canStartScope(selected, { ...SAFETY, allowedNow: false })).toBe(false);
    expect(
      canStartScope(selected, {
        ...SAFETY,
        actions: SAFETY.actions.filter(({ name }) => name !== "comment"),
      }),
    ).toBe(false);
  });
});

describe("starting a batch", () => {
  it("approves the chosen scope", async () => {
    const { controller, api } = harness();
    controller.setMaxPosts(5);

    await controller.start();

    expect(api.approveSession).toHaveBeenCalledWith({
      approvedSteps: ["like", "comment"],
      maxPosts: 5,
      sources: ["neighbor"],
    });
  });

  it("subscribes to the batch stream", async () => {
    const { controller, api } = harness();

    await controller.start();

    expect(api.sessionEventsUrl).toHaveBeenCalledWith(SESSION.id);
  });

  it("does not start a second batch while one is running", async () => {
    const { controller, api } = harness();
    await controller.start();

    await controller.start();

    expect(api.approveSession).toHaveBeenCalledTimes(1);
  });

  it("shows a refusal in words the user can act on", async () => {
    const { ApiError } = await import("../../src/app/api/client");
    const { root, controller } = harness({
      approveSession: vi.fn(async () => {
        throw new ApiError("conflict", {
          problem: { code: "session_already_running" } as never,
          status: 409,
        });
      }),
    });

    await controller.start();

    expect(text(root)).toContain("이미 진행 중인 배치가 있습니다");
  });
});

describe("progress", () => {
  it("counts each completed post", async () => {
    const { root, controller, emit } = harness();
    await controller.start();

    emit("post_completed", { post_id: "a", state: "succeeded", result_codes: ["liked"] });
    emit("post_completed", { post_id: "b", state: "failed", result_codes: [] });

    expect(controller.state.completedPosts).toHaveLength(2);
    expect(text(root)).toContain("성공");
    expect(text(root)).toContain("실패");
  });

  it("ignores a post event without an id", async () => {
    const { controller, emit } = harness();
    await controller.start();

    emit("post_completed", { state: "succeeded" });

    expect(controller.state.completedPosts).toEqual([]);
  });

  it("records a post with no optional state or result codes", async () => {
    const { controller, emit } = harness();
    await controller.start();

    emit("post_completed", { post_id: "a" });

    expect(controller.state.completedPosts).toEqual([
      { postId: "a", state: "unknown", resultCodes: [] },
    ]);
  });

  it("closes the stream on a terminal event", async () => {
    const { controller, emit, closed } = harness();
    await controller.start();

    emit("session_completed", { ...snapshot(), state: "completed" });

    expect(closed()).toBeGreaterThan(0);
    expect(controller.state.phase).toBe("finished");
  });

  it("explains why a batch was aborted", async () => {
    const { root, controller, emit } = harness();
    await controller.start();

    emit("session_aborted", {
      ...snapshot(),
      state: "aborted",
      abort_reason: "daily_cap_reached",
      processed_count: 2,
    });

    expect(text(root)).toContain("오늘 상한에 도달해 중단했습니다");
  });

  it("tells the user to log in when the batch stopped for it", async () => {
    const { root, controller, emit } = harness();
    await controller.start();

    emit("session_aborted", { ...snapshot(), state: "aborted", abort_reason: "login_required" });

    expect(text(root)).toContain("브라우저에서 로그인하세요");
  });

  it("falls back to one direct read after too many drops", async () => {
    const { controller, api, fail } = harness();
    await controller.start();

    for (let attempt = 0; attempt < 5; attempt += 1) fail();

    await Promise.resolve();
    await Promise.resolve();
    expect(api.session).toHaveBeenCalledWith(SESSION.id);
  });

  it("keeps the current snapshot for an incomplete session stream event", async () => {
    const { controller, emit } = harness();
    await controller.start();

    emit("session_progress", { id: SESSION.id });

    expect(controller.state.current?.state).toBe("running");
    expect(controller.state.current?.processedCount).toBe(0);
  });

  it("ignores an incomplete session stream event", async () => {
    const { controller, emit } = harness();
    await controller.start();

    emit("session_progress", {});

    expect(controller.state.current?.id).toBe(SESSION.id);
  });
});

describe("cancelling", () => {
  it("reports the request instead of pretending the batch stopped", async () => {
    const { root, controller } = harness();
    await controller.start();

    click(root, "#cancel-session-button");

    expect(controller.state.cancelRequested).toBe(true);
  });

  it("asks the service once", async () => {
    const { controller, api } = harness();
    await controller.start();

    await controller.cancel();
    await controller.cancel();

    expect(api.cancelSession).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a batch", async () => {
    const { controller, api } = harness();

    await controller.cancel();

    expect(api.cancelSession).not.toHaveBeenCalled();
  });

  it("restores the cancellation control after a failed request", async () => {
    const { controller } = harness({
      cancelSession: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await controller.start();

    await controller.cancel();

    expect(controller.state.cancelRequested).toBe(false);
    expect(controller.state.phase).toBe("failed");
  });
});

describe("loading", () => {
  it("shows why unattended mode is off", async () => {
    const { root, controller } = harness();

    await controller.load();
    controller.render();

    expect(text(root)).toContain("무인 실행이 꺼져 있습니다");
  });

  it("shows the unattended schedule when it is on", async () => {
    const { root, controller } = harness({
      schedule: vi.fn(async () => ({ ...SCHEDULE, mode: "schedule" as const, enabled: true })),
    });

    await controller.load();
    controller.render();

    expect(text(root)).toContain("매일 09:30");
  });

  it("follows a batch that was already running", async () => {
    const { controller, api } = harness({
      sessions: vi.fn(async () => [SESSION]),
    });

    await controller.load();

    expect(controller.state.phase).toBe("running");
    expect(api.sessionEventsUrl).toHaveBeenCalledWith(SESSION.id);
  });

  it("reports an empty history", async () => {
    const { root, controller } = harness();

    await controller.load();
    controller.render();

    expect(text(root)).toContain("아직 실행한 배치가 없습니다");
  });

  it("lists the abort reason of a past batch", async () => {
    const { root, controller } = harness({
      sessions: vi.fn(async () => [
        { ...SESSION, state: "aborted" as const, abortReason: "consecutive_failures" },
      ]),
    });

    await controller.load();
    controller.render();

    expect(text(root)).toContain("연속으로 실패해 중단했습니다");
  });

  it("shows a service failure without leaving the screen blank", async () => {
    const { root, controller } = harness({
      sessions: vi.fn(async () => {
        throw new Error("offline");
      }),
    });

    await controller.load();
    controller.render();

    expect(text(root)).toContain("로컬 서비스가 실행 중인지 확인하세요");
  });

  it("does not load again while a batch is active", async () => {
    const { controller, api } = harness();
    await controller.start();

    await controller.load();

    expect(api.sessions).not.toHaveBeenCalled();
  });
});

function snapshot(): Record<string, unknown> {
  return {
    id: SESSION.id,
    trigger: "session",
    state: "running",
    approved_steps: ["like", "comment"],
    sources: ["neighbor"],
    post_ids: [],
    max_posts: 3,
    processed_count: 1,
    abort_reason: null,
    created_at: SESSION.createdAt,
    started_at: SESSION.startedAt,
    finished_at: null,
  };
}
