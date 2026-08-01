import { describe, expect, it, vi } from "vitest";

import {
  ApiError,
  LocalApiClient,
  readAppReadiness,
  readAppSetting,
  readArticleExtraction,
  readAutoDiscoverySettings,
  readAutomationSession,
  readBlogCategory,
  readBrowserSession,
  readCommentGeneration,
  readDigestSettings,
  readDiscoveryNeighbor,
  readDiscoveryQueue,
  readDiscoverySearchRefresh,
  readDiscoverySyncResult,
  readEngagementRun,
  readLlmProvider,
  readPostDraft,
  readPublishRun,
  readRecommendation,
  readSavedSearch,
  readScheduleStatus,
  readServiceStatus,
} from "../../src/app/api/client";

const STATUS = {
  status: "ready",
  api_version: "1.0.0",
  app_environment: "test",
  database: "ready",
  generator_mode: "fake",
  generator_model: "deterministic-fake",
};

const READINESS = {
  access_mode: "lan",
  web_app_assets_ready: true,
  lan_addresses: ["192.168.1.20"],
  browser_state: "ready",
  browser_login: "authenticated",
  own_blog_configured: true,
  generation_available: true,
  automation_consent: true,
  safety_policy_configured: true,
  blockers: [],
};

const SESSION = {
  state: "ready",
  login: "authenticated",
  driver: "patchright",
  headless: false,
  profile_dir: "/profiles/automation",
  open_pages: 1,
  detail: null,
};

const POST = {
  id: "11111111-1111-4111-8111-111111111111",
  source: "neighbor",
  state: "queued",
  source_url: "https://blog.naver.com/example/223456789012",
  title: "합성 제목",
  publisher_name: "합성 이웃",
  publisher_blog_id: "example",
  published_at: null,
  neighbor_id: null,
  search_id: null,
  created_at: "2026-07-30T00:00:00Z",
  updated_at: "2026-07-30T00:00:00Z",
};

const EXTRACTION = {
  source_url: "https://blog.naver.com/example/223456789012",
  title: "합성 제목",
  selector_kind: "modern",
  original_length: 120,
  transmitted_length: 120,
  truncated: false,
  preview: "합성 본문",
};

const NEIGHBOR = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "합성 이웃",
  blog_url: "https://blog.naver.com/neighbor",
  blog_id: "neighbor",
  enabled: true,
  feed_status: "ready",
  last_checked_at: "2026-08-01T00:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
};

const DIGEST_SETTINGS = {
  timezone: "Asia/Seoul",
  hour: 8,
  minute: 30,
  email_enabled: true,
  smtp_configured: false,
};

const SEARCH_REFRESH = {
  imported_count: 4,
  provider: "naver_open_api",
  detail: "공식 네이버 검색 API에서 검색 후보 4개를 확인했습니다.",
};

const AUTOMATIC_DISCOVERY = {
  own_blog_id: "example",
  enabled: true,
  timezone: "Asia/Seoul",
  hour: 9,
  minute: 30,
  last_synced_at: null,
  last_status: "success",
  last_detail: "",
};

const SAVED_SEARCH = {
  id: "22222222-2222-4222-8222-222222222222",
  query: "전시 후기",
  excluded_terms: [],
  freshness_days: 14,
  enabled: true,
  created_at: "2026-08-01T00:00:00Z",
};

const DISCOVERY_SYNC = {
  neighbors_added: 1,
  neighbor_posts_added: 2,
  search_posts_added: 3,
  search_provider: "naver_open_api",
  status: "success",
  detail: "완료",
};

const SCHEDULE = {
  mode: "schedule",
  hour: 9,
  minute: 30,
  max_posts: 3,
  enabled: true,
  blocking_reason: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}

function clientWith(handler: typeof fetch): LocalApiClient {
  return new LocalApiClient({ fetch: handler });
}

describe("response shape guards", () => {
  const decoders: [string, (value: unknown) => unknown][] = [
    ["service status", readServiceStatus],
    ["app readiness", readAppReadiness],
    ["discovery queue", readDiscoveryQueue],
    ["browser session", readBrowserSession],
    ["article extraction", readArticleExtraction],
    ["recommendation", readRecommendation],
    ["comment generation", readCommentGeneration],
    ["app setting", readAppSetting],
    ["engagement run", readEngagementRun],
    ["automation session", readAutomationSession],
    ["automatic discovery settings", readAutoDiscoverySettings],
    ["discovery synchronization", readDiscoverySyncResult],
    ["saved search", readSavedSearch],
    ["neighbor", readDiscoveryNeighbor],
    ["search refresh", readDiscoverySearchRefresh],
    ["digest settings", readDigestSettings],
    ["schedule", readScheduleStatus],
    ["provider", readLlmProvider],
    ["blog category", readBlogCategory],
    ["post draft", readPostDraft],
    ["publish run", readPublishRun],
  ];

  it.each(decoders)("rejects a non-object %s response", (_name, read) => {
    expect(() => read(null)).toThrow(/계약/u);
  });
});

describe("status", () => {
  it("maps the service status into camel case", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(STATUS)) as unknown as typeof fetch);

    const status = await client.status();

    expect(status.apiVersion).toBe("1.0.0");
    expect(status.generatorMode).toBe("fake");
    expect(status.appEnvironment).toBe("test");
  });

  it("rejects an unexpected environment", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse({ ...STATUS, app_environment: "staging" })) as never,
    );

    await expect(client.status()).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a non-ready database", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse({ ...STATUS, database: "migrating" })) as never,
    );

    await expect(client.status()).rejects.toThrow(/계약/u);
  });

  it("rejects a missing generator model", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse({ ...STATUS, generator_model: "" })) as never,
    );

    await expect(client.status()).rejects.toThrow(/generator_model/u);
  });
});

describe("appReadiness", () => {
  it("maps the redacted setup status", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(READINESS)) as never);

    const readiness = await client.appReadiness();

    expect(readiness.accessMode).toBe("lan");
    expect(readiness.lanAddresses).toEqual(["192.168.1.20"]);
    expect(readiness.browserLogin).toBe("authenticated");
  });

  it("rejects an unknown setup blocker", () => {
    expect(() => readAppReadiness({ ...READINESS, blockers: ["remote_desktop"] })).toThrow(
      /blockers/u,
    );
  });
});

describe("discoveryQueue", () => {
  it("requests both sources and merges the results", async () => {
    const handler = vi.fn(async (url: string) =>
      jsonResponse({
        items: url.includes("search") ? [{ ...POST, id: "2", source: "search" }] : [POST],
      }),
    );
    const client = clientWith(handler as never);

    const posts = await client.discoveryQueue();

    expect(handler.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "/api/v1/app/discovery/queue?source=neighbor",
      "/api/v1/app/discovery/queue?source=search",
    ]);
    expect(posts.map((post) => post.source)).toEqual(["neighbor", "search"]);
  });

  it("maps queue items", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse({ items: [POST] })) as never);

    const posts = await client.discoveryQueueFor("neighbor");

    expect(posts).toHaveLength(1);
    expect(posts[0]?.sourceUrl).toContain("blog.naver.com");
    expect(posts[0]?.publisherName).toBe("합성 이웃");
  });

  it("accepts an empty queue", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse({ items: [] })) as never);

    await expect(client.discoveryQueue()).resolves.toEqual([]);
  });

  it("rejects a missing items array", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse({})) as never);

    await expect(client.discoveryQueue()).rejects.toThrow(/items/u);
  });

  it("rejects an unknown source", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse({ items: [{ ...POST, source: "rss" }] })) as never,
    );

    await expect(client.discoveryQueue()).rejects.toThrow(/source/u);
  });

  it("rejects an unknown state", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse({ items: [{ ...POST, state: "archived" }] })) as never,
    );

    await expect(client.discoveryQueue()).rejects.toThrow(/state/u);
  });

  it("accepts null publisher metadata", async () => {
    const client = clientWith(
      vi.fn(async () =>
        jsonResponse({ items: [{ ...POST, publisher_name: null, publisher_blog_id: null }] }),
      ) as never,
    );

    const posts = await client.discoveryQueue();

    expect(posts[0]?.publisherName).toBeNull();
  });
});

describe("discovery settings transport", () => {
  it("maps neighbours and their RSS status", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse({ items: [NEIGHBOR] })) as never);

    const neighbors = await client.discoveryNeighbors();

    expect(neighbors).toEqual([
      {
        id: NEIGHBOR.id,
        name: "합성 이웃",
        blogUrl: NEIGHBOR.blog_url,
        blogId: NEIGHBOR.blog_id,
        enabled: true,
        feedStatus: "ready",
        lastCheckedAt: NEIGHBOR.last_checked_at,
        createdAt: NEIGHBOR.created_at,
      },
    ]);
  });

  it("rejects an unknown neighbour RSS status", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse({ items: [{ ...NEIGHBOR, feed_status: "stale" }] })) as never,
    );

    await expect(client.discoveryNeighbors()).rejects.toThrow(/feed_status/u);
  });

  it("sends an upsert-shaped neighbour request", async () => {
    const handler = vi.fn(async () => jsonResponse(NEIGHBOR, 201));
    const client = clientWith(handler as never);

    await client.saveDiscoveryNeighbor({
      name: NEIGHBOR.name,
      blogUrl: NEIGHBOR.blog_url,
      blogId: NEIGHBOR.blog_id,
      enabled: false,
    });

    expect(handler).toHaveBeenCalledWith(
      "/api/v1/discovery/neighbors",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: NEIGHBOR.name,
          blog_url: NEIGHBOR.blog_url,
          blog_id: NEIGHBOR.blog_id,
          enabled: false,
        }),
      }),
    );
  });

  it("refreshes one search and keeps its detailed result", async () => {
    const handler = vi.fn(async () => jsonResponse(SEARCH_REFRESH));
    const client = clientWith(handler as never);

    const result = await client.refreshSavedSearch("search-id");

    expect(result.importedCount).toBe(4);
    expect(result.detail).toContain("검색 후보");
    expect(handler).toHaveBeenCalledWith(
      "/api/v1/discovery/searches/search-id/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("maps and saves digest settings without requiring SMTP", async () => {
    const handler = vi.fn(async () => jsonResponse(DIGEST_SETTINGS));
    const client = clientWith(handler as never);

    const current = await client.digestSettings();
    await client.saveDigestSettings({
      timezone: current.timezone,
      hour: current.hour,
      minute: current.minute,
      emailEnabled: current.emailEnabled,
    });

    expect(current.smtpConfigured).toBe(false);
    expect(handler.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "/api/v1/discovery/digest-settings",
      "/api/v1/discovery/digest-settings",
    ]);
    expect((handler.mock.calls[1] as unknown[] | undefined)?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({
        timezone: "Asia/Seoul",
        hour: 8,
        minute: 30,
        email_enabled: true,
      }),
    });
  });

  it("rejects a digest schedule outside a day", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse({ ...DIGEST_SETTINGS, hour: 24 })) as never,
    );

    await expect(client.digestSettings()).rejects.toThrow(/digest time/u);
  });

  it("uses nullable defaults for incomplete optional timestamps", () => {
    expect(
      readDiscoveryNeighbor({ ...NEIGHBOR, last_checked_at: undefined }).lastCheckedAt,
    ).toBeNull();
    expect(
      readAutoDiscoverySettings({ ...AUTOMATIC_DISCOVERY, last_synced_at: undefined }).lastSyncedAt,
    ).toBeNull();
  });

  it.each([
    ["saved search terms", () => readSavedSearch({ ...SAVED_SEARCH, excluded_terms: "no" })],
    ["saved search freshness", () => readSavedSearch({ ...SAVED_SEARCH, freshness_days: 91 })],
    [
      "automatic discovery status",
      () => readAutoDiscoverySettings({ ...AUTOMATIC_DISCOVERY, last_status: "later" }),
    ],
    [
      "automatic discovery time",
      () => readAutoDiscoverySettings({ ...AUTOMATIC_DISCOVERY, hour: 24 }),
    ],
    [
      "synchronization provider",
      () => readDiscoverySyncResult({ ...DISCOVERY_SYNC, search_provider: "html" }),
    ],
    [
      "synchronization status",
      () => readDiscoverySyncResult({ ...DISCOVERY_SYNC, status: "pending" }),
    ],
    [
      "search refresh provider",
      () => readDiscoverySearchRefresh({ ...SEARCH_REFRESH, provider: "cache" }),
    ],
    ["digest minute", () => readDigestSettings({ ...DIGEST_SETTINGS, minute: 60 })],
    ["schedule mode", () => readScheduleStatus({ ...SCHEDULE, mode: "later" })],
    ["schedule time", () => readScheduleStatus({ ...SCHEDULE, minute: 60 })],
  ])("rejects invalid %s fields", (_field, read) => {
    expect(read).toThrow(/계약/u);
  });
});

describe("browser session", () => {
  it("maps the session snapshot", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(SESSION)) as never);

    const session = await client.browserSession();

    expect(session.state).toBe("ready");
    expect(session.openPages).toBe(1);
    expect(session.profileDir).toContain("/profiles");
  });

  it("adds the refresh query only when requested", async () => {
    const handler = vi.fn(async () => jsonResponse(SESSION));
    const client = clientWith(handler as never);

    await client.browserSession();
    await client.browserSession({ refresh: true });

    expect((handler.mock.calls[0] as unknown[] | undefined)?.[0]).toBe(
      "/api/v1/automation/session",
    );
    expect((handler.mock.calls[1] as unknown[] | undefined)?.[0]).toBe(
      "/api/v1/automation/session?refresh=true",
    );
  });

  it("posts to the lifecycle endpoints", async () => {
    const handler = vi.fn(async () => jsonResponse(SESSION));
    const client = clientWith(handler as never);

    await client.launchBrowserSession();
    await client.closeBrowserSession();
    await client.focusBrowserSession();

    expect(handler.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "/api/v1/automation/session/launch",
      "/api/v1/automation/session/close",
      "/api/v1/automation/session/focus",
    ]);
    expect((handler.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({ method: "POST" });
  });

  it("rejects an unknown session state", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse({ ...SESSION, state: "crashed" })) as never,
    );

    await expect(client.browserSession()).rejects.toThrow(/state/u);
  });

  it("rejects an unknown login state", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse({ ...SESSION, login: "maybe" })) as never,
    );

    await expect(client.browserSession()).rejects.toThrow(/login/u);
  });

  it("rejects a negative page count", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse({ ...SESSION, open_pages: -1 })) as never,
    );

    await expect(client.browserSession()).rejects.toThrow(/open_pages/u);
  });

  it("keeps an explanatory detail", async () => {
    const client = clientWith(
      vi.fn(async () =>
        jsonResponse({ ...SESSION, detail: "로그인 상태를 확인하지 못했습니다." }),
      ) as never,
    );

    const session = await client.browserSession();

    expect(session.detail).toContain("로그인");
  });
});

describe("extractArticle", () => {
  it("sends the url and maps the capture", async () => {
    const handler = vi.fn(async () => jsonResponse(EXTRACTION));
    const client = clientWith(handler as never);

    const extraction = await client.extractArticle(EXTRACTION.source_url);

    expect(extraction.transmittedLength).toBe(120);
    expect((handler.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ url: EXTRACTION.source_url }),
    });
  });

  it("rejects an unknown selector kind", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse({ ...EXTRACTION, selector_kind: "guess" })) as never,
    );

    await expect(client.extractArticle("https://blog.naver.com/example/1")).rejects.toThrow(
      /selector_kind/u,
    );
  });

  it("accepts an empty preview", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse({ ...EXTRACTION, preview: "" })) as never,
    );

    await expect(client.extractArticle("https://blog.naver.com/example/1")).resolves.toMatchObject({
      preview: "",
    });
  });
});

describe("error handling", () => {
  it("sends the paired-device CSRF cookie on a state-changing request", async () => {
    document.cookie = "nba_csrf=synthetic-csrf; path=/";
    const handler = vi.fn(async () =>
      jsonResponse({ code: "123456", expires_at: "2026-08-01T00:05:00Z" }),
    );
    const client = clientWith(handler as never);

    await client.createRemotePairingCode();

    const init = (handler.mock.calls[0] as unknown[] | undefined)?.[1] as RequestInit;
    expect(new Headers(init.headers).get("X-NBA-CSRF")).toBe("synthetic-csrf");
    document.cookie = "nba_csrf=; Max-Age=0; path=/";
  });

  it("exposes the problem code and detail", async () => {
    const client = clientWith(
      vi.fn(async () =>
        jsonResponse(
          {
            type: "about:blank",
            title: "Browser session not running",
            status: 409,
            detail: "자동화 브라우저가 실행되지 않았습니다.",
            code: "browser_session_not_running",
            request_id: "11111111-1111-4111-8111-111111111111",
          },
          409,
        ),
      ) as never,
    );

    const error = await client.browserSession().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("browser_session_not_running");
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).problem?.detail).toContain("실행되지");
  });

  it("tolerates a non-problem error body", async () => {
    const client = clientWith(vi.fn(async () => new Response("nope", { status: 500 })) as never);

    const error = await client.status().catch((caught: unknown) => caught);

    expect((error as ApiError).problem).toBeNull();
    expect((error as ApiError).status).toBe(500);
  });

  it("rejects a problem body with an invalid code", async () => {
    const client = clientWith(
      vi.fn(async () =>
        jsonResponse({ code: "Not A Code", detail: "d", status: 500, title: "t" }, 500),
      ) as never,
    );

    const error = await client.status().catch((caught: unknown) => caught);

    expect((error as ApiError).problem).toBeNull();
  });

  it("reports an unreachable service", async () => {
    const client = clientWith(
      vi.fn(async () => {
        throw new TypeError("network down");
      }) as never,
    );

    const error = await client.status().catch((caught: unknown) => caught);

    expect((error as ApiError).message).toContain("연결할 수 없습니다");
    expect((error as ApiError).status).toBeNull();
  });

  it("reports an unparsable success body", async () => {
    const client = clientWith(vi.fn(async () => new Response("{", { status: 200 })) as never);

    await expect(client.status()).rejects.toThrow(/해석할 수 없습니다/u);
  });

  it("honors a configured base path", async () => {
    const handler = vi.fn(async () => jsonResponse(STATUS));
    const client = new LocalApiClient({ base: "http://127.0.0.1:8765", fetch: handler as never });

    await client.status();

    expect((handler.mock.calls[0] as unknown[] | undefined)?.[0]).toBe(
      "http://127.0.0.1:8765/api/v1/status",
    );
  });
});
