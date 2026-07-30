/**
 * Today controller.
 *
 * Owns the request lifecycle and keeps the view a pure function of state. Session lifecycle actions
 * never bypass the service: a rejected launch or close surfaces as a message instead of a retry.
 */

import { ApiError, LocalApiClient } from "../api/client";
import type { ArticleExtraction } from "../api/types";
import {
  type TodayState,
  initialTodayState,
  selectedPost,
  startLoading,
  withFailure,
  withLoaded,
  withSelection,
  withSession,
} from "../state/today";
import { type TodayHandlers, renderToday } from "../views/today";

type TodayApi = Pick<
  LocalApiClient,
  | "browserSession"
  | "closeBrowserSession"
  | "discoveryQueue"
  | "extractArticle"
  | "focusBrowserSession"
  | "launchBrowserSession"
  | "status"
>;

export interface TodayControllerOptions {
  api?: TodayApi;
  onExtracted?: (extraction: ArticleExtraction) => void;
}

export class TodayController {
  readonly #api: TodayApi;
  readonly #root: Element;
  readonly #onExtracted: (extraction: ArticleExtraction) => void;
  #state: TodayState = initialTodayState();
  #busy = false;

  constructor(root: Element, options: TodayControllerOptions = {}) {
    this.#root = root;
    this.#api = options.api ?? new LocalApiClient();
    this.#onExtracted = options.onExtracted ?? (() => undefined);
  }

  get state(): TodayState {
    return this.#state;
  }

  /** Load the service status, queue, and session, then render once. */
  async load(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.#update(startLoading(this.#state));
    try {
      const [service, posts, session] = await Promise.all([
        this.#api.status(),
        this.#api.discoveryQueue(),
        this.#api.browserSession(),
      ]);
      this.#update(withLoaded(this.#state, { posts, service, session }));
    } catch (error) {
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
      onRefresh: () => void this.load(),
      onSelectPost: (postId: string) => this.#update(withSelection(this.#state, postId)),
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
    this.#busy = true;
    try {
      const extraction = await this.#api.extractArticle(post.sourceUrl);
      this.#onExtracted(extraction);
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
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.problem?.detail ?? error.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}
