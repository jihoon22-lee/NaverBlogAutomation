import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../src/app/api/client";
import type {
  ArticleExtraction,
  BrowserSession,
  DiscoveryPost,
  ServiceStatus,
} from "../../src/app/api/types";
import { TodayController } from "../../src/app/controllers/today";

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

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("initial render", () => {
  it("shows a connecting status before loading", () => {
    const controller = new TodayController(mountRoot(), { api: api() as never });

    controller.render();

    expect(text("#workspace-status")).toContain("연결하는 중");
  });
});

describe("load", () => {
  it("renders the queue counts, list, and detail together", async () => {
    const controller = new TodayController(mountRoot(), { api: api() as never });

    await controller.load();

    expect(text("#workspace-status")).toContain("대기 중인 글 2건");
    expect(document.querySelectorAll(".queue-item")).toHaveLength(2);
    expect(text("#detail-title")).toBe("합성 제목 1");
    expect(controller.state.phase).toBe("ready");
  });

  it("marks the selected queue item with aria-pressed", async () => {
    const controller = new TodayController(mountRoot(), { api: api() as never });

    await controller.load();

    const [first, second] = Array.from(document.querySelectorAll(".queue-item"));
    expect(first?.getAttribute("aria-pressed")).toBe("true");
    expect(second?.getAttribute("aria-pressed")).toBe("false");
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

    const [, second] = Array.from(document.querySelectorAll(".queue-item"));
    (second as HTMLButtonElement).click();

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

    const result = await controller.openPost("2");

    expect(client.extractArticle).toHaveBeenCalledWith("https://blog.naver.com/example/2");
    expect(result?.title).toBe("합성 제목");
    expect(extracted).toHaveLength(1);
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
