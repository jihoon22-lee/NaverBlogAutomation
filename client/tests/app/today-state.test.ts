import { describe, expect, it } from "vitest";

import type {
  BrowserSession,
  DiscoveryPost,
  SafetyStatus,
  ServiceStatus,
} from "../../src/app/api/types";
import {
  batchPreflight,
  canContinueBatchPreflight,
  canOpenSelected,
  initialTodayState,
  queueCounts,
  selectedPost,
  startLoading,
  visiblePosts,
  withApprovedStep,
  withFailure,
  withFilters,
  withLoaded,
  withMorePosts,
  withPostSelection,
  withPostState,
  withQuery,
  withSelection,
  withSession,
  withSort,
} from "../../src/app/state/today";

const SERVICE: ServiceStatus = {
  status: "ready",
  apiVersion: "1.0.0",
  appEnvironment: "test",
  database: "ready",
  generatorMode: "fake",
  generatorModel: "deterministic-fake",
};

const SESSION: BrowserSession = {
  state: "ready",
  login: "authenticated",
  driver: "patchright",
  headless: false,
  profileDir: "/profiles/automation",
  openPages: 1,
  detail: null,
};

const SAFETY: SafetyStatus = {
  localDate: "2026-08-08",
  allowedNow: true,
  blockingReason: null,
  allowedHours: [9, 10],
  minIntervalSeconds: 45,
  consecutiveFailures: 0,
  maxConsecutiveFailures: 3,
  actions: [
    { name: "like", cap: 10, used: 2, remaining: 8 },
    { name: "comment", cap: 4, used: 1, remaining: 3 },
    { name: "mutual_neighbor", cap: 2, used: 0, remaining: 2 },
  ],
};

function post(id: string, source: DiscoveryPost["source"] = "neighbor"): DiscoveryPost {
  return {
    id,
    source,
    state: "queued",
    sourceUrl: `https://blog.naver.com/example/${id}`,
    title: `합성 제목 ${id}`,
    publisherName: "합성 이웃",
    publisherBlogId: "example",
    publishedAt: null,
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
  };
}

describe("initialTodayState", () => {
  it("starts idle without data", () => {
    const state = initialTodayState();

    expect(state.phase).toBe("idle");
    expect(state.posts).toEqual([]);
    expect(state.selectedPostId).toBeNull();
    expect(state.error).toBeNull();
    expect(state.sourceFilter).toBe("neighbor");
  });
});

describe("startLoading", () => {
  it("clears the previous error", () => {
    const failed = withFailure(initialTodayState(), "실패");

    const loading = startLoading(failed);

    expect(loading.phase).toBe("loading");
    expect(loading.error).toBeNull();
  });
});

describe("withLoaded", () => {
  it("selects the first post when nothing was selected", () => {
    const state = withLoaded(initialTodayState(), {
      posts: [post("1"), post("2")],
      service: SERVICE,
      session: SESSION,
    });

    expect(state.phase).toBe("ready");
    expect(state.selectedPostId).toBe("1");
  });

  it("keeps a selection that still exists", () => {
    const first = withLoaded(initialTodayState(), {
      posts: [post("1"), post("2")],
      service: SERVICE,
      session: SESSION,
    });
    const selected = withSelection(first, "2");

    const reloaded = withLoaded(selected, {
      posts: [post("1"), post("2")],
      service: SERVICE,
      session: SESSION,
    });

    expect(reloaded.selectedPostId).toBe("2");
  });

  it("drops a selection that disappeared", () => {
    const first = withSelection(
      withLoaded(initialTodayState(), {
        posts: [post("1"), post("2")],
        service: SERVICE,
        session: SESSION,
      }),
      "2",
    );

    const reloaded = withLoaded(first, { posts: [post("1")], service: SERVICE, session: SESSION });

    expect(reloaded.selectedPostId).toBe("1");
  });

  it("clears the selection for an empty queue", () => {
    const state = withLoaded(initialTodayState(), {
      posts: [],
      service: SERVICE,
      session: SESSION,
    });

    expect(state.selectedPostId).toBeNull();
    expect(selectedPost(state)).toBeNull();
  });
});

describe("withSelection", () => {
  it("ignores an unknown post id", () => {
    const state = withLoaded(initialTodayState(), {
      posts: [post("1")],
      service: SERVICE,
      session: SESSION,
    });

    expect(withSelection(state, "missing").selectedPostId).toBe("1");
  });
});

describe("withMorePosts", () => {
  it("appends a cursor page without duplicating an existing post", () => {
    const first = withLoaded(initialTodayState(), {
      posts: [post("1")],
      nextCursor: "next",
      service: SERVICE,
      session: SESSION,
    });

    const merged = withMorePosts(first, { posts: [post("1"), post("2")], nextCursor: null });

    expect(merged.posts.map((item) => item.id)).toEqual(["1", "2"]);
    expect(merged.nextCursor).toBeNull();
    expect(merged.selectedPostId).toBe("1");
  });
});

describe("withSession", () => {
  it("replaces only the session", () => {
    const state = withLoaded(initialTodayState(), {
      posts: [post("1")],
      service: SERVICE,
      session: SESSION,
    });

    const updated = withSession(state, { ...SESSION, state: "stopped", login: "unknown" });

    expect(updated.session?.state).toBe("stopped");
    expect(updated.posts).toHaveLength(1);
    expect(updated.phase).toBe("ready");
  });
});

describe("queueCounts", () => {
  it("counts each source", () => {
    expect(queueCounts([post("1"), post("2", "search"), post("3", "search")])).toEqual({
      neighbor: 1,
      search: 2,
      total: 3,
    });
  });

  it("returns zeros for an empty queue", () => {
    expect(queueCounts([])).toEqual({ neighbor: 0, search: 0, total: 0 });
  });
});

describe("withPostState", () => {
  it("keeps workbench counts in sync when a post is skipped and restored", () => {
    const loaded = withLoaded(initialTodayState(), {
      posts: [post("neighbor"), post("search", "search")],
      counts: { neighbor: 1, search: 1, skipped: 0, total: 2 },
      service: SERVICE,
      session: SESSION,
    });

    const skipped = withPostState(loaded, { ...post("neighbor"), state: "skipped" });
    expect(skipped.counts).toEqual({ neighbor: 0, search: 1, skipped: 1, total: 2 });

    const restored = withPostState(skipped, { ...post("neighbor"), state: "queued" });
    expect(restored.counts).toEqual({ neighbor: 1, search: 1, skipped: 0, total: 2 });
  });

  it("removes completed or unavailable posts from the actionable counts", () => {
    const loaded = withLoaded(initialTodayState(), {
      posts: [post("neighbor")],
      counts: { neighbor: 1, search: 0, skipped: 0, total: 1 },
      service: SERVICE,
      session: SESSION,
    });

    expect(withPostState(loaded, { ...post("neighbor"), state: "completed" }).counts).toEqual({
      neighbor: 0,
      search: 0,
      skipped: 0,
      total: 0,
    });
  });
});

describe("workbench filters and batch selection", () => {
  it("keeps batch pick order and removes only the toggled post", () => {
    const loaded = withLoaded(initialTodayState(), {
      posts: [post("1"), post("2"), post("3")],
      service: SERVICE,
      session: SESSION,
    });

    const selected = withPostSelection(withPostSelection(loaded, "2"), "1");

    expect(selected.selectedPostIds).toEqual(["2", "1"]);
    expect(withPostSelection(selected, "2").selectedPostIds).toEqual(["1"]);
  });

  it("filters and sorts locally while a new cursor page is loading", () => {
    const loaded = withLoaded(initialTodayState(), {
      posts: [
        { ...post("old"), createdAt: "2026-07-01T00:00:00Z" },
        { ...post("search", "search"), createdAt: "2026-07-31T00:00:00Z" },
        { ...post("new"), createdAt: "2026-08-01T00:00:00Z", title: "찾는 글" },
      ],
      service: SERVICE,
      session: SESSION,
    });
    const filtered = withQuery(withFilters(loaded, { source: "neighbor" }), "찾는");

    expect(visiblePosts(filtered).map((item) => item.id)).toEqual(["new"]);
    expect(visiblePosts(withSort(withQuery(loaded, ""), "oldest")).map((item) => item.id)).toEqual([
      "old",
      "new",
    ]);
  });

  it("calculates a current per-step preflight and refuses a stale or exhausted safety scope", () => {
    const loaded = withLoaded(initialTodayState(), {
      posts: [post("1"), post("2")],
      safety: SAFETY,
      service: SERVICE,
      session: SESSION,
    });
    const selected = withPostSelection(withPostSelection(loaded, "2"), "1");
    const expanded = withApprovedStep(selected, "mutual_neighbor");

    expect(batchPreflight(expanded)).toEqual({
      actionCounts: new Map([
        ["like", 2],
        ["comment", 2],
        ["mutual_neighbor", 2],
      ]),
      minimumDurationSeconds: 45,
      postCount: 2,
    });
    expect(canContinueBatchPreflight(expanded)).toBe(true);
    expect(
      canContinueBatchPreflight({
        ...expanded,
        safety: { ...SAFETY, actions: [{ name: "like", cap: 1, used: 1, remaining: 0 }] },
      }),
    ).toBe(false);
    expect(canContinueBatchPreflight({ ...expanded, safety: null })).toBe(false);
  });
});

describe("canOpenSelected", () => {
  it("allows opening a selected post on an authenticated session", () => {
    const state = withLoaded(initialTodayState(), {
      posts: [post("1")],
      service: SERVICE,
      session: SESSION,
    });

    expect(canOpenSelected(state)).toBe(true);
  });

  it("blocks opening without a session", () => {
    const state = withLoaded(initialTodayState(), {
      posts: [post("1")],
      service: SERVICE,
      session: { ...SESSION, state: "stopped", login: "unknown", openPages: 0 },
    });

    expect(canOpenSelected(state)).toBe(false);
  });

  it("blocks opening while signed out", () => {
    const state = withLoaded(initialTodayState(), {
      posts: [post("1")],
      service: SERVICE,
      session: { ...SESSION, login: "anonymous" },
    });

    expect(canOpenSelected(state)).toBe(false);
  });

  it("blocks opening when the login state is unknown", () => {
    const state = withLoaded(initialTodayState(), {
      posts: [post("1")],
      service: SERVICE,
      session: { ...SESSION, login: "unknown" },
    });

    expect(canOpenSelected(state)).toBe(false);
  });

  it("blocks opening with an empty queue", () => {
    const state = withLoaded(initialTodayState(), {
      posts: [],
      service: SERVICE,
      session: SESSION,
    });

    expect(canOpenSelected(state)).toBe(false);
  });
});
