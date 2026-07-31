/**
 * Execution controller for one approved post.
 *
 * One click starts one run. Progress arrives over SSE; a dropped connection reconnects a bounded
 * number of times and then falls back to one direct read, so the screen never waits forever. A step
 * with an unknown result is never retried automatically.
 */

import { ApiError, LocalApiClient } from "../api/client";
import { TERMINAL_RUN_EVENTS, type RunStreamFactory, eventSourceStream } from "../api/run-stream";
import type {
  EngagementRun,
  EngagementStep,
  EngagementStepName,
  RunStreamEvent,
} from "../api/types";
import {
  type RunState,
  initialRunState,
  isBusy,
  startingRun,
  toggledManualStep,
  withReconnect,
  withRefusal,
  withRun,
  withStepResult,
  withStreamClosed,
} from "../state/run";

export const MAX_RECONNECTS = 3;

const REFUSALS: Record<string, string> = {
  browser_session_not_running: "설정에서 브라우저 세션을 먼저 실행하세요.",
  consent_missing: "설정에서 자동 실행에 동의해야 실행할 수 있습니다.",
  comment_missing: "등록할 댓글이 비어 있습니다.",
  engagement_conflict: "이미 진행 중인 실행이 있습니다.",
  post_not_found: "대기열에서 글을 찾을 수 없습니다.",
  recommendation_not_approved: "먼저 댓글을 승인하세요.",
  recommendation_not_found: "승인한 추천을 찾을 수 없습니다.",
};

type RunApi = Pick<
  LocalApiClient,
  "startEngagementRun" | "engagementRun" | "engagementRunEventsUrl" | "completeEngagementManually"
>;

export interface RunControllerOptions {
  api?: RunApi;
  onChange?: () => void;
  stream?: RunStreamFactory;
}

export class RunController {
  readonly #api: RunApi;
  readonly #stream: RunStreamFactory;
  readonly #listeners: (() => void)[] = [];
  #state: RunState = initialRunState();
  #source: { close(): void } | null = null;

  constructor(options: RunControllerOptions = {}) {
    this.#api = options.api ?? new LocalApiClient();
    this.#stream = options.stream ?? eventSourceStream;
    if (options.onChange !== undefined) this.#listeners.push(options.onChange);
  }

  /** Notify `listener` after every state change. */
  observe(listener: () => void): void {
    this.#listeners.push(listener);
  }

  get state(): RunState {
    return this.#state;
  }

  /** Forget the previous run so a new post starts from an idle panel. */
  reset(): void {
    this.#closeSource();
    this.#state = initialRunState();
  }

  /** Approve and execute one post. Duplicate clicks while busy are ignored. */
  async start(discoveryPostId: string, recommendationId: string): Promise<EngagementRun | null> {
    if (isBusy(this.#state) || this.#state.phase === "finished") return null;
    this.#update(startingRun(this.#state));
    let run: EngagementRun;
    try {
      run = await this.#api.startEngagementRun(discoveryPostId, recommendationId);
    } catch (error) {
      this.#update(withRefusal(this.#state, describe(error)));
      return null;
    }
    this.#update(withRun(this.#state, run));
    this.#subscribe(run.id);
    return run;
  }

  toggleManualStep(name: EngagementStepName): void {
    this.#update(toggledManualStep(this.#state, name));
  }

  /** Record only the steps the user confirms were completed by hand. */
  async completeManually(): Promise<EngagementRun | null> {
    const run = this.#state.run;
    if (run === null || this.#state.manualSteps.length === 0) return null;
    try {
      const updated = await this.#api.completeEngagementManually(run.id, this.#state.manualSteps);
      this.#update(withRun(this.#state, updated));
      return updated;
    } catch (error) {
      this.#update(withRefusal(this.#state, describe(error)));
      return null;
    }
  }

  #subscribe(runId: string): void {
    this.#closeSource();
    this.#source = this.#stream(this.#api.engagementRunEventsUrl(runId), {
      onError: () => void this.#onStreamError(runId),
      onEvent: (event) => this.#onStreamEvent(runId, event),
    });
  }

  #onStreamEvent(runId: string, event: RunStreamEvent): void {
    if (event.event === "step_completed") {
      const name = event.payload.step;
      const state = event.payload.state;
      const code = event.payload.result_code;
      if (isStepName(name) && isStepState(state)) {
        this.#update(
          withStepResult(this.#state, name, state, typeof code === "string" ? code : null),
        );
      }
    }
    if (TERMINAL_RUN_EVENTS.has(event.event)) {
      this.#closeSource();
      this.#update(withStreamClosed(this.#state));
      void this.#refresh(runId);
    }
  }

  async #onStreamError(runId: string): Promise<void> {
    if (this.#state.streamClosed) {
      this.#closeSource();
      return;
    }
    if (this.#state.reconnects >= MAX_RECONNECTS) {
      this.#closeSource();
      this.#update(withStreamClosed(this.#state));
      await this.#refresh(runId);
      return;
    }
    this.#update(withReconnect(this.#state));
  }

  async #refresh(runId: string): Promise<void> {
    try {
      this.#update(withRun(this.#state, await this.#api.engagementRun(runId)));
    } catch (error) {
      this.#update(withRefusal(this.#state, describe(error)));
    }
  }

  #closeSource(): void {
    this.#source?.close();
    this.#source = null;
  }

  #update(state: RunState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

function isStepName(value: unknown): value is EngagementStepName {
  return value === "like" || value === "comment" || value === "mutual_neighbor";
}

function isStepState(value: unknown): value is EngagementStep["state"] {
  return (
    value === "pending" ||
    value === "running" ||
    value === "succeeded" ||
    value === "skipped" ||
    value === "failed" ||
    value === "unconfirmed"
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.code;
    if (code !== null && REFUSALS[code] !== undefined) return REFUSALS[code] as string;
    return error.problem?.detail ?? error.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}
