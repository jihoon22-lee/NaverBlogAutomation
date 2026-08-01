/**
 * Today-view state.
 *
 * The state layer holds no article body: only what the wide layout renders. Loading, error, and
 * empty states are explicit so the view never has to guess.
 */

import type {
  AppReadiness,
  BrowserSession,
  DiscoveryPost,
  DiscoverySource,
  DiscoveryState,
  ServiceStatus,
} from "../api/types";

export type LoadPhase = "idle" | "loading" | "ready" | "failed";

export interface TodayState {
  error: string | null;
  phase: LoadPhase;
  posts: DiscoveryPost[];
  readiness: AppReadiness | null;
  selectedPostId: string | null;
  service: ServiceStatus | null;
  session: BrowserSession | null;
  sourceFilter: DiscoverySource | "all";
  stateFilter: DiscoveryState | "all";
}

export interface QueueCounts {
  neighbor: number;
  search: number;
  total: number;
}

export function initialTodayState(): TodayState {
  return {
    error: null,
    phase: "idle",
    posts: [],
    readiness: null,
    selectedPostId: null,
    service: null,
    session: null,
    sourceFilter: "all",
    stateFilter: "all",
  };
}

export function startLoading(state: TodayState): TodayState {
  return { ...state, error: null, phase: "loading" };
}

export function withLoaded(
  state: TodayState,
  loaded: {
    posts: DiscoveryPost[];
    readiness?: AppReadiness;
    service: ServiceStatus;
    session: BrowserSession;
  },
): TodayState {
  const posts = [...loaded.posts].toSorted(comparePosts);
  const selected = posts.some((post) => post.id === state.selectedPostId)
    ? state.selectedPostId
    : (posts[0]?.id ?? null);
  return {
    error: null,
    phase: "ready",
    posts,
    readiness: loaded.readiness ?? state.readiness,
    selectedPostId: selected,
    service: loaded.service,
    session: loaded.session,
    sourceFilter: state.sourceFilter,
    stateFilter: state.stateFilter,
  };
}

export function withFailure(state: TodayState, message: string): TodayState {
  return { ...state, error: message, phase: "failed" };
}

export function withSession(state: TodayState, session: BrowserSession): TodayState {
  return { ...state, session };
}

export function withSelection(state: TodayState, postId: string): TodayState {
  return state.posts.some((post) => post.id === postId)
    ? { ...state, selectedPostId: postId }
    : state;
}

export function withFilters(
  state: TodayState,
  filters: { source?: DiscoverySource | "all"; state?: DiscoveryState | "all" },
): TodayState {
  return {
    ...state,
    sourceFilter: filters.source ?? state.sourceFilter,
    stateFilter: filters.state ?? state.stateFilter,
  };
}

export function withPostState(state: TodayState, post: DiscoveryPost): TodayState {
  return {
    ...state,
    posts: state.posts.map((item) => (item.id === post.id ? post : item)),
  };
}

export function queueCounts(posts: readonly DiscoveryPost[]): QueueCounts {
  const neighbor = posts.filter((post) => post.source === "neighbor").length;
  const search = posts.filter((post) => post.source === "search").length;
  return { neighbor, search, total: posts.length };
}

export function selectedPost(state: TodayState): DiscoveryPost | null {
  return state.posts.find((post) => post.id === state.selectedPostId) ?? null;
}

export function visiblePosts(state: TodayState): DiscoveryPost[] {
  return state.posts.filter(
    (post) =>
      (state.sourceFilter === "all" || post.source === state.sourceFilter) &&
      (state.stateFilter === "all" || post.state === state.stateFilter),
  );
}

/** Return true only when a post can be opened in the automation browser. */
export function canOpenSelected(state: TodayState): boolean {
  return (
    state.session?.state === "ready" &&
    state.session.login === "authenticated" &&
    selectedPost(state) !== null
  );
}

function comparePosts(left: DiscoveryPost, right: DiscoveryPost): number {
  const leftTime = left.publishedAt ?? left.createdAt;
  const rightTime = right.publishedAt ?? right.createdAt;
  return rightTime.localeCompare(leftTime);
}
