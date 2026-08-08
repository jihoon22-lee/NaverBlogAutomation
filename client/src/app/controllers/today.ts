/**
 * Today controller.
 *
 * Owns the request lifecycle and keeps the view a pure function of state. Session lifecycle actions
 * never bypass the service: a rejected launch or close surfaces as a message instead of a retry.
 */

import { ApiError, LocalApiClient } from "../api/client";
import type {
  ArticleExtraction,
  DiscoveryPost,
  DiscoveryQueuePage,
  DiscoverySource,
  DiscoveryState,
  EngagementStepName,
} from "../api/types";
import {
  type TodayState,
  initialTodayState,
  selectedPost,
  startLoading,
  withFailure,
  withLoaded,
  withMorePosts,
  withApprovedStep,
  withDetailOpen,
  withFilters,
  withPostSelection,
  withPostState,
  withQuery,
  withSelection,
  withSession,
  withSort,
} from "../state/today";
import type { SettingsSection } from "./settings";
import { type TodayHandlers, renderHome, renderToday } from "../views/today";

type TodayApi = Pick<
  LocalApiClient,
  | "browserSession"
  | "appReadiness"
  | "closeBrowserSession"
  | "extractArticle"
  | "focusBrowserSession"
  | "launchBrowserSession"
  | "status"
  | "updateDiscoveryPostState"
> &
  Partial<Pick<LocalApiClient, "discoveryQueue" | "discoveryQueuePage" | "safetyStatus">>;

export interface BatchPreflightRequest {
  approvedSteps: EngagementStepName[];
  postIds: string[];
}

export interface TodayControllerOptions {
  api?: TodayApi;
  onDiscoveryPostOpened?: (post: DiscoveryPost) => void;
  onDirectUrlOpened?: (url: string) => void;
  onExtracted?: (extraction: ArticleExtraction, post: DiscoveryPost | null) => void;
  onRemotePairingRequired?: () => void;
  onSettingsRequested?: (section?: SettingsSection) => void;
  onWorkbenchRequested?: () => void;
  onBatchRequested?: (request: BatchPreflightRequest) => void;
}

export class TodayController {
  readonly #api: TodayApi;
  readonly #onDiscoveryPostOpened: ((post: DiscoveryPost) => void) | null;
  readonly #onDirectUrlOpened: ((url: string) => void) | null;
  readonly #root: Element;
  readonly #onExtracted: (extraction: ArticleExtraction, post: DiscoveryPost | null) => void;
  readonly #onRemotePairingRequired: () => void;
  readonly #onSettingsRequested: (section?: SettingsSection) => void;
  readonly #onWorkbenchRequested: () => void;
  readonly #onBatchRequested: (request: BatchPreflightRequest) => void;
  #state: TodayState = initialTodayState();
  #busy = false;
  #view: "home" | "workbench" = "workbench";

  constructor(root: Element, options: TodayControllerOptions = {}) {
    this.#root = root;
    this.#api = options.api ?? new LocalApiClient();
    this.#onDiscoveryPostOpened = options.onDiscoveryPostOpened ?? null;
    this.#onDirectUrlOpened = options.onDirectUrlOpened ?? null;
    this.#onExtracted = options.onExtracted ?? (() => undefined);
    this.#onRemotePairingRequired = options.onRemotePairingRequired ?? (() => undefined);
    this.#onSettingsRequested = options.onSettingsRequested ?? (() => undefined);
    this.#onWorkbenchRequested = options.onWorkbenchRequested ?? (() => undefined);
    this.#onBatchRequested = options.onBatchRequested ?? (() => undefined);
  }

  get state(): TodayState {
    return this.#state;
  }

  /** Load the service status, queue, and session, then render once. */
  async load(options: { selectedPostId?: string } = {}): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.#update(startLoading(this.#state));
    try {
      const [readiness, service, page, session, safety] = await Promise.all([
        this.#readinessOrNull(),
        this.#api.status(),
        this.#queuePage(),
        this.#api.browserSession(),
        this.#safetyOrNull(),
      ]);
      const loaded = withLoaded(
        this.#state,
        readiness === null
          ? {
              posts: page.items,
              counts: page.counts,
              nextCursor: page.nextCursor,
              safety,
              service,
              session,
            }
          : {
              posts: page.items,
              counts: page.counts,
              nextCursor: page.nextCursor,
              readiness,
              safety,
              service,
              session,
            },
      );
      this.#update(
        options.selectedPostId === undefined
          ? loaded
          : withSelection(loaded, options.selectedPostId),
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "remote_pairing_required") {
        this.#onRemotePairingRequired();
        return;
      }
      this.#update(withFailure(this.#state, describe(error)));
    } finally {
      this.#busy = false;
    }
  }

  /** Render the current state without contacting the service. */
  render(): void {
    const render = this.#view === "home" ? renderHome : renderToday;
    render(this.#root, this.#state, this.#handlers());
  }

  /** Switch between the summary-only home and the queue-owning workbench without discarding state. */
  setView(view: "home" | "workbench"): void {
    this.#view = view;
  }

  #handlers(): TodayHandlers {
    return {
      onCloseSession: () => void this.#session(() => this.#api.closeBrowserSession()),
      onFocusSession: () => void this.#session(() => this.#api.focusBrowserSession()),
      onLaunchSession: () => void this.#session(() => this.#api.launchBrowserSession()),
      onLoadMore: () => void this.loadMore(),
      onOpenPost: (postId: string) => void this.openPost(postId),
      onOpenDirectUrl: (url: string) => void this.openDirectUrl(url),
      onOpenWorkbench: this.#onWorkbenchRequested,
      onOpenBatch: () =>
        this.#onBatchRequested({
          approvedSteps: this.#state.approvedSteps,
          postIds: this.#state.selectedPostIds,
        }),
      onOpenSettings: this.#onSettingsRequested,
      onCloseDetail: () => this.#update(withDetailOpen(this.#state, false)),
      onPostStateChange: (postId, state) => void this.changePostState(postId, state),
      onRefresh: () => void this.load(),
      onSelectPost: (postId: string) => this.#update(withSelection(this.#state, postId)),
      onFilterChange: (filter, value) => this.setFilter(filter, value),
      onSegmentChange: (segment) => this.setSegment(segment),
      onQueryChange: (value) => this.setQuery(value),
      onSortChange: (value) => this.setSort(value),
      onTogglePostSelection: (postId) => this.#update(withPostSelection(this.#state, postId)),
      onToggleBatchStep: (step) => this.#update(withApprovedStep(this.#state, step)),
    };
  }

  async #session(action: () => Promise<Awaited<ReturnType<TodayApi["browserSession"]>>>) {
    if (this.#busy) return;
    this.#busy = true;
    try {
      this.#update(withSession(this.#state, await action()));
    } catch (error) {
      this.#update(withFailure(this.#state, describe(error)));
    } finally {
      this.#busy = false;
    }
  }

  /** Extract the selected post so the comment workspace can continue with it. */
  async openPost(postId: string): Promise<ArticleExtraction | null> {
    const next = withSelection(this.#state, postId);
    this.#update(next);
    const post = selectedPost(next);
    if (post === null || this.#busy) return null;
    if (this.#onDiscoveryPostOpened !== null) {
      this.#onDiscoveryPostOpened(post);
      return null;
    }
    this.#busy = true;
    try {
      const extraction = await this.#api.extractArticle(post.sourceUrl);
      this.#onExtracted(extraction, post);
      return extraction;
    } catch (error) {
      this.#update(withFailure(this.#state, describe(error)));
      return null;
    } finally {
      this.#busy = false;
    }
  }

  async changePostState(postId: string, state: DiscoveryState): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      this.#update(
        withPostState(this.#state, await this.#api.updateDiscoveryPostState(postId, state)),
      );
    } catch (error) {
      this.#update(withFailure(this.#state, describe(error)));
    } finally {
      this.#busy = false;
    }
  }

  async setFilter(filter: "source" | "state", value: string): Promise<void> {
    this.#state = withFilters(
      this.#state,
      filter === "source"
        ? { source: value as DiscoverySource | "all" }
        : { state: value as DiscoveryState | "all" },
    );
    await this.load();
  }

  async setSegment(segment: "neighbor" | "search" | "skipped"): Promise<void> {
    this.#state = withFilters(
      this.#state,
      segment === "skipped"
        ? { source: "all", state: "skipped" }
        : { source: segment, state: "all" },
    );
    await this.load();
  }

  async setQuery(value: string): Promise<void> {
    this.#state = withQuery(this.#state, value);
    await this.load();
  }

  setSort(value: "newest" | "oldest"): void {
    this.#update(withSort(this.#state, value));
  }

  async loadMore(): Promise<void> {
    const cursor = this.#state.nextCursor;
    if (cursor === null || this.#busy) return;
    this.#busy = true;
    try {
      const page = await this.#queuePage(cursor);
      this.#update(
        withMorePosts(this.#state, {
          posts: page.items,
          counts: page.counts,
          nextCursor: page.nextCursor,
        }),
      );
    } catch (error) {
      this.#update(withFailure(this.#state, describe(error)));
    } finally {
      this.#busy = false;
    }
  }

  async #queuePage(cursor?: string): Promise<DiscoveryQueuePage> {
    if (this.#api.discoveryQueuePage !== undefined) {
      return this.#api.discoveryQueuePage({
        ...(this.#state.sourceFilter === "all" ? {} : { source: this.#state.sourceFilter }),
        ...(this.#state.stateFilter === "all" ? {} : { state: this.#state.stateFilter }),
        ...(this.#state.query.trim().length === 0 ? {} : { query: this.#state.query }),
        ...(cursor === undefined ? {} : { cursor }),
      });
    }
    const items = await this.#api.discoveryQueue?.();
    if (items === undefined) throw new Error("discovery_queue_unavailable");
    const query = this.#state.query.trim().toLocaleLowerCase();
    const visible = items.filter(
      (item) =>
        (this.#state.sourceFilter === "all" || item.source === this.#state.sourceFilter) &&
        (this.#state.stateFilter === "all" || item.state === this.#state.stateFilter) &&
        (query.length === 0 ||
          [item.title, item.publisherName, item.publisherBlogId, item.sourceLabel]
            .filter((value): value is string => typeof value === "string")
            .some((value) => value.toLocaleLowerCase().includes(query))),
    );
    return {
      items: visible,
      counts: {
        neighbor: items.filter((item) => item.source === "neighbor" && item.state !== "skipped")
          .length,
        search: items.filter((item) => item.source === "search" && item.state !== "skipped").length,
        skipped: items.filter((item) => item.state === "skipped").length,
        total: items.length,
      },
      nextCursor: null,
    };
  }

  /** Open a user-supplied Naver URL for generation and copy only; it has no queue record to run. */
  async openDirectUrl(url: string): Promise<ArticleExtraction | null> {
    if (this.#busy || url.trim().length === 0) return null;
    if (this.#onDirectUrlOpened !== null) {
      this.#onDirectUrlOpened(url.trim());
      return null;
    }
    this.#busy = true;
    try {
      const extraction = await this.#api.extractArticle(url.trim());
      this.#onExtracted(extraction, null);
      return extraction;
    } catch (error) {
      this.#update(withFailure(this.#state, describe(error)));
      return null;
    } finally {
      this.#busy = false;
    }
  }

  #update(state: TodayState): void {
    this.#state = state;
    this.render();
  }

  async #readinessOrNull(): Promise<TodayState["readiness"]> {
    try {
      return await this.#api.appReadiness();
    } catch {
      // Older local builds and focused test doubles can still provide the main workspace endpoints.
      return null;
    }
  }

  async #safetyOrNull(): Promise<TodayState["safety"]> {
    try {
      return this.#api.safetyStatus === undefined ? null : await this.#api.safetyStatus();
    } catch {
      // The preview stays disabled rather than presenting stale or invented safety limits.
      return null;
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.problem?.detail ?? error.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}
