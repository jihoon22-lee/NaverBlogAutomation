import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../src/app/api/client";
import { decode, eventSourceStream } from "../../src/app/api/run-stream";
import type { RunStreamFactory, RunStreamHandlers } from "../../src/app/api/run-stream";
import type { EngagementRun } from "../../src/app/api/types";
import { MAX_RECONNECTS, RunController } from "../../src/app/controllers/run";
import {
  initialRunState,
  needsManualResolution,
  toggledManualStep,
  withStepResult,
} from "../../src/app/state/run";
import { renderRun } from "../../src/app/views/run";

const POST_ID = "11111111-1111-4111-8111-111111111111";
const RECOMMENDATION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

function run(overrides: Partial<EngagementRun> = {}): EngagementRun {
  return {
    id: RUN_ID,
    approvalId: "44444444-4444-4444-8444-444444444444",
    discoveryPostId: POST_ID,
    recommendationId: RECOMMENDATION_ID,
    source: "neighbor",
    state: "running",
    steps: [
      { name: "like", position: 0, state: "pending", resultCode: null, updatedAt: "2026-07-31" },
      { name: "comment", position: 1, state: "pending", resultCode: null, updatedAt: "2026-07-31" },
    ],
    createdAt: "2026-07-31",
    updatedAt: "2026-07-31",
    ...overrides,
  };
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

  drop(): void {
    this.handlers?.onError();
  }
}

function api(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    completeEngagementManually: vi.fn(async () =>
      run({
        state: "succeeded",
        steps: [
          {
            name: "like",
            position: 0,
            state: "succeeded",
            resultCode: "liked",
            updatedAt: "2026-07-31",
          },
          {
            name: "comment",
            position: 1,
            state: "succeeded",
            resultCode: "manual_completion",
            updatedAt: "2026-07-31",
          },
        ],
      }),
    ),
    engagementRun: vi.fn(async () => run({ state: "succeeded" })),
    engagementRunEventsUrl: (id: string) => `/api/v1/automation/engagement-runs/${id}/events`,
    startEngagementRun: vi.fn(async () => run()),
    ...overrides,
  } as never;
}

describe("run state", () => {
  it("keeps steps in the documented execution order", () => {
    let state = initialRunState();
    state = withStepResult(state, "mutual_neighbor", "succeeded", "neighbor_requested");
    state = withStepResult(state, "like", "skipped", "already_liked");

    expect(state.steps.map((step) => step.name)).toEqual(["like", "mutual_neighbor"]);
  });

  it("replaces an existing step result instead of appending it twice", () => {
    let state = initialRunState();
    state = withStepResult(state, "comment", "running", null);
    state = withStepResult(state, "comment", "succeeded", "comment_published");

    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]?.resultCode).toBe("comment_published");
  });

  it("asks for manual resolution only after a finished run with an open step", () => {
    let state = initialRunState();
    state = withStepResult(state, "comment", "unconfirmed", "comment_unconfirmed");

    expect(needsManualResolution(state)).toBe(false);
    expect(needsManualResolution({ ...state, phase: "finished" })).toBe(true);
    expect(
      needsManualResolution({
        ...state,
        phase: "finished",
        steps: [{ name: "comment", state: "succeeded", resultCode: "comment_published" }],
      }),
    ).toBe(false);
  });

  it("toggles a manual step on and off", () => {
    const selected = toggledManualStep(initialRunState(), "comment");

    expect(selected.manualSteps).toEqual(["comment"]);
    expect(toggledManualStep(selected, "comment").manualSteps).toEqual([]);
  });
});

describe("run stream decoding", () => {
  it("returns an empty payload for malformed data", () => {
    expect(decode("not json")).toEqual({});
    expect(decode("[1,2]")).toEqual({});
    expect(decode("")).toEqual({});
    expect(decode(undefined)).toEqual({});
  });

  it("decodes an object payload", () => {
    expect(decode('{"step":"like"}')).toEqual({ step: "like" });
  });

  it("subscribes to browser events and forwards decoded progress", () => {
    const listeners = new Map<string, (event: Event) => void>();
    const addEventListener = vi.fn((name: string, handler: (event: Event) => void) => {
      listeners.set(name, handler);
    });
    class BrowserEventSource {
      readonly addEventListener = addEventListener;
      readonly close = vi.fn();
    }
    vi.stubGlobal("EventSource", BrowserEventSource);
    const onEvent = vi.fn();
    const onError = vi.fn();

    const subscribed = eventSourceStream("/events", { onEvent, onError });
    listeners.get("run_started")?.({ data: '{"step":"like"}' } as MessageEvent);
    listeners.get("error")?.(new Event("error"));

    expect(subscribed).toBeInstanceOf(BrowserEventSource);
    expect(onEvent).toHaveBeenCalledWith({ event: "run_started", payload: { step: "like" } });
    expect(onError).toHaveBeenCalledOnce();
    expect(addEventListener).toHaveBeenCalledTimes(8);
    vi.unstubAllGlobals();
  });
});

describe("RunController", () => {
  let stream: FakeStream;

  beforeEach(() => {
    stream = new FakeStream();
  });

  it("starts one run and subscribes to its stream", async () => {
    const controller = new RunController({ api: api(), stream: stream.factory });

    const started = await controller.start(POST_ID, RECOMMENDATION_ID);

    expect(started?.id).toBe(RUN_ID);
    expect(controller.state.phase).toBe("running");
    expect(stream.urls).toEqual([`/api/v1/automation/engagement-runs/${RUN_ID}/events`]);
  });

  it("refreshes the active run after a mobile browser resumes", async () => {
    const client = api();
    const controller = new RunController({ api: client, stream: stream.factory });
    await controller.start(POST_ID, RECOMMENDATION_ID);

    await controller.refresh();

    expect(
      (client as unknown as { engagementRun: { mock: { calls: unknown[][] } } }).engagementRun.mock
        .calls,
    ).toEqual([[RUN_ID]]);
  });

  it("ignores a duplicate start while a run is in flight", async () => {
    const client = api();
    const controller = new RunController({ api: client, stream: stream.factory });

    await controller.start(POST_ID, RECOMMENDATION_ID);
    const second = await controller.start(POST_ID, RECOMMENDATION_ID);

    expect(second).toBeNull();
    expect(
      (client as unknown as { startEngagementRun: { mock: { calls: unknown[] } } })
        .startEngagementRun.mock.calls,
    ).toHaveLength(1);
  });

  it("records streamed step results", async () => {
    const controller = new RunController({ api: api(), stream: stream.factory });
    await controller.start(POST_ID, RECOMMENDATION_ID);

    stream.emit("step_completed", { step: "like", state: "skipped", result_code: "already_liked" });

    expect(controller.state.steps[0]).toEqual({
      name: "like",
      resultCode: "already_liked",
      state: "skipped",
    });
  });

  it("ignores a step event with an unknown name or state", async () => {
    const controller = new RunController({ api: api(), stream: stream.factory });
    await controller.start(POST_ID, RECOMMENDATION_ID);
    const before = controller.state.steps;

    stream.emit("step_completed", { step: "unknown", state: "succeeded" });
    stream.emit("step_completed", { step: "like", state: "invented" });

    expect(controller.state.steps).toEqual(before);
  });

  it("closes the stream and refreshes the run on a terminal event", async () => {
    const client = api();
    const controller = new RunController({ api: client, stream: stream.factory });
    await controller.start(POST_ID, RECOMMENDATION_ID);

    stream.emit("run_finished", { state: "succeeded" });
    await Promise.resolve();
    await Promise.resolve();

    expect(stream.closes).toBe(1);
    expect(controller.state.streamClosed).toBe(true);
    expect(controller.state.phase).toBe("finished");
  });

  it("reconnects a bounded number of times before reading the run directly", async () => {
    const client = api();
    const controller = new RunController({ api: client, stream: stream.factory });
    await controller.start(POST_ID, RECOMMENDATION_ID);

    for (let attempt = 0; attempt <= MAX_RECONNECTS; attempt += 1) {
      stream.drop();
      await Promise.resolve();
    }
    await Promise.resolve();

    expect(controller.state.reconnects).toBe(MAX_RECONNECTS);
    expect(controller.state.streamClosed).toBe(true);
    expect(
      (client as unknown as { engagementRun: { mock: { calls: unknown[] } } }).engagementRun.mock
        .calls.length,
    ).toBeGreaterThan(0);
  });

  it("does not reopen a stream that already closed", async () => {
    const controller = new RunController({ api: api(), stream: stream.factory });
    await controller.start(POST_ID, RECOMMENDATION_ID);
    stream.emit("run_finished", {});
    await Promise.resolve();

    stream.drop();

    expect(controller.state.reconnects).toBe(0);
  });

  it("reports a refusal instead of starting", async () => {
    const controller = new RunController({
      api: api({
        startEngagementRun: vi.fn(async () => {
          throw new ApiError("거부", {
            problem: {
              code: "consent_missing",
              detail: "동의가 필요합니다.",
              status: 403,
              title: "Engagement not allowed",
            },
            status: 403,
          });
        }),
      }),
      stream: stream.factory,
    });

    const started = await controller.start(POST_ID, RECOMMENDATION_ID);

    expect(started).toBeNull();
    expect(controller.state.phase).toBe("refused");
    expect(controller.state.error).toBe("설정에서 자동 실행에 동의해야 실행할 수 있습니다.");
  });

  it("keeps the service message for an unmapped refusal", async () => {
    const controller = new RunController({
      api: api({
        startEngagementRun: vi.fn(async () => {
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
      }),
      stream: stream.factory,
    });

    await controller.start(POST_ID, RECOMMENDATION_ID);

    expect(controller.state.error).toBe("세션이 사용 중입니다.");
  });

  it("records only the steps the user confirms", async () => {
    const client = api();
    const controller = new RunController({ api: client, stream: stream.factory });
    await controller.start(POST_ID, RECOMMENDATION_ID);
    controller.toggleManualStep("comment");

    const updated = await controller.completeManually();

    expect(updated?.state).toBe("succeeded");
    expect(
      (client as unknown as { completeEngagementManually: { mock: { calls: unknown[][] } } })
        .completeEngagementManually.mock.calls[0],
    ).toEqual([RUN_ID, ["comment"]]);
  });

  it("does not record a manual completion without a selection", async () => {
    const client = api();
    const controller = new RunController({ api: client, stream: stream.factory });
    await controller.start(POST_ID, RECOMMENDATION_ID);

    expect(await controller.completeManually()).toBeNull();
  });

  it("resets to an idle panel for the next post", async () => {
    const controller = new RunController({ api: api(), stream: stream.factory });
    await controller.start(POST_ID, RECOMMENDATION_ID);

    controller.reset();

    expect(controller.state.phase).toBe("idle");
    expect(stream.closes).toBe(1);
  });
});

describe("run view", () => {
  it("announces progress through a live region", () => {
    const element = renderRun(document, initialRunState(), {
      onManualComplete: () => undefined,
      onStart: () => undefined,
      onToggleManualStep: () => undefined,
    });

    const status = element.querySelector("#run-status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("role")).toBe("status");
  });

  it("does not offer a second start button while a run is in flight", () => {
    const element = renderRun(
      document,
      { ...initialRunState(), phase: "running" },
      {
        onManualComplete: () => undefined,
        onStart: () => undefined,
        onToggleManualStep: () => undefined,
      },
    );

    expect(element.querySelector("#run-button")).toBeNull();
  });

  it("explains a partial failure and offers only a manual record", () => {
    const element = renderRun(
      document,
      {
        ...initialRunState(),
        phase: "finished",
        steps: [
          { name: "like", state: "succeeded", resultCode: "liked" },
          { name: "comment", state: "unconfirmed", resultCode: "comment_unconfirmed" },
        ],
      },
      {
        onManualComplete: () => undefined,
        onStart: () => undefined,
        onToggleManualStep: () => undefined,
      },
    );

    expect(element.querySelector("#run-status")?.textContent).toContain("직접 처리한 단계");
    expect(element.querySelector("#manual-comment")).not.toBeNull();
    expect(element.querySelector("#manual-like")).toBeNull();
    expect((element.querySelector("#manual-complete-button") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(element.querySelector('[data-step="comment"] .run-step-result')?.textContent).toContain(
      "자동으로 다시 등록하지 않습니다",
    );
  });

  it("reports a reconnect in the status line", () => {
    const element = renderRun(
      document,
      { ...initialRunState(), phase: "running", reconnects: 1 },
      {
        onManualComplete: () => undefined,
        onStart: () => undefined,
        onToggleManualStep: () => undefined,
      },
    );

    expect(element.querySelector("#run-status")?.textContent).toContain("다시 연결");
  });

  it("shows a refusal message", () => {
    const element = renderRun(
      document,
      { ...initialRunState(), phase: "refused", error: "동의가 필요합니다." },
      {
        onManualComplete: () => undefined,
        onStart: () => undefined,
        onToggleManualStep: () => undefined,
      },
    );

    expect(element.querySelector("#run-status")?.textContent).toBe("동의가 필요합니다.");
  });
});
