/**
 * Today-view state.
 *
 * The state layer holds no article body: only what the wide layout renders. Loading, error, and
 * empty states are explicit so the view never has to guess.
 */

import type { BrowserSession, DiscoveryPost, ServiceStatus } from "../api/types";

export type LoadPhase = "idle" | "loading" | "ready" | "failed";

export interface TodayState {
  error: string | null;
  phase: LoadPhase;
  posts: DiscoveryPost[];
  selectedPostId: string | null;
  service: ServiceStatus | null;
  session: BrowserSession | null;
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
    selectedPostId: null,
    service: null,
    session: null,
  };
}

export function startLoading(state: TodayState): TodayState {
  return { ...state, error: null, phase: "loading" };
}

export function withLoaded(
  state: TodayState,
  loaded: { posts: DiscoveryPost[]; service: ServiceStatus; session: BrowserSession },
): TodayState {
  const selected = loaded.posts.some((post) => post.id === state.selectedPostId)
    ? state.selectedPostId
    : (loaded.posts[0]?.id ?? null);
  return {
    error: null,
    phase: "ready",
    posts: loaded.posts,
    selectedPostId: selected,
    service: loaded.service,
    session: loaded.session,
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

export function queueCounts(posts: readonly DiscoveryPost[]): QueueCounts {
  const neighbor = posts.filter((post) => post.source === "neighbor").length;
  const search = posts.filter((post) => post.source === "search").length;
  return { neighbor, search, total: posts.length };
}

export function selectedPost(state: TodayState): DiscoveryPost | null {
  return state.posts.find((post) => post.id === state.selectedPostId) ?? null;
}

/** Return true only when a post can be opened in the automation browser. */
export function canOpenSelected(state: TodayState): boolean {
  return (
    state.session?.state === "ready" &&
    state.session.login === "authenticated" &&
    selectedPost(state) !== null
  );
}
