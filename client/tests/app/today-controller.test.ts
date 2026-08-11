import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../src/app/api/client";
import type {
  ArticleExtraction,
  BrowserSession,
  DiscoveryPost,
  DiscoveryQueuePage,
  ServiceStatus,
} from "../../src/app/api/types";
import { TodayController } from "../../src/app/controllers/today";

beforeEach(() => {
  document.body.innerHTML = '<main id="workspace"></main>';
});

const SERVICE: ServiceStatus = {
  status: "ready",
  apiVersion: "v1",
  appEnvironment: "test",
  database: "ready",
  generatorMode: "fake",
  generatorModel: "fake",
};

const SESSION: BrowserSession = {
  state: "ready",
  login: "authenticated",
  driver: "fake",
  headless: true,
  profileDir: "profile",
  openPages: 1,
  detail: null,
};

const POST: DiscoveryPost = {
  id: "post-a",
  source: "neighbor",
  state: "queued",
  sourceUrl: "https://example.test/a",
  title: "합성 글",
  publisherName: "작성자",
  publisherBlogId: "author",
  sourceLabel: "이웃",
  publishedAt: "2026-08-01T00:00:00Z",
  createdAt: "2026-07-31T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

const EXTRACTION: ArticleExtraction = {
  sourceUrl: POST.sourceUrl,
  title: POST.title,
  selectorKind: "modern",
  originalLength: 100,
  transmittedLength: 100,
  truncated: false,
  preview: "본문",
};

const EMPTY_PAGE: DiscoveryQueuePage = {
  items: [],
  counts: { neighbor: 0, search: 0, skipped: 0, total: 0 },
  nextCursor: null,
};

function controllerApi(overrides: Record<string, unknown> = {}) {
  return {
    appReadiness: vi.fn(async () => null),
    browserSession: vi.fn(async () => SESSION),
    discoveryQueuePage: vi.fn(async () => EMPTY_PAGE),
    status: vi.fn(async () => SERVICE),
    extractArticle: vi.fn(async () => EXTRACTION),
    updateDiscoveryPostState: vi.fn(async (_id: string, state: string) => ({
      ...POST,
      state,
    })),
    ...overrides,
  };
}

describe("TodayController home navigation", () => {
  it("forwards the home writing action to its navigation callback", () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onWritingRequested = vi.fn();
    const controller = new TodayController(root, {
      api: {} as never,
      onWritingRequested,
    });

    controller.setView("home");
    controller.render();
    const action = document.getElementById("home-start-writing") as HTMLButtonElement | null;
    expect(action).not.toBeNull();
    action?.click();

    expect(onWritingRequested).toHaveBeenCalledOnce();
  });

  it("forwards a blocker action to the onboarding navigation callback", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onOnboardingRequested = vi.fn();
    const controller = new TodayController(root, {
      api: {
        appReadiness: vi.fn(async () => ({
          accessMode: "local",
          webAppAssetsReady: true,
          lanAddresses: [],
          browserState: "ready",
          browserLogin: "authenticated",
          ownBlogConfigured: true,
          generationAvailable: false,
          automationConsent: true,
          safetyPolicyConfigured: true,
          blockers: ["llm_provider_missing"],
        })),
        browserSession: vi.fn(async () => ({
          state: "ready",
          login: "authenticated",
          driver: "fake",
          headless: true,
          profileDir: "profile",
          openPages: 1,
          detail: null,
        })),
        discoveryQueue: vi.fn(async () => []),
        status: vi.fn(async () => ({
          status: "ready",
          apiVersion: "v1",
          appEnvironment: "test",
          database: "ready",
          generatorMode: "fake",
          generatorModel: "fake",
        })),
      } as never,
      onOnboardingRequested,
    });

    controller.setView("home");
    await controller.load();
    (document.getElementById("home-open-onboarding") as HTMLButtonElement).click();

    expect(onOnboardingRequested).toHaveBeenCalledOnce();
  });

  it("renders the independent onboarding view and forwards completion", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onOnboardingCompleted = vi.fn();
    const controller = new TodayController(root, {
      api: {
        appReadiness: vi.fn(async () => ({
          accessMode: "local",
          webAppAssetsReady: true,
          lanAddresses: [],
          browserState: "ready",
          browserLogin: "authenticated",
          ownBlogConfigured: true,
          generationAvailable: true,
          automationConsent: true,
          safetyPolicyConfigured: true,
          blockers: [],
        })),
        browserSession: vi.fn(async () => ({
          state: "ready",
          login: "authenticated",
          driver: "fake",
          headless: true,
          profileDir: "profile",
          openPages: 1,
          detail: null,
        })),
        discoveryQueue: vi.fn(async () => []),
        status: vi.fn(async () => ({
          status: "ready",
          apiVersion: "v1",
          appEnvironment: "test",
          database: "ready",
          generatorMode: "fake",
          generatorModel: "fake",
        })),
      } as never,
      onOnboardingCompleted,
    });

    controller.setView("onboarding");
    await controller.load();

    expect(document.querySelector(".onboarding-shell")).not.toBeNull();
    (document.getElementById("onboarding-complete-button") as HTMLButtonElement).click();
    expect(onOnboardingCompleted).toHaveBeenCalledOnce();
  });
});

describe("TodayController workbench controls", () => {
  it("applies the latest selected post after one in-flight load without another request", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const first = {
      id: "post-a",
      source: "neighbor" as const,
      state: "queued" as const,
      sourceUrl: "https://example.test/a",
      title: "첫 번째 글",
      publisherName: "작성자 A",
      publisherBlogId: "a",
      publishedAt: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    };
    const second = {
      ...first,
      id: "post-b",
      sourceUrl: "https://example.test/b",
      title: "두 번째 글",
    };
    let releaseQueue!: (value: {
      items: (typeof first)[];
      counts: { neighbor: number; search: number; skipped: number; total: number };
      nextCursor: null;
    }) => void;
    const queue = vi.fn(
      () =>
        new Promise<{
          items: (typeof first)[];
          counts: { neighbor: number; search: number; skipped: number; total: number };
          nextCursor: null;
        }>((resolve) => {
          releaseQueue = resolve;
        }),
    );
    const controller = new TodayController(root, {
      api: {
        browserSession: vi.fn(async () => ({
          state: "ready",
          login: "authenticated",
          driver: "fake",
          headless: true,
          profileDir: "profile",
          openPages: 1,
          detail: null,
        })),
        discoveryQueuePage: queue as never,
        status: vi.fn(async () => ({
          status: "ready",
          apiVersion: "v1",
          appEnvironment: "test",
          database: "ready",
          generatorMode: "fake",
          generatorModel: "fake",
        })),
      } as never,
    });

    const load = controller.load();
    await Promise.resolve();
    await controller.load({ selectedPostId: first.id });
    await controller.load({ selectedPostId: second.id });

    expect(queue).toHaveBeenCalledOnce();
    releaseQueue({
      items: [first, second],
      counts: { neighbor: 2, search: 0, skipped: 0, total: 2 },
      nextCursor: null,
    });
    await load;

    expect(controller.state.selectedPostId).toBe(second.id);
    expect(controller.state.detailOpen).toBe(true);
    expect(queue).toHaveBeenCalledOnce();
  });

  it("applies a latest base workbench route by closing detail without reloading", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    let releaseQueue!: (value: {
      items: never[];
      counts: { neighbor: number; search: number; skipped: number; total: number };
      nextCursor: null;
    }) => void;
    const queue = vi.fn(
      () =>
        new Promise<{
          items: never[];
          counts: { neighbor: number; search: number; skipped: number; total: number };
          nextCursor: null;
        }>((resolve) => {
          releaseQueue = resolve;
        }),
    );
    const controller = new TodayController(root, {
      api: {
        browserSession: vi.fn(async () => ({
          state: "ready",
          login: "authenticated",
          driver: "fake",
          headless: true,
          profileDir: "profile",
          openPages: 1,
          detail: null,
        })),
        discoveryQueuePage: queue as never,
        status: vi.fn(async () => ({
          status: "ready",
          apiVersion: "v1",
          appEnvironment: "test",
          database: "ready",
          generatorMode: "fake",
          generatorModel: "fake",
        })),
      } as never,
    });

    const load = controller.load();
    await Promise.resolve();
    await controller.load({ selectedPostId: "post-detail" });
    await controller.load({ selectedPostId: null });

    expect(queue).toHaveBeenCalledOnce();
    releaseQueue({
      items: [],
      counts: { neighbor: 0, search: 0, skipped: 0, total: 0 },
      nextCursor: null,
    });
    await load;

    expect(controller.state.detailOpen).toBe(false);
    expect(queue).toHaveBeenCalledOnce();
  });

  it("clears queue controls and reloads the default neighbor scope once", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const queue = vi.fn(async (_options: { source?: string; state?: string; query?: string }) => ({
      items: [],
      counts: { neighbor: 0, search: 0, skipped: 0, total: 0 },
      nextCursor: null,
    }));
    const controller = new TodayController(root, {
      api: {
        browserSession: vi.fn(async () => ({
          state: "ready",
          login: "authenticated",
          driver: "fake",
          headless: true,
          profileDir: "profile",
          openPages: 1,
          detail: null,
        })),
        discoveryQueuePage: queue as never,
        status: vi.fn(async () => ({
          status: "ready",
          apiVersion: "v1",
          appEnvironment: "test",
          database: "ready",
          generatorMode: "fake",
          generatorModel: "fake",
        })),
      } as never,
    });

    await controller.load();
    await controller.setFilter("source", "search");
    await controller.setFilter("state", "skipped");
    await controller.setQuery("찾을 글");
    controller.setSort("oldest");
    const callsBeforeReset = queue.mock.calls.length;

    await controller.clearFilters();

    expect(queue).toHaveBeenCalledTimes(callsBeforeReset + 1);
    expect(queue.mock.lastCall?.[0]).toEqual({ source: "neighbor" });
    expect(controller.state.query).toBe("");
    expect(controller.state.sourceFilter).toBe("neighbor");
    expect(controller.state.stateFilter).toBe("all");
    expect(controller.state.sort).toBe("newest");
    expect(document.activeElement?.id).toBe("queue-query");
  });

  it("keeps focus on a queue control while its request rerenders the workbench", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const controller = new TodayController(root, {
      api: {
        browserSession: vi.fn(async () => ({
          state: "ready",
          login: "authenticated",
          driver: "fake",
          headless: true,
          profileDir: "profile",
          openPages: 1,
          detail: null,
        })),
        discoveryQueuePage: vi.fn(async () => ({
          items: [],
          counts: { neighbor: 0, search: 0, skipped: 0, total: 0 },
          nextCursor: null,
        })),
        status: vi.fn(async () => ({
          status: "ready",
          apiVersion: "v1",
          appEnvironment: "test",
          database: "ready",
          generatorMode: "fake",
          generatorModel: "fake",
        })),
      } as never,
    });
    await controller.load();
    const query = document.getElementById("queue-query") as HTMLInputElement;
    query.focus();

    await controller.setQuery("검색어");

    expect(document.activeElement?.id).toBe("queue-query");
  });

  it("does not mutate filters or start a second queue request while a load is busy", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const deferred: {
      release:
        | ((page: {
            items: never[];
            counts: { neighbor: number; search: number; skipped: number; total: number };
            nextCursor: null;
          }) => void)
        | null;
    } = { release: null };
    const queue = vi.fn(
      () =>
        new Promise<{
          items: never[];
          counts: { neighbor: number; search: number; skipped: number; total: number };
          nextCursor: null;
        }>((resolve) => {
          deferred.release = resolve;
        }),
    );
    const controller = new TodayController(root, {
      api: {
        browserSession: vi.fn(async () => ({
          state: "ready",
          login: "authenticated",
          driver: "fake",
          headless: true,
          profileDir: "profile",
          openPages: 1,
          detail: null,
        })),
        discoveryQueuePage: queue as never,
        status: vi.fn(async () => ({
          status: "ready",
          apiVersion: "v1",
          appEnvironment: "test",
          database: "ready",
          generatorMode: "fake",
          generatorModel: "fake",
        })),
      } as never,
    });

    const load = controller.load();
    await Promise.resolve();
    await controller.setQuery("버려질 검색어");
    await controller.setFilter("source", "search");
    await controller.setSegment("skipped");
    await controller.clearFilters();

    expect(queue).toHaveBeenCalledOnce();
    expect(controller.state.query).toBe("");
    expect(controller.state.sourceFilter).toBe("neighbor");
    expect(controller.state.stateFilter).toBe("all");
    if (deferred.release === null) throw new Error("queue did not start");
    deferred.release({
      items: [],
      counts: { neighbor: 0, search: 0, skipped: 0, total: 0 },
      nextCursor: null,
    });
    await load;
    expect(controller.state.phase).toBe("ready");
  });
});

describe("TodayController request boundaries", () => {
  it("routes a remote pairing refusal without replacing the current workspace with an error", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onRemotePairingRequired = vi.fn();
    const api = controllerApi({
      status: vi.fn(async () => {
        throw new ApiError("pairing", {
          problem: { code: "remote_pairing_required", detail: "pair first", status: 403 } as never,
          status: 403,
        });
      }),
    });
    const controller = new TodayController(root, {
      api: api as never,
      onRemotePairingRequired,
    });

    await controller.load();

    expect(onRemotePairingRequired).toHaveBeenCalledOnce();
    expect(controller.state.error).toBeNull();
    expect(controller.state.phase).toBe("loading");
  });

  it("keeps a visible failure when a queue load is rejected", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const api = controllerApi({
      discoveryQueuePage: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const controller = new TodayController(root, { api: api as never });

    await controller.load();

    expect(controller.state.phase).toBe("failed");
    expect(controller.state.error).toBe("알 수 없는 오류가 발생했습니다.");
    expect(root.textContent).toContain("알 수 없는 오류가 발생했습니다.");
  });

  it("continues loading when optional readiness and safety endpoints are unavailable", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const appReadiness = vi.fn(async () => {
      throw new Error("old build");
    });
    const safetyStatus = vi.fn(async () => {
      throw new Error("paired client");
    });
    const api = controllerApi({
      appReadiness,
      safetyStatus,
    });
    const controller = new TodayController(root, { api: api as never });

    await controller.load();

    expect(controller.state.phase).toBe("ready");
    expect(controller.state.readiness).toBeNull();
    expect(controller.state.safety).toBeNull();
    expect(appReadiness).toHaveBeenCalledOnce();
    expect(safetyStatus).toHaveBeenCalledOnce();
  });

  it("does not launch two browser actions while the first session request is pending", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    let releaseLaunch!: (session: BrowserSession) => void;
    const launchBrowserSession = vi.fn(
      () => new Promise<BrowserSession>((resolve) => (releaseLaunch = resolve)),
    );
    const api = controllerApi({
      browserSession: vi.fn(async () => ({ ...SESSION, state: "stopped" as const })),
      launchBrowserSession,
    });
    const controller = new TodayController(root, { api: api as never });
    await controller.load();

    const launch = root.querySelector<HTMLButtonElement>("#launch-session-button");
    if (launch === null) throw new Error("missing launch action");
    launch.click();
    launch.click();

    expect(launchBrowserSession).toHaveBeenCalledOnce();
    releaseLaunch({ ...SESSION, state: "ready", openPages: 2 });
    await vi.waitFor(() => expect(controller.state.session?.openPages).toBe(2));

    expect(controller.state.session?.openPages).toBe(2);
  });

  it("surfaces a browser session refusal and allows a later retry", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const launchBrowserSession = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("browser unavailable", {
          problem: {
            code: "browser_unavailable",
            detail: "브라우저를 시작할 수 없습니다.",
          } as never,
          status: 503,
        }),
      )
      .mockResolvedValueOnce(SESSION);
    const controller = new TodayController(root, {
      api: controllerApi({
        browserSession: vi.fn(async () => ({ ...SESSION, state: "stopped" as const })),
        launchBrowserSession,
      }) as never,
    });

    await controller.load();
    const launch = root.querySelector<HTMLButtonElement>("#launch-session-button");
    if (launch === null) throw new Error("missing launch action");
    launch.click();
    await vi.waitFor(() => expect(controller.state.error).toBe("브라우저를 시작할 수 없습니다."));

    expect(controller.state.error).toBe("브라우저를 시작할 수 없습니다.");
    expect(controller.state.phase).toBe("failed");

    await controller.load();
    root.querySelector<HTMLButtonElement>("#launch-session-button")?.click();
    await vi.waitFor(() => expect(launchBrowserSession).toHaveBeenCalledTimes(2));

    expect(launchBrowserSession).toHaveBeenCalledTimes(2);
    expect(controller.state.error).toBeNull();
    expect(controller.state.session).toEqual(SESSION);
  });

  it("hands a queued post to navigation before attempting extraction", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onDiscoveryPostOpened = vi.fn();
    const api = controllerApi({
      discoveryQueuePage: vi.fn(async () => ({
        items: [POST],
        counts: { neighbor: 1, search: 0, skipped: 0, total: 1 },
        nextCursor: null,
      })),
    });
    const controller = new TodayController(root, {
      api: api as never,
      onDiscoveryPostOpened,
    });
    await controller.load();

    expect(await controller.openPost(POST.id)).toBeNull();
    expect(onDiscoveryPostOpened).toHaveBeenCalledWith(POST);
    expect(api.extractArticle).not.toHaveBeenCalled();
  });

  it("extracts a queued post and reports an extraction refusal in the workbench", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onExtracted = vi.fn();
    const api = controllerApi({
      discoveryQueuePage: vi.fn(async () => ({
        items: [POST],
        counts: { neighbor: 1, search: 0, skipped: 0, total: 1 },
        nextCursor: null,
      })),
      extractArticle: vi.fn(async () => {
        throw new ApiError("extract failed", {
          problem: { code: "article_unavailable", detail: "글을 읽을 수 없습니다." } as never,
          status: 422,
        });
      }),
    });
    const controller = new TodayController(root, {
      api: api as never,
      onExtracted,
    });
    await controller.load();

    expect(await controller.openPost(POST.id)).toBeNull();
    expect(api.extractArticle).toHaveBeenCalledWith(POST.sourceUrl);
    expect(controller.state.error).toBe("글을 읽을 수 없습니다.");
    expect(onExtracted).not.toHaveBeenCalled();
  });

  it("trims direct URLs, keeps empty input local, and preserves the no-queue callback", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onDirectUrlOpened = vi.fn();
    const api = controllerApi();
    const controller = new TodayController(root, {
      api: api as never,
      onDirectUrlOpened,
    });

    expect(await controller.openDirectUrl("   ")).toBeNull();
    expect(await controller.openDirectUrl("  https://example.test/direct  ")).toBeNull();

    expect(onDirectUrlOpened).toHaveBeenCalledOnce();
    expect(onDirectUrlOpened).toHaveBeenCalledWith("https://example.test/direct");
    expect(api.extractArticle).not.toHaveBeenCalled();
  });

  it("extracts a direct URL without creating a queue record", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onExtracted = vi.fn();
    const api = controllerApi();
    const controller = new TodayController(root, {
      api: api as never,
      onExtracted,
    });

    const result = await controller.openDirectUrl("  https://example.test/direct  ");

    expect(result).toEqual(EXTRACTION);
    expect(api.extractArticle).toHaveBeenCalledWith("https://example.test/direct");
    expect(onExtracted).toHaveBeenCalledWith(EXTRACTION, null);
  });

  it("surfaces a direct URL extraction failure without invoking the workspace callback", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onExtracted = vi.fn();
    const api = controllerApi({
      extractArticle: vi.fn(async () => {
        throw new ApiError("not found", {
          problem: { code: "article_unavailable", detail: "본문을 찾지 못했습니다." } as never,
          status: 422,
        });
      }),
    });
    const controller = new TodayController(root, { api: api as never, onExtracted });

    expect(await controller.openDirectUrl("https://example.test/direct")).toBeNull();

    expect(controller.state.error).toBe("본문을 찾지 못했습니다.");
    expect(onExtracted).not.toHaveBeenCalled();
  });

  it("merges a cursor page and retains the existing queue records", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const second: DiscoveryPost = {
      ...POST,
      id: "post-b",
      title: "두 번째 글",
      sourceUrl: "https://example.test/b",
      publishedAt: "2026-08-02T00:00:00Z",
    };
    const discoveryQueuePage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [POST],
        counts: { neighbor: 1, search: 0, skipped: 0, total: 1 },
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        items: [second],
        counts: { neighbor: 2, search: 0, skipped: 0, total: 2 },
        nextCursor: null,
      });
    const controller = new TodayController(root, {
      api: controllerApi({ discoveryQueuePage }) as never,
    });

    await controller.load();
    await controller.loadMore();

    expect(discoveryQueuePage).toHaveBeenNthCalledWith(2, {
      source: "neighbor",
      cursor: "next",
    });
    expect(controller.state.posts.map((post) => post.id)).toEqual([second.id, POST.id]);
    expect(controller.state.nextCursor).toBeNull();
  });

  it("reports a cursor-page failure while preserving the already loaded queue", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const discoveryQueuePage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [POST],
        counts: { neighbor: 1, search: 0, skipped: 0, total: 1 },
        nextCursor: "next",
      })
      .mockRejectedValueOnce(new Error("offline"));
    const controller = new TodayController(root, {
      api: controllerApi({ discoveryQueuePage }) as never,
    });
    await controller.load();

    await controller.loadMore();

    expect(controller.state.phase).toBe("failed");
    expect(controller.state.posts).toEqual([POST]);
    expect(root.textContent).toContain("알 수 없는 오류가 발생했습니다.");
  });

  it("updates an existing post state and its visible counts", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const api = controllerApi({
      discoveryQueuePage: vi.fn(async () => ({
        items: [POST],
        counts: { neighbor: 1, search: 0, skipped: 0, total: 1 },
        nextCursor: null,
      })),
      updateDiscoveryPostState: vi.fn(async () => ({ ...POST, state: "skipped" as const })),
    });
    const controller = new TodayController(root, { api: api as never });
    await controller.load();

    await controller.changePostState(POST.id, "skipped");

    expect(api.updateDiscoveryPostState).toHaveBeenCalledWith(POST.id, "skipped");
    expect(controller.state.posts[0]?.state).toBe("skipped");
    expect(controller.state.counts).toEqual({ neighbor: 0, search: 0, skipped: 1, total: 1 });
  });

  it("keeps the previous post state when a state update fails", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const api = controllerApi({
      discoveryQueuePage: vi.fn(async () => ({
        items: [POST],
        counts: { neighbor: 1, search: 0, skipped: 0, total: 1 },
        nextCursor: null,
      })),
      updateDiscoveryPostState: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const controller = new TodayController(root, { api: api as never });
    await controller.load();

    await controller.changePostState(POST.id, "completed");

    expect(controller.state.posts[0]?.state).toBe("queued");
    expect(controller.state.phase).toBe("failed");
    expect(controller.state.error).toBe("알 수 없는 오류가 발생했습니다.");
  });

  it("uses the legacy queue endpoint with local filtering when paged loading is unavailable", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const searchPost: DiscoveryPost = {
      ...POST,
      id: "post-search",
      source: "search",
      title: "검색 후보",
      sourceLabel: "검색",
    };
    const discoveryQueue = vi.fn(async () => [POST, searchPost]);
    const api = controllerApi({ discoveryQueue });
    delete (api as { discoveryQueuePage?: unknown }).discoveryQueuePage;
    const controller = new TodayController(root, { api: api as never });

    await controller.load();
    expect(controller.state.posts).toEqual([POST]);

    await controller.setFilter("source", "all");
    expect(controller.state.posts.map((post) => post.id)).toEqual([POST.id, searchPost.id]);
    expect(discoveryQueue).toHaveBeenCalledTimes(2);
  });

  it("restores focus when selecting a post on a narrow workbench", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const api = controllerApi({
      discoveryQueuePage: vi.fn(async () => ({
        items: [POST],
        counts: { neighbor: 1, search: 0, skipped: 0, total: 1 },
        nextCursor: null,
      })),
    });
    const controller = new TodayController(root, { api: api as never });
    await controller.load();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    controller.render();

    root.querySelector<HTMLButtonElement>(`#queue-post-${POST.id}`)?.click();

    expect(controller.state.selectedPostId).toBe(POST.id);
    expect(controller.state.detailOpen).toBe(true);
    expect(document.activeElement?.id).toBe("close-detail-sheet");
    vi.unstubAllGlobals();
  });
});
