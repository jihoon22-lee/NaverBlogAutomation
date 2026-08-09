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
  DiscoveryPost,
  DiscoverySource,
  EngagementStepName,
  ScheduleStatus,
  SafetyStatus,
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
  safety: SafetyStatus | null;
  queue: DiscoveryPost[];
  queueLoaded: boolean;
  selectedPostIds: string[];
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
> &
  Partial<Pick<LocalApiClient, "discoveryQueue" | "safetyStatus">>;

export interface SessionControllerOptions {
  api?: SessionApi;
  onBack?: () => void;
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
    safety: null,
    queue: [],
    queueLoaded: false,
    selectedPostIds: [],
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
  readonly #onBack: () => void;
  readonly #stream: RunStreamFactory;
  readonly #listeners: (() => void)[] = [];
  #state: SessionState = initialSessionState();
  #source: { close(): void } | null = null;
  #reconnects = 0;
  #lifecycle = 0;
  #streamGeneration = 0;
  #loadInFlight = false;
  #pendingLoadOptions: { sessionId?: string | null } | null = null;
  #closed = false;

  constructor(root: Element, options: SessionControllerOptions = {}) {
    this.#root = root;
    this.#api = options.api ?? new LocalApiClient();
    this.#onBack = options.onBack ?? (() => undefined);
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
      onBack: this.#onBack,
      onRefresh: () => void this.load(),
      onToggleStep: (name) => {
        this.toggleStep(name);
        this.render();
      },
      onMaxPostsChange: (value) => {
        this.setMaxPosts(value);
        this.render();
      },
      onSourcesChange: (sources) => {
        this.setSources(sources);
        this.render();
      },
      onTogglePost: (postId) => {
        this.togglePost(postId);
        this.render();
      },
    });
  }

  /** Load the recent batches and the unattended schedule status. */
  async load(options: { sessionId?: string | null } = {}): Promise<void> {
    const explicitSession = Object.hasOwn(options, "sessionId");
    const requestedId = options.sessionId;
    const currentId = this.#state.current?.id ?? null;
    const routeOverride = explicitSession && (this.#closed || requestedId !== currentId);
    if (this.#loadInFlight) {
      if (explicitSession) {
        this.#pendingLoadOptions = requestedId === undefined ? {} : { sessionId: requestedId };
        this.#lifecycle += 1;
        this.#invalidateStream();
      }
      return;
    }
    if (isSessionBusy(this.#state) && !routeOverride) return;
    const lifecycle = ++this.#lifecycle;
    this.#closed = false;
    this.#loadInFlight = true;
    this.#invalidateStream();
    this.#patch({
      phase: "loading",
      error: null,
      ...(routeOverride ? { current: null, cancelRequested: false } : {}),
    });
    try {
      const [recent, schedule, queue, safety, selected] = await Promise.all([
        this.#api.sessions(10),
        this.#api.schedule(),
        this.#api.discoveryQueue?.() ?? Promise.resolve([]),
        this.#api.safetyStatus?.() ?? Promise.resolve(null),
        requestedId === undefined || requestedId === null
          ? Promise.resolve(null)
          : this.#api.session(requestedId),
      ]);
      if (lifecycle !== this.#lifecycle) return;
      const running = recent.find(
        (entry) => entry.state === "running" || entry.state === "pending",
      );
      const current =
        requestedId === undefined || requestedId === null
          ? (selected ?? running ?? null)
          : selected?.id === requestedId
            ? selected
            : null;
      this.#patch({
        phase: current !== null && !isTerminal(current) ? "running" : "ready",
        recent,
        schedule,
        queue: queue.filter((post) => post.state === "queued"),
        queueLoaded: this.#api.discoveryQueue !== undefined,
        safety,
        selectedPostIds: this.#state.selectedPostIds.filter((postId) =>
          queue.some((post) => post.id === postId && post.state === "queued"),
        ),
        current,
      });
      if (current !== null && !isTerminal(current)) this.#subscribe(current.id, lifecycle);
    } catch (error) {
      if (lifecycle !== this.#lifecycle) return;
      this.#fail(error);
    } finally {
      this.#loadInFlight = false;
      const pending = this.#pendingLoadOptions;
      this.#pendingLoadOptions = null;
      if (pending !== null) void this.load(pending);
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
    if (!Number.isInteger(value) || value < 1 || value > 50) return;
    this.#patch({ maxPosts: value });
  }

  /** Choose the source defaults used when no exact queue card is selected. */
  setSources(sources: DiscoverySource[]): void {
    if (sources.length === 0 || sources.length > 2 || new Set(sources).size !== sources.length) {
      return;
    }
    this.#patch({ sources });
  }

  /** Toggle one queued post while retaining the user's selection order. */
  togglePost(postId: string): void {
    if (!this.#state.queue.some((post) => post.id === postId)) return;
    const selected = this.#state.selectedPostIds;
    if (!selected.includes(postId) && selected.length >= 50) return;
    this.#patch({
      selectedPostIds: selected.includes(postId)
        ? selected.filter((id) => id !== postId)
        : [...selected, postId],
    });
  }

  /** Seed the batch preview from the workbench without changing its selection order. */
  setSelectedPosts(postIds: readonly string[]): void {
    const unique = [...new Set(postIds)].slice(0, 50);
    this.#patch({ selectedPostIds: unique });
  }

  /** Seed the batch approval choices selected in the workbench preflight. */
  setApprovedSteps(steps: readonly EngagementStepName[]): void {
    const selected = new Set(steps);
    const ordered: EngagementStepName[] = ["like", "comment", "mutual_neighbor"];
    const approvedSteps = ordered.filter((step) => selected.has(step));
    if (approvedSteps.length === 0) return;
    this.#patch({ approvedSteps });
  }

  /** Approve one batch and follow its progress. */
  async start(): Promise<void> {
    if (isSessionBusy(this.#state)) return;
    const lifecycle = ++this.#lifecycle;
    this.#closed = false;
    this.#invalidateStream();
    this.#patch({
      phase: "starting",
      error: null,
      completedPosts: [],
      cancelRequested: false,
    });
    try {
      const safety = this.#api.safetyStatus === undefined ? null : await this.#api.safetyStatus();
      if (lifecycle !== this.#lifecycle) return;
      if (safety !== null && !canStartScope(this.#state, safety)) {
        this.#patch({
          phase: "ready",
          safety,
          error: safetyMessage(this.#state, safety),
        });
        return;
      }
      const postIds = selectedPostIds(this.#state);
      const session = await this.#api.approveSession({
        approvedSteps: this.#state.approvedSteps,
        maxPosts: postIds === undefined ? this.#state.maxPosts : postIds.length,
        sources: selectedSources(this.#state),
        ...(postIds === undefined ? {} : { postIds }),
      });
      if (lifecycle !== this.#lifecycle) return;
      this.#patch({ phase: "running", current: session, safety });
      this.#subscribe(session.id, lifecycle);
    } catch (error) {
      if (lifecycle !== this.#lifecycle) return;
      this.#fail(error);
    }
  }

  /** Ask the batch to stop before the next post. */
  async cancel(): Promise<void> {
    const current = this.#state.current;
    if (current === null || this.#state.cancelRequested) return;
    const lifecycle = this.#lifecycle;
    const sessionId = current.id;
    this.#patch({ cancelRequested: true });
    try {
      const session = await this.#api.cancelSession(sessionId);
      if (lifecycle !== this.#lifecycle || this.#state.current?.id !== sessionId) return;
      if (session.id !== sessionId) return;
      this.#patch({ current: session });
    } catch (error) {
      if (lifecycle !== this.#lifecycle || this.#state.current?.id !== sessionId) return;
      this.#patch({ cancelRequested: false });
      this.#fail(error);
    }
  }

  /** Stop following the current batch without changing its state on the service. */
  close(): void {
    this.#lifecycle += 1;
    this.#streamGeneration += 1;
    this.#closed = true;
    this.#pendingLoadOptions = null;
    this.#closeSource();
  }

  #subscribe(id: string, lifecycle: number): void {
    this.#invalidateStream();
    const streamGeneration = this.#streamGeneration;
    let source: { close(): void } | null = null;
    source = this.#stream(this.#api.sessionEventsUrl(id), {
      onEvent: (event) => {
        if (
          source === null ||
          this.#source !== source ||
          lifecycle !== this.#lifecycle ||
          streamGeneration !== this.#streamGeneration ||
          this.#state.current?.id !== id
        ) {
          return;
        }
        this.#reconnects = 0;
        if (event.event === "post_completed") {
          const payloadSessionId = event.payload.session_id;
          if (typeof payloadSessionId === "string" && payloadSessionId !== id) return;
          this.#recordPost(event.payload);
        } else {
          if (event.payload.id !== id) return;
          this.#recordSession(id, event.payload);
        }
        if (TERMINAL_SESSION_EVENTS.has(event.event)) {
          this.#closeSource();
          this.#patch({ phase: "finished" });
          void this.#refresh(id, lifecycle, streamGeneration);
        }
      },
      onError: () => {
        if (
          source === null ||
          this.#source !== source ||
          lifecycle !== this.#lifecycle ||
          streamGeneration !== this.#streamGeneration ||
          this.#state.current?.id !== id
        ) {
          return;
        }
        this.#reconnects += 1;
        if (this.#reconnects <= MAX_SESSION_RECONNECTS) return;
        this.#invalidateStream();
        void this.#readOnce(id, lifecycle, this.#streamGeneration);
      },
    });
    this.#source = source;
  }

  /** Fall back to one direct read so the screen never waits on a dead stream. */
  async #readOnce(id: string, lifecycle: number, streamGeneration: number): Promise<void> {
    if (
      lifecycle !== this.#lifecycle ||
      streamGeneration !== this.#streamGeneration ||
      this.#state.current?.id !== id
    ) {
      return;
    }
    try {
      const session = await this.#api.session(id);
      if (
        lifecycle !== this.#lifecycle ||
        streamGeneration !== this.#streamGeneration ||
        this.#state.current?.id !== id ||
        session.id !== id
      ) {
        return;
      }
      this.#patch({ current: session, phase: isTerminal(session) ? "finished" : "running" });
    } catch (error) {
      if (lifecycle !== this.#lifecycle || streamGeneration !== this.#streamGeneration) return;
      this.#fail(error);
    }
  }

  async #refresh(id: string, lifecycle: number, streamGeneration: number): Promise<void> {
    if (
      lifecycle !== this.#lifecycle ||
      streamGeneration !== this.#streamGeneration ||
      this.#state.current?.id !== id
    ) {
      return;
    }
    try {
      const recent = await this.#api.sessions(10);
      if (
        lifecycle !== this.#lifecycle ||
        streamGeneration !== this.#streamGeneration ||
        this.#state.current?.id !== id
      ) {
        return;
      }
      this.#patch({ recent });
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

  #recordSession(id: string, payload: Record<string, unknown>): void {
    if (typeof payload.id !== "string") return;
    const current = this.#state.current;
    if (current === null || current.id !== id || payload.id !== id) return;
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

  #invalidateStream(): void {
    this.#streamGeneration += 1;
    this.#closeSource();
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

/** Describe the exact post count and per-step action count that one approval covers. */
export function scopePreview(state: SessionState): {
  actionCounts: Map<EngagementStepName, number>;
  postCount: number;
} {
  const selected = selectedPostIds(state);
  const matching = state.queue.filter((post) => state.sources.includes(post.source));
  const postCount =
    selected?.length ??
    (state.queueLoaded ? Math.min(state.maxPosts, matching.length) : state.maxPosts);
  return {
    postCount,
    actionCounts: new Map(state.approvedSteps.map((step) => [step, postCount])),
  };
}

/** Return whether current caps and time rules permit the displayed batch scope. */
export function canStartScope(state: SessionState, safety: SafetyStatus | null): boolean {
  const scope = scopePreview(state);
  if (scope.postCount < 1 || scope.postCount > 50) return false;
  if (safety === null || !safety.allowedNow) return safety === null;
  return [...scope.actionCounts].every(([step, count]) => {
    const action = safety.actions.find((candidate) => candidate.name === step);
    return action !== undefined && action.remaining >= count;
  });
}

function selectedPostIds(state: SessionState): string[] | undefined {
  return state.selectedPostIds.length === 0 ? undefined : state.selectedPostIds;
}

function selectedSources(state: SessionState): DiscoverySource[] {
  const selected = selectedPostIds(state);
  if (selected === undefined) return state.sources;
  return [
    ...new Set(
      selected
        .map((id) => state.queue.find((post) => post.id === id)?.source)
        .filter((source): source is DiscoverySource => source !== undefined),
    ),
  ];
}

function safetyMessage(state: SessionState, safety: SafetyStatus): string {
  if (!safety.allowedNow) {
    return REFUSALS[safety.blockingReason ?? ""] ?? "현재 안전 정책상 배치를 시작할 수 없습니다.";
  }
  const blocked = [...scopePreview(state).actionCounts].find(([step, count]) => {
    const action = safety.actions.find((candidate) => candidate.name === step);
    return action === undefined || action.remaining < count;
  });
  return blocked === undefined
    ? "현재 안전 정책상 배치를 시작할 수 없습니다."
    : `${blocked[0] === "like" ? "공감" : blocked[0] === "comment" ? "댓글" : "서로이웃"} 잔여 상한이 선택한 글 수보다 적습니다.`;
}
