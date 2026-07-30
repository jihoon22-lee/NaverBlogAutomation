import { describe, expect, it } from "vitest";

import type { BrowserSession, DiscoveryPost, ServiceStatus } from "../../src/app/api/types";
import {
  canOpenSelected,
  initialTodayState,
  queueCounts,
  selectedPost,
  startLoading,
  withFailure,
  withLoaded,
  withSelection,
  withSession,
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
