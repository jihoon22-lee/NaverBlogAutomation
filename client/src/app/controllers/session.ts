/**
 * Session batch controller.
 *
 * One approval covers several queued posts. Progress arrives over SSE; cancelling asks the batch to
 * stop before the next post rather than interrupting the one already running, so the button reports
 * "요청함" instead of pretending the batch stopped instantly.
 */

import { ApiError, LocalApiClient } from "../api/client";
import type { RunStreamFactory } from "../api/run-stream";
import { TERMINAL_SESSION_EVENTS, sessionEventSourceStream } from "../api/session-stream";
import type {
  AutomationSession,
  DiscoverySource,
  EngagementStepName,
  ScheduleStatus,
} from "../api/types";
import { renderSession } from "../views/session";

export const MAX_SESSION_RECONNECTS = 3;

const REFUSALS: Record<string, string> = {
  consent_missing: "설정에서 자동 실행에 동의해야 배치를 시작할 수 있습니다.",
  browser_session_not_running: "설정에서 브라우저 세션을 먼저 실행하세요.",
  session_already_running: "이미 진행 중인 배치가 있습니다. 끝나거나 취소된 뒤에 시작하세요.",
  session_not_found: "배치를 찾을 수 없습니다.",
  session_not_cancellable: "이미 끝난 배치는 취소할 수 없습니다.",
};

/** Why a scheduled run cannot start, in words a user can act on. */
export const SCHEDULE_REASONS: Record<string, string> = {
  not_scheduled: "무인 실행이 꺼져 있습니다. 설정에서 예약 모드를 선택하세요.",
  consent_missing: "설정에서 자동 실행에 동의해야 무인 실행이 켜집니다.",
  safety_policy_missing: "안전 정책을 한 번 저장해야 무인 실행이 켜집니다.",
  ready: "무인 실행을 시작할 수 있습니다.",
};

export interface SessionState {
  phase: "idle" | "loading" | "ready" | "starting" | "running" | "finished" | "failed";
  current: AutomationSession | null;
  recent: AutomationSession[];
  schedule: ScheduleStatus | null;
  approvedSteps: EngagementStepName[];
  sources: DiscoverySource[];
  maxPosts: number;
  completedPosts: { postId: string; state: string; resultCodes: string[] }[];
  cancelRequested: boolean;
  error: string | null;
}

type SessionApi = Pick<
  LocalApiClient,
  "approveSession" | "sessions" | "session" | "cancelSession" | "sessionEventsUrl" | "schedule"
>;

export interface SessionControllerOptions {
  api?: SessionApi;
  onChange?: () => void;
  stream?: RunStreamFactory;
}

/** The starting state: nothing loaded, like and comment approved by default. */
export function initialSessionState(): SessionState {
  return {
    phase: "idle",
    current: null,
    recent: [],
    schedule: null,
    approvedSteps: ["like", "comment"],
    sources: ["neighbor"],
    maxPosts: 3,
    completedPosts: [],
    cancelRequested: false,
    error: null,
  };
}

/** Report whether the batch is in flight and must not be started again. */
export function isSessionBusy(state: SessionState): boolean {
  return state.phase === "starting" || state.phase === "running" || state.phase === "loading";
}

export class SessionController {
  readonly #root: Element;
  readonly #api: SessionApi;
  readonly #stream: RunStreamFactory;
  readonly #listeners: (() => void)[] = [];
  #state: SessionState = initialSessionState();
  #source: { close(): void } | null = null;
  #reconnects = 0;

  constructor(root: Element, options: SessionControllerOptions = {}) {
    this.#root = root;
    this.#api = options.api ?? new LocalApiClient();
    this.#stream = options.stream ?? sessionEventSourceStream;
    if (options.onChange !== undefined) this.#listeners.push(options.onChange);
  }

  observe(listener: () => void): void {
    this.#listeners.push(listener);
  }

  get state(): SessionState {
    return this.#state;
  }

  /** Draw the batch screen for the current state. */
  render(): void {
    renderSession(this.#root, this.#state, {
      onStart: () => void this.start(),
      onCancel: () => void this.cancel(),
      onRefresh: () => void this.load(),
      onToggleStep: (name) => {
        this.toggleStep(name);
        this.render();
      },
      onMaxPostsChange: (value) => {
        this.setMaxPosts(value);
        this.render();
      },
    });
  }

  /** Load the recent batches and the unattended schedule status. */
  async load(options: { sessionId?: string } = {}): Promise<void> {
    if (isSessionBusy(this.#state)) return;
    this.#patch({ phase: "loading", error: null });
    try {
      const [recent, schedule, selected] = await Promise.all([
        this.#api.sessions(10),
        this.#api.schedule(),
        options.sessionId === undefined
          ? Promise.resolve(null)
          : this.#api.session(options.sessionId),
      ]);
      const running = recent.find(
        (entry) => entry.state === "running" || entry.state === "pending",
      );
      const current = selected ?? running ?? null;
      this.#patch({
        phase: current !== null && !isTerminal(current) ? "running" : "ready",
        recent,
        schedule,
        current,
      });
      if (current !== null && !isTerminal(current)) this.#subscribe(current.id);
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Choose whether one step is part of the batch. At least one step must stay selected. */
  toggleStep(name: EngagementStepName): void {
    const selected = new Set(this.#state.approvedSteps);
    if (selected.has(name)) selected.delete(name);
    else selected.add(name);
    if (selected.size === 0) return;
    const ordered: EngagementStepName[] = ["like", "comment", "mutual_neighbor"];
    this.#patch({ approvedSteps: ordered.filter((step) => selected.has(step)) });
  }

  /** Choose how many posts one approval may cover. */
  setMaxPosts(value: number): void {
    if (!Number.isInteger(value) || value < 1) return;
    this.#patch({ maxPosts: value });
  }

  /** Approve one batch and follow its progress. */
  async start(): Promise<void> {
    if (isSessionBusy(this.#state)) return;
    this.#patch({
      phase: "starting",
      error: null,
      completedPosts: [],
      cancelRequested: false,
    });
    try {
      const session = await this.#api.approveSession({
        approvedSteps: this.#state.approvedSteps,
        maxPosts: this.#state.maxPosts,
        sources: this.#state.sources,
      });
      this.#patch({ phase: "running", current: session });
      this.#subscribe(session.id);
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Ask the batch to stop before the next post. */
  async cancel(): Promise<void> {
    const current = this.#state.current;
    if (current === null || this.#state.cancelRequested) return;
    this.#patch({ cancelRequested: true });
    try {
      const session = await this.#api.cancelSession(current.id);
      this.#patch({ current: session });
    } catch (error) {
      this.#patch({ cancelRequested: false });
      this.#fail(error);
    }
  }

  /** Stop following the current batch without changing its state on the service. */
  close(): void {
    this.#closeSource();
  }

  #subscribe(id: string): void {
    this.#closeSource();
    this.#source = this.#stream(this.#api.sessionEventsUrl(id), {
      onEvent: (event) => {
        this.#reconnects = 0;
        if (event.event === "post_completed") this.#recordPost(event.payload);
        else this.#recordSession(event.payload);
        if (TERMINAL_SESSION_EVENTS.has(event.event)) {
          this.#closeSource();
          this.#patch({ phase: "finished" });
          void this.#refresh();
        }
      },
      onError: () => {
        this.#reconnects += 1;
        if (this.#reconnects <= MAX_SESSION_RECONNECTS) return;
        this.#closeSource();
        void this.#readOnce(id);
      },
    });
  }

  /** Fall back to one direct read so the screen never waits on a dead stream. */
  async #readOnce(id: string): Promise<void> {
    try {
      const session = await this.#api.session(id);
      this.#patch({ current: session, phase: isTerminal(session) ? "finished" : "running" });
    } catch (error) {
      this.#fail(error);
    }
  }

  async #refresh(): Promise<void> {
    try {
      this.#patch({ recent: await this.#api.sessions(10) });
    } catch {
      // The batch state already arrived over the stream; a stale list is not worth an error.
    }
  }

  #recordPost(payload: Record<string, unknown>): void {
    const postId = typeof payload.post_id === "string" ? payload.post_id : null;
    if (postId === null) return;
    const codes = Array.isArray(payload.result_codes)
      ? payload.result_codes.filter((code): code is string => typeof code === "string")
      : [];
    this.#patch({
      completedPosts: [
        ...this.#state.completedPosts,
        {
          postId,
          state: typeof payload.state === "string" ? payload.state : "unknown",
          resultCodes: codes,
        },
      ],
    });
  }

  #recordSession(payload: Record<string, unknown>): void {
    if (typeof payload.id !== "string") return;
    const current = this.#state.current;
    if (current === null) return;
    this.#patch({
      current: {
        ...current,
        state: typeof payload.state === "string" ? (payload.state as never) : current.state,
        processedCount:
          typeof payload.processed_count === "number"
            ? payload.processed_count
            : current.processedCount,
        abortReason:
          typeof payload.abort_reason === "string" ? payload.abort_reason : current.abortReason,
      },
    });
  }

  #closeSource(): void {
    this.#source?.close();
    this.#source = null;
    this.#reconnects = 0;
  }

  #fail(error: unknown): void {
    this.#patch({ phase: "failed", error: message(error) });
  }

  #patch(changes: Partial<SessionState>): void {
    this.#state = { ...this.#state, ...changes };
    for (const listener of this.#listeners) listener();
  }
}

function isTerminal(session: AutomationSession): boolean {
  return session.state !== "pending" && session.state !== "running";
}

function message(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.code ?? "";
    return REFUSALS[code] ?? error.message;
  }
  return "알 수 없는 오류가 발생했습니다. 로컬 서비스가 실행 중인지 확인하세요.";
}
