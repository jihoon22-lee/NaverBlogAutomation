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
  DiscoverySource,
  DiscoveryState,
} from "../api/types";
import {
  type TodayState,
  initialTodayState,
  selectedPost,
  startLoading,
  withFailure,
  withLoaded,
  withFilters,
  withPostState,
  withSelection,
  withSession,
} from "../state/today";
import { type TodayHandlers, renderToday } from "../views/today";

type TodayApi = Pick<
  LocalApiClient,
  | "browserSession"
  | "appReadiness"
  | "closeBrowserSession"
  | "discoveryQueue"
  | "extractArticle"
  | "focusBrowserSession"
  | "launchBrowserSession"
  | "status"
  | "updateDiscoveryPostState"
>;

export interface TodayControllerOptions {
  api?: TodayApi;
  onDiscoveryPostOpened?: (post: DiscoveryPost) => void;
  onDirectUrlOpened?: (url: string) => void;
  onExtracted?: (extraction: ArticleExtraction, post: DiscoveryPost | null) => void;
  onRemotePairingRequired?: () => void;
  onSettingsRequested?: () => void;
}

export class TodayController {
  readonly #api: TodayApi;
  readonly #onDiscoveryPostOpened: ((post: DiscoveryPost) => void) | null;
  readonly #onDirectUrlOpened: ((url: string) => void) | null;
  readonly #root: Element;
  readonly #onExtracted: (extraction: ArticleExtraction, post: DiscoveryPost | null) => void;
  readonly #onRemotePairingRequired: () => void;
  readonly #onSettingsRequested: () => void;
  #state: TodayState = initialTodayState();
  #busy = false;

  constructor(root: Element, options: TodayControllerOptions = {}) {
    this.#root = root;
    this.#api = options.api ?? new LocalApiClient();
    this.#onDiscoveryPostOpened = options.onDiscoveryPostOpened ?? null;
    this.#onDirectUrlOpened = options.onDirectUrlOpened ?? null;
    this.#onExtracted = options.onExtracted ?? (() => undefined);
    this.#onRemotePairingRequired = options.onRemotePairingRequired ?? (() => undefined);
    this.#onSettingsRequested = options.onSettingsRequested ?? (() => undefined);
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
      const [readiness, service, posts, session] = await Promise.all([
        this.#readinessOrNull(),
        this.#api.status(),
        this.#api.discoveryQueue(),
        this.#api.browserSession(),
      ]);
      const loaded = withLoaded(
        this.#state,
        readiness === null ? { posts, service, session } : { posts, readiness, service, session },
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
    renderToday(this.#root, this.#state, this.#handlers());
  }

  #handlers(): TodayHandlers {
    return {
      onCloseSession: () => void this.#session(() => this.#api.closeBrowserSession()),
      onFocusSession: () => void this.#session(() => this.#api.focusBrowserSession()),
      onLaunchSession: () => void this.#session(() => this.#api.launchBrowserSession()),
      onOpenPost: (postId: string) => void this.openPost(postId),
      onOpenDirectUrl: (url: string) => void this.openDirectUrl(url),
      onOpenSettings: this.#onSettingsRequested,
      onPostStateChange: (postId, state) => void this.changePostState(postId, state),
      onRefresh: () => void this.load(),
      onSelectPost: (postId: string) => this.#update(withSelection(this.#state, postId)),
      onFilterChange: (filter, value) =>
        this.#update(
          withFilters(
            this.#state,
            filter === "source"
              ? { source: value as DiscoverySource | "all" }
              : { state: value as DiscoveryState | "all" },
          ),
        ),
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
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.problem?.detail ?? error.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}
