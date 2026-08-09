import { beforeEach, describe, expect, it, vi } from "vitest";

import { TodayController } from "../../src/app/controllers/today";

beforeEach(() => {
  document.body.innerHTML = '<main id="workspace"></main>';
});

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
