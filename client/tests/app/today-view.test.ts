import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../src/app/api/client";
import type {
  AppReadiness,
  ArticleExtraction,
  BrowserSession,
  DiscoveryPost,
  DiscoveryQueuePage,
  SafetyStatus,
  ServiceStatus,
} from "../../src/app/api/types";
import { TodayController } from "../../src/app/controllers/today";
import { initialTodayState, type TodayState } from "../../src/app/state/today";
import { renderHome, renderToday, type TodayHandlers } from "../../src/app/views/today";

const SERVICE: ServiceStatus = {
  status: "ready",
  apiVersion: "1.0.0",
  appEnvironment: "test",
  database: "ready",
  generatorMode: "fake",
  generatorModel: "deterministic-fake",
};

const READY_SESSION: BrowserSession = {
  state: "ready",
  login: "authenticated",
  driver: "patchright",
  headless: false,
  profileDir: "/profiles/automation",
  openPages: 1,
  detail: null,
};

const STOPPED_SESSION: BrowserSession = {
  ...READY_SESSION,
  state: "stopped",
  login: "unknown",
  openPages: 0,
};

const SAFETY: SafetyStatus = {
  localDate: "2026-08-08",
  allowedNow: true,
  blockingReason: null,
  allowedHours: [9, 10, 11],
  minIntervalSeconds: 30,
  consecutiveFailures: 0,
  maxConsecutiveFailures: 3,
  actions: [
    { name: "like", cap: 10, used: 4, remaining: 6 },
    { name: "comment", cap: 8, used: 2, remaining: 6 },
    { name: "mutual_neighbor", cap: 3, used: 0, remaining: 3 },
  ],
};

const EXTRACTION: ArticleExtraction = {
  sourceUrl: "https://blog.naver.com/example/1",
  title: "합성 제목",
  selectorKind: "modern",
  originalLength: 120,
  transmittedLength: 120,
  truncated: false,
  preview: "합성 본문",
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

function api(overrides: Record<string, unknown> = {}) {
  return {
    browserSession: vi.fn(async () => READY_SESSION),
    closeBrowserSession: vi.fn(async () => STOPPED_SESSION),
    discoveryQueue: vi.fn(async () => [post("1"), post("2", "search")]),
    extractArticle: vi.fn(async () => EXTRACTION),
    focusBrowserSession: vi.fn(async () => READY_SESSION),
    launchBrowserSession: vi.fn(async () => READY_SESSION),
    safetyStatus: vi.fn(async () => SAFETY),
    status: vi.fn(async () => SERVICE),
    ...overrides,
  };
}

function mountRoot(): Element {
  document.body.innerHTML = '<main id="workspace"></main>';
  return document.getElementById("workspace") as Element;
}

function text(selector: string): string {
  return document.querySelector(selector)?.textContent ?? "";
}

function handlers(): TodayHandlers {
  return {
    onCloseSession: vi.fn(),
    onFilterChange: vi.fn(),
    onFocusSession: vi.fn(),
    onLaunchSession: vi.fn(),
    onLoadMore: vi.fn(),
    onOpenBatch: vi.fn(),
    onOpenDirectUrl: vi.fn(),
    onOpenPost: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenWorkbench: vi.fn(),
    onPostStateChange: vi.fn(),
    onQueryChange: vi.fn(),
    onRefresh: vi.fn(),
    onSelectPost: vi.fn(),
    onSegmentChange: vi.fn(),
    onSortChange: vi.fn(),
    onToggleBatchStep: vi.fn(),
    onTogglePostSelection: vi.fn(),
  };
}

function readiness(blockers: AppReadiness["blockers"]): AppReadiness {
  return {
    accessMode: "local",
    automationConsent: blockers.indexOf("automation_consent_missing") < 0,
    blockers,
    browserLogin: blockers.includes("naver_login_required") ? "anonymous" : "authenticated",
    browserState: blockers.includes("browser_not_running") ? "stopped" : "ready",
    generationAvailable: !blockers.includes("llm_provider_missing"),
    lanAddresses: [],
    ownBlogConfigured: !blockers.includes("own_blog_id_missing"),
    safetyPolicyConfigured: !blockers.includes("safety_policy_missing"),
    webAppAssetsReady: !blockers.includes("web_app_assets_missing"),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("home and onboarding views", () => {
  it("renders loading, failed, empty, ready, and blocker states", () => {
    const root = mountRoot();
    const base = initialTodayState();
    const viewHandlers = handlers();

    renderHome(root, { ...base, phase: "loading" }, viewHandlers);
    expect(text("#workspace-status")).toContain("불러오는 중");
    expect(text(".home-readiness-panel")).toContain("확인하는 중");

    renderHome(root, { ...base, phase: "failed", error: null }, viewHandlers);
    expect(text("#workspace-status")).toContain("불러오지 못했습니다");

    renderHome(
      root,
      { ...base, counts: { neighbor: 0, search: 0, skipped: 0, total: 0 } },
      viewHandlers,
    );
    expect(text(".home-summary-panel")).toContain("아직 처리할 글이 없습니다");

    const ready: TodayState = {
      ...base,
      phase: "ready",
      counts: { neighbor: 2, search: 1, skipped: 0, total: 3 },
      readiness: readiness([]),
    };
    renderHome(root, ready, viewHandlers);
    expect(text(".home-readiness-panel")).toContain("시작할 준비");
    expect(text(".home-summary-panel")).toContain("처리 대기 3건");

    renderHome(
      root,
      {
        ...ready,
        readiness: readiness([
          "browser_not_running",
          "naver_login_required",
          "llm_provider_missing",
        ]),
      },
      viewHandlers,
    );
    expect(document.getElementById("home-launch-browser")).not.toBeNull();
    expect(document.getElementById("home-focus-browser")).not.toBeNull();
    expect(document.getElementById("home-llm_provider_missing")).not.toBeNull();
  });

  it("renders the workbench service/onboarding shell without a selected detail", () => {
    const root = mountRoot();
    const state = {
      ...initialTodayState(),
      phase: "ready" as const,
      readiness: readiness(["web_app_assets_missing"]),
      service: SERVICE,
      session: STOPPED_SESSION,
    };

    renderToday(root, state, handlers());

    expect(document.querySelector(".onboarding-panel")).not.toBeNull();
    expect(document.querySelector(".detail-panel")).toBeNull();
    expect(document.getElementById("launch-session-button")).not.toBeNull();
  });
});

describe("initial render", () => {
  it("shows a connecting status before loading", () => {
    const controller = new TodayController(mountRoot(), { api: api() as never });

    controller.render();

    expect(text("#workspace-status")).toContain("연결하는 중");
  });
});

describe("load", () => {
  it("renders the neighbor workbench segment with global queue counts and detail", async () => {
    const controller = new TodayController(mountRoot(), { api: api() as never });

    await controller.load();

    expect(text("#workspace-status")).toContain("대기 중인 글 2건");
    expect(document.querySelectorAll(".queue-item")).toHaveLength(1);
    expect(text("#detail-title")).toBe("합성 제목 1");
    expect(controller.state.phase).toBe("ready");
  });

  it("marks the selected queue item with aria-pressed", async () => {
    const controller = new TodayController(mountRoot(), { api: api() as never });

    await controller.load();

    const [first] = Array.from(document.querySelectorAll(".queue-item"));
    expect(first?.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders an empty queue message", async () => {
    const controller = new TodayController(mountRoot(), {
      api: api({ discoveryQueue: vi.fn(async () => []) }) as never,
    });

    await controller.load();

    expect(text("#workspace-status")).toContain("대기열이 비어 있습니다");
    expect(text(".queue-empty")).toContain("대기 중인 글이 없습니다");
    expect(document.querySelector(".detail-panel")).toBeNull();
  });

  it("shows the problem detail when the service rejects the request", async () => {
    const failing = api({
      discoveryQueue: vi.fn(async () => {
        throw new ApiError("rejected", {
          problem: {
            code: "internal_error",
            detail: "로컬 서비스가 응답하지 않습니다.",
            status: 500,
            title: "Internal error",
          },
          status: 500,
        });
      }),
    });
    const controller = new TodayController(mountRoot(), { api: failing as never });

    await controller.load();

    expect(text("#workspace-status")).toContain("응답하지 않습니다");
    expect(document.querySelector(".today-layout")).toBeNull();
    expect(controller.state.phase).toBe("failed");
  });

  it("falls back to a generic message for an unknown failure", async () => {
    const controller = new TodayController(mountRoot(), {
      api: api({
        status: vi.fn(async () => {
          throw new Error("boom");
        }),
      }) as never,
    });

    await controller.load();

    expect(text("#workspace-status")).toContain("알 수 없는 오류");
  });

  it("ignores a concurrent load", async () => {
    const client = api();
    const controller = new TodayController(mountRoot(), { api: client as never });

    await Promise.all([controller.load(), controller.load()]);

    expect(client.status).toHaveBeenCalledTimes(1);
  });
});

describe("session actions", () => {
  it("launches the browser and updates the panel", async () => {
    const client = api({ browserSession: vi.fn(async () => STOPPED_SESSION) });
    const controller = new TodayController(mountRoot(), { api: client as never });
    await controller.load();

    (document.getElementById("launch-session-button") as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(client.launchBrowserSession).toHaveBeenCalledTimes(1);
    expect(controller.state.session?.state).toBe("ready");
  });

  it("offers focus and close actions on a live session", async () => {
    const client = api();
    const controller = new TodayController(mountRoot(), { api: client as never });
    await controller.load();

    expect(document.getElementById("launch-session-button")).toBeNull();
    (document.getElementById("focus-session-button") as HTMLButtonElement).click();
    (document.getElementById("close-session-button") as HTMLButtonElement).click();
    await Promise.resolve();

    expect(client.focusBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("disables launching while the session is starting", async () => {
    const controller = new TodayController(mountRoot(), {
      api: api({
        browserSession: vi.fn(async () => ({ ...STOPPED_SESSION, state: "launching" })),
      }) as never,
    });

    await controller.load();

    expect((document.getElementById("launch-session-button") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("reports a rejected launch without retrying", async () => {
    const client = api({
      browserSession: vi.fn(async () => STOPPED_SESSION),
      launchBrowserSession: vi.fn(async () => {
        throw new ApiError("conflict", {
          problem: {
            code: "browser_session_already_running",
            detail: "자동화 브라우저가 이미 실행 중입니다.",
            status: 409,
            title: "Conflict",
          },
          status: 409,
        });
      }),
    });
    const controller = new TodayController(mountRoot(), { api: client as never });
    await controller.load();

    (document.getElementById("launch-session-button") as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(client.launchBrowserSession).toHaveBeenCalledTimes(1);
    expect(text("#workspace-status")).toContain("이미 실행 중");
  });

  it("shows an explanatory session detail", async () => {
    const controller = new TodayController(mountRoot(), {
      api: api({
        browserSession: vi.fn(async () => ({
          ...READY_SESSION,
          detail: "로그인 상태를 확인하지 못했습니다.",
        })),
      }) as never,
    });

    await controller.load();

    expect(text(".session-detail")).toContain("확인하지 못했습니다");
  });
});

describe("selection and opening", () => {
  it("switches the detail panel when another post is selected", async () => {
    const controller = new TodayController(mountRoot(), { api: api() as never });
    await controller.load();

    await controller.setSegment("search");
    const second = document.querySelector(".queue-item") as HTMLButtonElement;
    second.click();

    expect(text("#detail-title")).toBe("합성 제목 2");
  });

  it("extracts the selected post and reports the capture", async () => {
    const extracted: ArticleExtraction[] = [];
    const client = api();
    const controller = new TodayController(mountRoot(), {
      api: client as never,
      onExtracted: (extraction) => extracted.push(extraction),
    });
    await controller.load();
    await controller.setSegment("search");

    const result = await controller.openPost("2");

    expect(client.extractArticle).toHaveBeenCalledWith("https://blog.naver.com/example/2");
    expect(result?.title).toBe("합성 제목");
    expect(extracted).toHaveLength(1);
  });

  it("hands a selected discovery post to the combined generation path without a second extraction", async () => {
    const client = api();
    const opened = vi.fn();
    const controller = new TodayController(mountRoot(), {
      api: client as never,
      onDiscoveryPostOpened: opened,
    });
    await controller.load();
    await controller.setSegment("search");

    await controller.openPost("2");

    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: "2", source: "search" }));
    expect(client.extractArticle).not.toHaveBeenCalled();
  });

  it("blocks opening while the browser is stopped", async () => {
    const controller = new TodayController(mountRoot(), {
      api: api({ browserSession: vi.fn(async () => STOPPED_SESSION) }) as never,
    });

    await controller.load();

    const open = document.getElementById("open-post-button") as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(text(".detail-hint")).toContain("로그인");
  });

  it("reports an extraction failure with its problem detail", async () => {
    const controller = new TodayController(mountRoot(), {
      api: api({
        extractArticle: vi.fn(async () => {
          throw new ApiError("unusable", {
            problem: {
              code: "short_article",
              detail: "본문이 너무 짧아 댓글을 생성할 수 없습니다.",
              status: 422,
              title: "Article extraction failed",
            },
            status: 422,
          });
        }),
      }) as never,
    });
    await controller.load();

    const result = await controller.openPost("1");

    expect(result).toBeNull();
    expect(text("#workspace-status")).toContain("너무 짧아");
  });

  it("ignores opening an unknown post", async () => {
    const client = api();
    const controller = new TodayController(mountRoot(), { api: client as never });
    await controller.load();

    const result = await controller.openPost("missing");

    expect(result?.title).toBe("합성 제목");
    expect(client.extractArticle).toHaveBeenCalledTimes(1);
  });
});

describe("workbench queue controls", () => {
  it("passes cursor, filters, and a search query to the paged queue API", async () => {
    const page = vi.fn(async (options: { cursor?: string } = {}): Promise<DiscoveryQueuePage> => {
      if (options.cursor === "next") {
        return {
          items: [post("3")],
          counts: { neighbor: 2, search: 1, skipped: 0, total: 3 },
          nextCursor: null,
        };
      }
      return {
        items: [post("1")],
        counts: { neighbor: 2, search: 1, skipped: 0, total: 3 },
        nextCursor: "next",
      };
    });
    const controller = new TodayController(mountRoot(), {
      api: api({
        appReadiness: vi.fn(async () => ({
          accessMode: "local",
          automationConsent: true,
          blockers: [],
          browserLogin: "authenticated",
          browserState: "ready",
          generationAvailable: true,
          lanAddresses: [],
          ownBlogConfigured: true,
          safetyPolicyConfigured: true,
          webAppAssetsReady: true,
        })),
        discoveryQueuePage: page,
      }) as never,
    });
    await controller.load();

    await controller.setFilter("state", "queued");
    await controller.setQuery("합성");
    await controller.loadMore();

    expect(page).toHaveBeenLastCalledWith({
      source: "neighbor",
      query: "합성",
      state: "queued",
      cursor: "next",
    });
    expect(controller.state.posts.map((item) => item.id)).toEqual(["1", "3"]);
  });

  it("uses the visible controls for segments, sorting, selection, batch, and skip recovery", async () => {
    const change = vi.fn(async (_id: string, state: DiscoveryPost["state"]) => ({
      ...post("1"),
      state,
    }));
    const onBatchRequested = vi.fn();
    const controller = new TodayController(mountRoot(), {
      api: api({ updateDiscoveryPostState: change }) as never,
      onBatchRequested,
    });
    await controller.load();

    (document.querySelector("[data-segment='search']") as HTMLButtonElement).click();
    await Promise.resolve();
    (document.querySelector("[data-segment='neighbor']") as HTMLButtonElement).click();
    await Promise.resolve();
    (document.querySelector("#queue-sort") as HTMLSelectElement).value = "oldest";
    document.querySelector("#queue-sort")?.dispatchEvent(new Event("change"));
    (document.querySelector("#queue-batch-1") as HTMLInputElement).click();
    (document.querySelector("#batch-step-mutual_neighbor") as HTMLButtonElement).click();
    expect(text(".queue-batch-safety")).toContain(
      "공감: 오늘 4/10회 사용 · 6회 남음 · 이번 승인 1회",
    );
    expect(text(".queue-batch-safety")).toContain("계산상 최소 소요 시간은 0초");
    (document.querySelector("#open-batch-preview") as HTMLButtonElement).click();
    await controller.changePostState("1", "skipped");
    await controller.changePostState("1", "queued");

    expect(controller.state.sort).toBe("oldest");
    expect(onBatchRequested).toHaveBeenCalledWith({
      approvedSteps: ["like", "comment", "mutual_neighbor"],
      postIds: ["1"],
    });
    expect(change).toHaveBeenLastCalledWith("1", "queued");
  });

  it("does not continue a batch when the current safety cap cannot cover the selected scope", async () => {
    const controller = new TodayController(mountRoot(), {
      api: api({
        safetyStatus: vi.fn(async () => ({
          ...SAFETY,
          actions: [
            ...SAFETY.actions.filter((action) => action.name !== "comment"),
            { name: "comment" as const, cap: 8, used: 8, remaining: 0 },
          ],
        })),
      }) as never,
    });
    await controller.load();

    (document.querySelector("#queue-batch-1") as HTMLInputElement).click();

    expect(text(".queue-batch-safety")).toContain(
      "댓글 등록: 오늘 8/8회 사용 · 0회 남음 · 이번 승인 1회",
    );
    expect((document.querySelector("#open-batch-preview") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("handles direct URLs, queue changes, and remote-pairing requirements without losing the view", async () => {
    const direct = vi.fn();
    const pairing = vi.fn();
    const client = api();
    const controller = new TodayController(mountRoot(), {
      api: client as never,
      onDirectUrlOpened: direct,
      onRemotePairingRequired: pairing,
    });
    await controller.load();

    expect(await controller.openDirectUrl(" ")).toBeNull();
    expect(await controller.openDirectUrl(" https://blog.naver.com/direct ")).toBeNull();
    expect(direct).toHaveBeenCalledWith("https://blog.naver.com/direct");

    const paired = new TodayController(mountRoot(), {
      api: api({
        status: vi.fn(async () => {
          throw new ApiError("pair", {
            problem: {
              code: "remote_pairing_required",
              detail: "pair",
              status: 401,
              title: "Pairing required",
            },
            status: 401,
          });
        }),
      }) as never,
      onRemotePairingRequired: pairing,
    });
    await paired.load();

    expect(pairing).toHaveBeenCalledTimes(1);
    expect(client.extractArticle).not.toHaveBeenCalled();
  });
});

describe("accessibility", () => {
  it("keeps a live status region and labelled controls", async () => {
    const controller = new TodayController(mountRoot(), { api: api() as never });

    await controller.load();

    expect(document.querySelector("#workspace-status")?.getAttribute("role")).toBe("status");
    for (const button of Array.from(document.querySelectorAll("button"))) {
      expect((button.textContent ?? "").length).toBeGreaterThan(0);
      expect(button.getAttribute("type")).toBe("button");
    }
    const link = document.querySelector(".detail-link") as HTMLAnchorElement;
    expect(link.rel).toContain("noreferrer");
  });
});
