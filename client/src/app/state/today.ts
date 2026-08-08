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
  EngagementStepName,
  SafetyStatus,
  ServiceStatus,
} from "../api/types";

export type LoadPhase = "idle" | "loading" | "ready" | "failed";

export interface TodayState {
  counts: { neighbor: number; search: number; skipped: number; total: number };
  error: string | null;
  nextCursor: string | null;
  phase: LoadPhase;
  posts: DiscoveryPost[];
  query: string;
  readiness: AppReadiness | null;
  /** Whether the selected detail is open on narrow screens. Desktop keeps it visible regardless. */
  detailOpen: boolean;
  selectedPostId: string | null;
  service: ServiceStatus | null;
  session: BrowserSession | null;
  sourceFilter: DiscoverySource | "all";
  stateFilter: DiscoveryState | "all";
  sort: "newest" | "oldest";
  selectedPostIds: string[];
  approvedSteps: EngagementStepName[];
  safety: SafetyStatus | null;
}

export interface QueueCounts {
  neighbor: number;
  search: number;
  total: number;
}

export function initialTodayState(): TodayState {
  return {
    counts: { neighbor: 0, search: 0, skipped: 0, total: 0 },
    error: null,
    nextCursor: null,
    phase: "idle",
    posts: [],
    query: "",
    readiness: null,
    detailOpen: false,
    selectedPostId: null,
    service: null,
    session: null,
    sourceFilter: "neighbor",
    stateFilter: "all",
    sort: "newest",
    selectedPostIds: [],
    approvedSteps: ["like", "comment"],
    safety: null,
  };
}

export function startLoading(state: TodayState): TodayState {
  return { ...state, error: null, phase: "loading" };
}

export function withLoaded(
  state: TodayState,
  loaded: {
    posts: DiscoveryPost[];
    counts?: TodayState["counts"];
    nextCursor?: string | null;
    readiness?: AppReadiness;
    safety?: SafetyStatus | null;
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
    counts: loaded.counts ?? state.counts,
    nextCursor: loaded.nextCursor ?? null,
    phase: "ready",
    posts,
    readiness: loaded.readiness ?? state.readiness,
    // A first workbench load should show the selected card; subsequent refreshes preserve an
    // explicit close on a tablet sheet.
    detailOpen: selected !== null && (state.detailOpen || state.selectedPostId === null),
    selectedPostId: selected,
    service: loaded.service,
    session: loaded.session,
    sourceFilter: state.sourceFilter,
    stateFilter: state.stateFilter,
    sort: state.sort,
    query: state.query,
    selectedPostIds: state.selectedPostIds.filter((id) => posts.some((post) => post.id === id)),
    approvedSteps: state.approvedSteps,
    safety: loaded.safety === undefined ? state.safety : loaded.safety,
  };
}

/** Merge one cursor page while retaining the selected detail card. */
export function withMorePosts(
  state: TodayState,
  loaded: { posts: DiscoveryPost[]; nextCursor: string | null; counts?: TodayState["counts"] },
): TodayState {
  const byId = new Map(state.posts.map((post) => [post.id, post]));
  for (const post of loaded.posts) byId.set(post.id, post);
  return {
    ...state,
    counts: loaded.counts ?? state.counts,
    nextCursor: loaded.nextCursor,
    posts: [...byId.values()].toSorted(comparePosts),
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
    ? { ...state, detailOpen: true, selectedPostId: postId }
    : state;
}

export function withDetailOpen(state: TodayState, detailOpen: boolean): TodayState {
  return { ...state, detailOpen };
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

export function withQuery(state: TodayState, query: string): TodayState {
  return { ...state, query };
}

export function withSort(state: TodayState, sort: TodayState["sort"]): TodayState {
  return { ...state, sort };
}

/** Toggle a batch selection while preserving the order in which the person picked posts. */
export function withPostSelection(state: TodayState, postId: string): TodayState {
  if (!state.posts.some((post) => post.id === postId)) return state;
  const selected = state.selectedPostIds;
  if (selected.includes(postId)) {
    return { ...state, selectedPostIds: selected.filter((id) => id !== postId) };
  }
  if (selected.length >= 50) return state;
  return { ...state, selectedPostIds: [...selected, postId] };
}

/** Toggle one human-approved action while keeping at least one action in the batch scope. */
export function withApprovedStep(state: TodayState, step: EngagementStepName): TodayState {
  const selected = new Set(state.approvedSteps);
  if (selected.has(step)) selected.delete(step);
  else selected.add(step);
  if (selected.size === 0) return state;
  const ordered: EngagementStepName[] = ["like", "comment", "mutual_neighbor"];
  return { ...state, approvedSteps: ordered.filter((item) => selected.has(item)) };
}

/** Describe the exact action count and lower-bound pacing for the selected workbench rows. */
export function batchPreflight(state: TodayState): {
  actionCounts: Map<EngagementStepName, number>;
  minimumDurationSeconds: number | null;
  postCount: number;
} {
  const postCount = state.selectedPostIds.length;
  return {
    actionCounts: new Map(state.approvedSteps.map((step) => [step, postCount])),
    minimumDurationSeconds:
      state.safety === null ? null : Math.max(postCount - 1, 0) * state.safety.minIntervalSeconds,
    postCount,
  };
}

/** Return whether the visible batch preview has current safety evidence for every selected action. */
export function canContinueBatchPreflight(state: TodayState): boolean {
  const safety = state.safety;
  const preview = batchPreflight(state);
  if (preview.postCount < 1 || safety === null || !safety.allowedNow) return false;
  return [...preview.actionCounts].every(([step, count]) => {
    const action = safety.actions.find((candidate) => candidate.name === step);
    return action !== undefined && action.remaining >= count;
  });
}

export function withPostState(state: TodayState, post: DiscoveryPost): TodayState {
  const previous = state.posts.find((item) => item.id === post.id);
  if (previous === undefined) return state;
  const oldContribution = postCountContribution(previous);
  const newContribution = postCountContribution(post);
  return {
    ...state,
    counts: {
      neighbor: state.counts.neighbor + newContribution.neighbor - oldContribution.neighbor,
      search: state.counts.search + newContribution.search - oldContribution.search,
      skipped: state.counts.skipped + newContribution.skipped - oldContribution.skipped,
      total: state.counts.total + newContribution.total - oldContribution.total,
    },
    posts: state.posts.map((item) =>
      item.id === post.id
        ? { ...post, sourceLabel: post.sourceLabel ?? item.sourceLabel ?? null }
        : item,
    ),
  };
}

function postCountContribution(post: DiscoveryPost): TodayState["counts"] {
  const tracked = post.state === "queued" || post.state === "opened" || post.state === "skipped";
  if (!tracked) return { neighbor: 0, search: 0, skipped: 0, total: 0 };
  return {
    neighbor: post.source === "neighbor" && post.state !== "skipped" ? 1 : 0,
    search: post.source === "search" && post.state !== "skipped" ? 1 : 0,
    skipped: post.state === "skipped" ? 1 : 0,
    total: 1,
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
  const query = state.query.trim().toLocaleLowerCase();
  return state.posts
    .filter(
      (post) =>
        (state.sourceFilter === "all" || post.source === state.sourceFilter) &&
        (state.stateFilter === "all" || post.state === state.stateFilter) &&
        (query.length === 0 ||
          [post.title, post.publisherName, post.publisherBlogId, post.sourceLabel]
            .filter((value): value is string => typeof value === "string")
            .some((value) => value.toLocaleLowerCase().includes(query))),
    )
    .toSorted((left, right) =>
      state.sort === "newest" ? comparePosts(left, right) : comparePosts(right, left),
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
