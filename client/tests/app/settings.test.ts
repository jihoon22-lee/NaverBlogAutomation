/** Settings screen: discovery form, synchronization reporting, and search terms. */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AppSettingRecord,
  AutoDiscoverySettings,
  DigestSettings,
  DiscoveryNeighbor,
  DiscoverySearchRefresh,
  DiscoverySyncResult,
  RuntimeConfiguration,
  RuntimeData,
  SavedSearch,
} from "../../src/app/api/types";
import { ApiError } from "../../src/app/api/client";
import { initialSettingsState, SettingsController } from "../../src/app/controllers/settings";
import { renderSettings } from "../../src/app/views/settings";

const SETTINGS: AutoDiscoverySettings = {
  ownBlogId: "example",
  enabled: true,
  timezone: "Asia/Seoul",
  hour: 9,
  minute: 30,
  lastSyncedAt: "2026-08-01T00:00:00Z",
  lastStatus: "success",
  lastDetail: "",
};

const SYNC: DiscoverySyncResult = {
  neighborsAdded: 2,
  neighborPostsAdded: 12,
  searchPostsAdded: 3,
  searchProvider: "naver_open_api",
  status: "success",
  detail: "",
};

const SEARCH: SavedSearch = {
  id: "22222222-2222-4222-8222-222222222222",
  query: "전시 후기",
  excludedTerms: [],
  freshnessDays: 14,
  enabled: true,
  createdAt: "2026-08-01T00:00:00Z",
};

const NEIGHBOR: DiscoveryNeighbor = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "합성 이웃",
  blogUrl: "https://blog.naver.com/neighbor",
  blogId: "neighbor",
  enabled: true,
  feedStatus: "ready",
  lastCheckedAt: "2026-08-01T00:00:00Z",
  createdAt: "2026-08-01T00:00:00Z",
};

const DIGEST: DigestSettings = {
  timezone: "Asia/Seoul",
  hour: 8,
  minute: 30,
  emailEnabled: false,
  smtpConfigured: false,
};

const SEARCH_REFRESH: DiscoverySearchRefresh = {
  importedCount: 4,
  provider: "naver_open_api",
  detail: "공식 네이버 검색 API에서 검색 후보 4개를 확인했습니다.",
};

const RUNTIME: RuntimeConfiguration = {
  ai: {
    activeProvider: "openai",
    providers: [
      { provider: "openai", configured: true, model: "gpt-test" },
      { provider: "gemini", configured: false, model: "gemini-test" },
      { provider: "anthropic", configured: false, model: "claude-test" },
    ],
  },
  naverSearch: { configured: true },
  smtp: {
    configured: true,
    host: "smtp.example.test",
    port: 465,
    security: "ssl",
    digestEmailFrom: "sender@example.test",
    digestEmailTo: "recipient@example.test",
  },
  browser: { driver: "patchright", headless: false, channel: "" },
  network: { accessMode: "local" },
  restartRequired: false,
  launcherRestartAvailable: true,
};

const RUNTIME_DATA: RuntimeData = {
  databaseLocation: "/private/app/database.sqlite3",
  databaseFileCount: 2,
  mediaLocation: "/private/app/media",
  mediaFileCount: 4,
  fileCount: 6,
  sizeBytes: 4096,
  resetAvailable: true,
};

interface Api {
  appSetting: ReturnType<typeof vi.fn>;
  autoDiscoverySettings: ReturnType<typeof vi.fn>;
  saveAutoDiscoverySettings: ReturnType<typeof vi.fn>;
  saveAppSetting: ReturnType<typeof vi.fn>;
  syncDiscovery: ReturnType<typeof vi.fn>;
  savedSearches: ReturnType<typeof vi.fn>;
  saveSearch: ReturnType<typeof vi.fn>;
  deleteSearch: ReturnType<typeof vi.fn>;
  discoveryNeighbors: ReturnType<typeof vi.fn>;
  saveDiscoveryNeighbor: ReturnType<typeof vi.fn>;
  refreshSavedSearch: ReturnType<typeof vi.fn>;
  digestSettings: ReturnType<typeof vi.fn>;
  saveDigestSettings: ReturnType<typeof vi.fn>;
  runtimeConfiguration?: ReturnType<typeof vi.fn>;
  patchRuntimeConfiguration?: ReturnType<typeof vi.fn>;
  restartRuntime?: ReturnType<typeof vi.fn>;
  runtimeData?: ReturnType<typeof vi.fn>;
  exportRuntimeData?: ReturnType<typeof vi.fn>;
  resetRuntimeData?: ReturnType<typeof vi.fn>;
  status?: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<Api> = {}): {
  root: Element;
  controller: SettingsController;
  api: Api;
} {
  document.body.innerHTML = '<main id="workspace"></main>';
  const root = document.getElementById("workspace");
  if (root === null) throw new Error("missing root");
  const api: Api = {
    appSetting: vi.fn(async (kind: string): Promise<AppSettingRecord> => {
      const payloads: Record<string, Record<string, unknown>> = {
        automation_consent: { accepted: false, consent_version: 1 },
        closing_phrase: { phrase: "" },
        generation_profile: {
          relationship_level: "friendly",
          speech_style: "honorific",
          comment_length: "medium",
          comment_mood: "warm",
          personalization_mode: "off",
        },
        neighbor_message: { message: "" },
        safety_policy: {
          daily_like_cap: 20,
          daily_comment_cap: 20,
          daily_neighbor_cap: 5,
          min_interval_seconds: 90,
          jitter_ratio: 0.4,
          allowed_hours: [9, 11],
          max_consecutive_failures: 3,
        },
        writing_profile: {
          target_length: "medium",
          tone: "warm",
          structure: "sectioned",
          reference_post_count: 3,
          body_tag_cap: 10,
          use_image_vision: false,
        },
      };
      return { kind, schemaVersion: 1, payload: payloads[kind] ?? {}, updatedAt: null };
    }),
    autoDiscoverySettings: vi.fn(async () => SETTINGS),
    saveAutoDiscoverySettings: vi.fn(async () => SETTINGS),
    saveAppSetting: vi.fn(async () => ({
      kind: "test",
      schemaVersion: 1,
      payload: {},
      updatedAt: null,
    })),
    syncDiscovery: vi.fn(async () => SYNC),
    savedSearches: vi.fn(async () => [] as SavedSearch[]),
    saveSearch: vi.fn(async () => SEARCH),
    deleteSearch: vi.fn(async () => undefined),
    discoveryNeighbors: vi.fn(async () => [] as DiscoveryNeighbor[]),
    saveDiscoveryNeighbor: vi.fn(async () => NEIGHBOR),
    refreshSavedSearch: vi.fn(async () => SEARCH_REFRESH),
    digestSettings: vi.fn(async () => DIGEST),
    saveDigestSettings: vi.fn(async () => DIGEST),
    ...overrides,
  };
  const controller = new SettingsController(root, {
    api: api as never,
    onChange: () => controller.render(),
  });
  return { root, controller, api };
}

function text(root: Element): string {
  return root.textContent ?? "";
}

function click(root: Element, selector: string): void {
  const button = root.querySelector<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`missing button: ${selector}`);
  button.click();
}

function type(root: Element, selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`missing input: ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("discovery settings", () => {
  it("fills the form from the saved settings", async () => {
    const { root, controller } = harness();

    await controller.load();
    controller.render();

    expect(root.querySelector<HTMLInputElement>("#own-blog-id")?.value).toBe("example");
    expect(root.querySelector<HTMLInputElement>("#discovery-hour")?.value).toBe("9");
    expect(root.querySelector<HTMLInputElement>("#discovery-enabled")?.checked).toBe(true);
    expect(root.querySelector<HTMLInputElement>("#digest-hour")?.value).toBe("8");
  });

  it("saves what the user typed", async () => {
    const { root, controller, api } = harness();
    await controller.load();
    controller.render();

    type(root, "#own-blog-id", "mine");
    click(root, "#save-discovery-button");

    expect(api.saveAutoDiscoverySettings).toHaveBeenCalledWith({
      ownBlogId: "mine",
      enabled: true,
      hour: 9,
      minute: 30,
      timezone: "Asia/Seoul",
    });
  });

  it("refuses an empty blog id before asking the service", async () => {
    const { root, controller, api } = harness({
      autoDiscoverySettings: vi.fn(async () => ({ ...SETTINGS, ownBlogId: "" })),
    });
    await controller.load();
    controller.render();

    await controller.save();

    expect(api.saveAutoDiscoverySettings).not.toHaveBeenCalled();
    expect(text(root)).toContain("내 블로그 ID를 입력하세요");
  });

  it("confirms a successful save", async () => {
    const { root, controller } = harness();
    await controller.load();

    await controller.save();
    controller.render();

    expect(text(root)).toContain("자동 탐색 설정을 저장했습니다");
  });

  it("uses the documented default timezone on a first save", async () => {
    const { root, controller, api } = harness();
    controller.render();

    type(root, "#own-blog-id", "first-blog");
    await controller.save();

    expect(api.saveAutoDiscoverySettings).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "Asia/Seoul" }),
    );
  });

  it("states that only public metadata is collected", async () => {
    const { root, controller } = harness();

    await controller.load();
    controller.render();

    expect(text(root)).toContain("공개된 metadata만 모읍니다");
  });
});

describe("desktop runtime configuration", () => {
  it("keeps configured secrets write-only while allowing a replacement", async () => {
    const patchRuntimeConfiguration = vi.fn(async () => ({ ...RUNTIME, restartRequired: true }));
    const { root, controller } = harness({
      patchRuntimeConfiguration,
      runtimeConfiguration: vi.fn(async () => RUNTIME),
    });
    await controller.load();
    controller.render();

    const openaiKey = root.querySelector<HTMLInputElement>("#runtime-openai-key");
    expect(openaiKey?.value).toBe("");
    expect(root.textContent).not.toContain("private-value");
    expect(root.querySelector<HTMLInputElement>("#runtime-digest-email-from")?.value).toBe(
      "sender@example.test",
    );
    type(root, "#runtime-openai-key", "private-value");
    click(root, "#save-runtime-configuration-button");
    await Promise.resolve();

    expect(patchRuntimeConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ openaiApiKey: { replace: "private-value" } }),
    );
    expect(root.textContent).not.toContain("private-value");
  });

  it("sends an explicit clear intent without making a saved secret visible", async () => {
    const patchRuntimeConfiguration = vi.fn(async () => ({ ...RUNTIME, restartRequired: true }));
    const { root, controller } = harness({
      patchRuntimeConfiguration,
      runtimeConfiguration: vi.fn(async () => RUNTIME),
    });
    await controller.load();
    controller.render();

    const clear = root.querySelector<HTMLInputElement>("#runtime-openai-key-clear");
    if (clear === null) throw new Error("missing clear secret control");
    clear.click();
    expect(root.querySelector<HTMLInputElement>("#runtime-openai-key")?.disabled).toBe(true);
    click(root, "#save-runtime-configuration-button");
    await Promise.resolve();

    expect(patchRuntimeConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ openaiApiKey: { clear: true } }),
    );
  });

  it("shows exact reset targets only to the desktop client", async () => {
    const { root, controller } = harness({
      runtimeConfiguration: vi.fn(async () => RUNTIME),
      runtimeData: vi.fn(async () => RUNTIME_DATA),
    });
    await controller.load();
    controller.render();

    expect(text(root)).toContain("SQLite DB/WAL/SHM 2개 · 초안 미디어 4개");
    expect(text(root)).not.toContain("DATABASE_URL");
    expect((root.querySelector("#reset-runtime-data-button") as HTMLButtonElement).disabled).toBe(
      true,
    );
    type(root, "#runtime-data-reset-confirmation", "RESET LOCAL DATA");
    controller.render();
    expect((root.querySelector("#reset-runtime-data-button") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("does not expose data controls when the client is paired", async () => {
    const { root, controller } = harness({
      runtimeConfiguration: vi.fn(async () => {
        throw new ApiError("desktop only", { status: 403 });
      }),
      runtimeData: vi.fn(async () => {
        throw new ApiError("desktop only", { status: 403 });
      }),
    });
    await controller.load();
    controller.render();

    expect(text(root)).toContain("연결된 PC에서만 데이터 위치와 내보내기를 확인할 수 있습니다.");
    expect(root.querySelector("#export-runtime-data-button")).toBeNull();
    expect(root.querySelector("#reset-runtime-data-button")).toBeNull();
  });

  it("saves digest addresses and an intentional empty SMTP host", async () => {
    const patchRuntimeConfiguration = vi.fn(async () => RUNTIME);
    const { root, controller } = harness({
      patchRuntimeConfiguration,
      runtimeConfiguration: vi.fn(async () => RUNTIME),
    });
    await controller.load();
    controller.render();

    type(root, "#runtime-smtp-host", "");
    type(root, "#runtime-digest-email-from", "new-sender@example.test");
    type(root, "#runtime-digest-email-to", "new-recipient@example.test");
    await controller.saveRuntimeConfiguration();

    expect(patchRuntimeConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        smtpHost: "",
        digestEmailFrom: "new-sender@example.test",
        digestEmailTo: "new-recipient@example.test",
      }),
    );
  });

  it("renders a runtime save failure without retaining the write-only value", async () => {
    const { root, controller } = harness({
      patchRuntimeConfiguration: vi.fn(async () => {
        throw new ApiError("not saved", { status: 422 });
      }),
      runtimeConfiguration: vi.fn(async () => RUNTIME),
    });
    await controller.load();
    controller.render();
    type(root, "#runtime-openai-key", "private-value");

    await controller.saveRuntimeConfiguration();
    controller.render();

    expect(text(root)).toContain("not saved");
    expect(text(root)).not.toContain("private-value");
  });

  it("downloads a desktop data export without adding paths to settings", async () => {
    const objectUrl = vi.fn(() => "blob:export");
    const revoke = vi.fn();
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("URL", { createObjectURL: objectUrl, revokeObjectURL: revoke });
    const exportRuntimeData = vi.fn(async () => new Blob(["archive"]));
    const { controller } = harness({
      exportRuntimeData,
      runtimeConfiguration: vi.fn(async () => RUNTIME),
      runtimeData: vi.fn(async () => RUNTIME_DATA),
    });
    await controller.load();

    await controller.exportRuntimeData();

    expect(exportRuntimeData).toHaveBeenCalledOnce();
    expect(objectUrl).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:export");
    download.mockRestore();
    vi.unstubAllGlobals();
  });

  it("reports a rejected restart without polling the service", async () => {
    const restartRuntime = vi.fn(async () => {
      throw new ApiError("restart busy", { status: 409 });
    });
    const { controller } = harness({
      restartRuntime,
      runtimeConfiguration: vi.fn(async () => ({ ...RUNTIME, restartRequired: true })),
    });
    await controller.load();

    await controller.restartRuntime();

    expect(restartRuntime).toHaveBeenCalledOnce();
    expect(controller.state.error).toContain("restart busy");
  });

  it("keeps the restart notice when the replacement never becomes ready", async () => {
    vi.useFakeTimers();
    const { controller } = harness({
      resetRuntimeData: vi.fn(async () => ({ backupLocation: "/backup", restartRequired: true })),
      runtimeConfiguration: vi.fn(async () => RUNTIME),
      runtimeData: vi.fn(async () => RUNTIME_DATA),
      status: vi.fn(async () => {
        throw new Error("restarting");
      }),
    });
    await controller.load();

    const reset = controller.resetRuntimeData();
    await vi.runAllTimersAsync();
    await reset;

    expect(controller.state.notice).toContain("잠시 후 화면을 새로고침하세요");
    vi.useRealTimers();
  });
});

describe("advanced automation settings", () => {
  it("persists schedule and AI budget in one explicit save", async () => {
    const { root, controller, api } = harness();
    await controller.load();
    controller.render();

    const mode = root.querySelector<HTMLSelectElement>("#schedule-mode");
    const hour = root.querySelector<HTMLInputElement>("#schedule-hour");
    const calls = root.querySelector<HTMLInputElement>("#llm-daily-call-cap");
    if (mode === null || hour === null || calls === null)
      throw new Error("missing advanced fields");
    mode.value = "schedule";
    mode.dispatchEvent(new Event("change"));
    hour.value = "21";
    hour.dispatchEvent(new Event("change"));
    calls.value = "80";
    calls.dispatchEvent(new Event("change"));

    await controller.saveScheduleAndBudget();

    expect(api.saveAppSetting).toHaveBeenCalledWith(
      "schedule_policy",
      expect.objectContaining({ mode: "schedule", hour: 21 }),
    );
    expect(api.saveAppSetting).toHaveBeenCalledWith(
      "llm_budget",
      expect.objectContaining({ daily_call_cap: 80 }),
    );
  });
});

describe("synchronizing now", () => {
  it("reports what it added rather than only that it ran", async () => {
    const { root, controller } = harness();
    await controller.load();

    await controller.sync();
    controller.render();

    expect(text(root)).toContain("새 이웃 2명");
    expect(text(root)).toContain("이웃 새 글 12건");
    expect(text(root)).toContain("검색 후보 3건");
  });

  it("explains a missing search key as a partial result", async () => {
    const { root, controller } = harness({
      syncDiscovery: vi.fn(async () => ({
        ...SYNC,
        searchProvider: "none" as const,
        searchPostsAdded: 0,
        status: "partial" as const,
      })),
    });
    await controller.load();

    await controller.sync();
    controller.render();

    expect(text(root)).toContain("검색 API key가 없어");
    expect(text(root)).toContain("이웃 새 글은 그대로 모았습니다");
  });

  it("shows the previous synchronization before any new one", async () => {
    const { root, controller } = harness();

    await controller.load();
    controller.render();

    expect(text(root)).toContain("마지막 동기화가 성공했습니다");
  });

  it("says so when nothing was ever synchronized", async () => {
    const { root, controller } = harness({
      autoDiscoverySettings: vi.fn(async () => ({
        ...SETTINGS,
        lastStatus: "never" as const,
        lastSyncedAt: null,
      })),
    });

    await controller.load();
    controller.render();

    expect(text(root)).toContain("아직 동기화하지 않았습니다");
  });

  it("does not synchronize twice at once", async () => {
    const { controller, api } = harness();
    await controller.load();

    await Promise.all([controller.sync(), controller.sync()]);

    expect(api.syncDiscovery).toHaveBeenCalledTimes(1);
  });

  it("shows a failure without leaving the screen blank", async () => {
    const { root, controller } = harness({
      syncDiscovery: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await controller.load();

    await controller.sync();
    controller.render();

    expect(text(root)).toContain("로컬 서비스가 실행 중인지 확인하세요");
  });
});

describe("search terms", () => {
  it("says the list is empty and what that means", async () => {
    const { root, controller } = harness();

    await controller.load();
    controller.render();

    expect(text(root)).toContain("이웃 새 글만 모읍니다");
  });

  it("saves a new term", async () => {
    const { root, controller, api } = harness();
    await controller.load();
    controller.render();

    type(root, "#new-search-query", "전시 후기");
    await controller.addSearch();

    expect(api.saveSearch).toHaveBeenCalledWith({ query: "전시 후기" });
  });

  it("never sends an empty term", async () => {
    const { controller, api } = harness();
    await controller.load();

    await controller.addSearch();

    expect(api.saveSearch).not.toHaveBeenCalled();
  });

  it("rejects a duplicate before asking the service", async () => {
    const { root, controller, api } = harness({
      savedSearches: vi.fn(async () => [SEARCH]),
    });
    await controller.load();
    controller.render();

    type(root, "#new-search-query", "전시 후기");
    await controller.addSearch();

    expect(api.saveSearch).not.toHaveBeenCalled();
    expect(text(root)).toContain("이미 저장한 검색어입니다");
  });

  it("lists a saved term with its freshness window", async () => {
    const { root, controller } = harness({
      savedSearches: vi.fn(async () => [SEARCH]),
    });

    await controller.load();
    controller.render();

    expect(text(root)).toContain("전시 후기 (최근 14일)");
  });

  it("removes a term and explains what stays", async () => {
    const { root, controller, api } = harness({
      savedSearches: vi.fn(async () => [SEARCH]),
    });
    await controller.load();
    controller.render();

    click(root, `.search-remove[data-search-id="${SEARCH.id}"]`);
    await Promise.resolve();
    await Promise.resolve();

    expect(api.deleteSearch).toHaveBeenCalledWith(SEARCH.id);
  });

  it("keeps the screen usable when the search list cannot be read", async () => {
    const { root, controller } = harness({
      savedSearches: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    });

    await controller.load();
    controller.render();

    expect(controller.state.phase).toBe("ready");
    expect(text(root)).toContain("저장한 검색어가 없습니다");
  });

  it("refreshes only the selected saved search", async () => {
    const { root, controller, api } = harness({
      savedSearches: vi.fn(async () => [SEARCH]),
    });
    await controller.load();

    await controller.refreshSearch(SEARCH.id);
    controller.render();

    expect(api.refreshSavedSearch).toHaveBeenCalledWith(SEARCH.id);
    expect(text(root)).toContain("검색 후보 4개를 확인했습니다");
  });

  it("connects the selected search refresh button to its row", async () => {
    const { root, controller, api } = harness({
      savedSearches: vi.fn(async () => [SEARCH]),
    });
    await controller.load();
    controller.render();

    click(root, `.search-refresh[data-search-id="${SEARCH.id}"]`);
    await Promise.resolve();
    await Promise.resolve();

    expect(api.refreshSavedSearch).toHaveBeenCalledWith(SEARCH.id);
  });

  it("explains how to fix a missing search API configuration", async () => {
    const { root, controller } = harness({
      savedSearches: vi.fn(async () => [SEARCH]),
      refreshSavedSearch: vi.fn(async () => {
        throw new ApiError("conflict", {
          problem: { code: "discovery_search_not_configured" } as never,
          status: 409,
        });
      }),
    });
    await controller.load();

    await controller.refreshSearch(SEARCH.id);
    controller.render();

    expect(text(root)).toContain("검색 API key가 설정되지 않았습니다");
  });
});

describe("neighbour management", () => {
  it("saves a manually entered public blog", async () => {
    const { root, controller, api } = harness();
    await controller.load();
    controller.render();

    type(root, "#neighbor-name", "합성 이웃");
    type(root, "#neighbor-blog-id", "neighbor");
    type(root, "#neighbor-blog-url", "https://blog.naver.com/neighbor");
    await controller.saveNeighbor();

    expect(api.saveDiscoveryNeighbor).toHaveBeenCalledWith({
      name: "합성 이웃",
      blogId: "neighbor",
      blogUrl: "https://blog.naver.com/neighbor",
    });
    expect(controller.state.neighbors).toEqual([NEIGHBOR]);
  });

  it("refuses an incomplete neighbour before asking the service", async () => {
    const { root, controller, api } = harness();
    await controller.load();

    await controller.saveNeighbor();
    controller.render();

    expect(api.saveDiscoveryNeighbor).not.toHaveBeenCalled();
    expect(text(root)).toContain("이웃 이름, 블로그 ID, 공개 URL을 모두 입력하세요");
  });

  it("shows RSS state and can stop collection without losing the blog identity", async () => {
    const disabled = { ...NEIGHBOR, enabled: false };
    const { root, controller, api } = harness({
      discoveryNeighbors: vi.fn(async () => [NEIGHBOR]),
      saveDiscoveryNeighbor: vi.fn(async () => disabled),
    });
    await controller.load();
    controller.render();

    click(root, `[data-neighbor-id="${NEIGHBOR.id}"]`);
    await Promise.resolve();
    await Promise.resolve();

    expect(text(root)).toContain("RSS 확인 가능");
    expect(api.saveDiscoveryNeighbor).toHaveBeenCalledWith({
      name: NEIGHBOR.name,
      blogId: NEIGHBOR.blogId,
      blogUrl: NEIGHBOR.blogUrl,
      enabled: false,
    });
    expect(controller.state.neighbors[0]?.enabled).toBe(false);
  });

  it("can turn an inactive neighbour back on", async () => {
    const inactive = { ...NEIGHBOR, enabled: false };
    const { controller, api } = harness({
      discoveryNeighbors: vi.fn(async () => [inactive]),
      saveDiscoveryNeighbor: vi.fn(async () => NEIGHBOR),
    });
    await controller.load();

    await controller.toggleNeighbor(inactive.id);

    expect(api.saveDiscoveryNeighbor).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it("ignores a neighbour that is no longer in the loaded list", async () => {
    const { controller, api } = harness();
    await controller.load();

    await controller.toggleNeighbor(NEIGHBOR.id);

    expect(api.saveDiscoveryNeighbor).not.toHaveBeenCalled();
  });
});

describe("email digest", () => {
  it("keeps email preference editable while SMTP is not configured", async () => {
    const { root, controller, api } = harness();
    await controller.load();
    controller.render();

    const email = root.querySelector<HTMLInputElement>("#digest-email-enabled");
    if (email === null) throw new Error("missing email checkbox");
    email.checked = true;
    email.dispatchEvent(new Event("change"));
    await controller.saveDigest();
    controller.render();

    expect(api.saveDigestSettings).toHaveBeenCalledWith({
      timezone: "Asia/Seoul",
      hour: 8,
      minute: 30,
      emailEnabled: true,
    });
    expect(text(root)).toContain("SMTP가 아직 설정되지 않았습니다");
  });

  it("retains a save failure as an actionable screen state", async () => {
    const { root, controller } = harness({
      saveDigestSettings: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await controller.load();

    await controller.saveDigest();
    controller.render();

    expect(text(root)).toContain("로컬 서비스가 실행 중인지 확인하세요");
  });

  it("changes the saved digest time", async () => {
    const { root, controller, api } = harness();
    await controller.load();
    controller.render();

    const hour = root.querySelector<HTMLInputElement>("#digest-hour");
    if (hour === null) throw new Error("missing digest hour");
    hour.value = "11";
    hour.dispatchEvent(new Event("change"));
    await controller.saveDigest();

    expect(api.saveDigestSettings).toHaveBeenCalledWith(expect.objectContaining({ hour: 11 }));
  });

  it("does not start any settings request while another save is in flight", async () => {
    const { controller, api } = harness({
      discoveryNeighbors: vi.fn(async () => [NEIGHBOR]),
      savedSearches: vi.fn(async () => [SEARCH]),
    });
    await controller.load();
    controller.state.phase = "saving";

    await controller.save();
    await controller.refreshSearch(SEARCH.id);
    await controller.toggleNeighbor(NEIGHBOR.id);
    await controller.saveDigest();

    expect(api.saveAutoDiscoverySettings).not.toHaveBeenCalled();
    expect(api.refreshSavedSearch).not.toHaveBeenCalled();
    expect(api.saveDiscoveryNeighbor).not.toHaveBeenCalled();
    expect(api.saveDigestSettings).not.toHaveBeenCalled();
  });
});

describe("comment, safety, and writing defaults", () => {
  it("saves the visible personalization mode and neighbour message", async () => {
    const { root, controller, api } = harness();
    await controller.load();
    controller.render();

    const personalization = root.querySelector<HTMLSelectElement>("#comment-personalization");
    if (personalization === null) throw new Error("missing personalization select");
    personalization.value = "completed_examples";
    personalization.dispatchEvent(new Event("change"));
    type(root, "#neighbor-message", "안녕하세요. 서로이웃 신청드립니다.");
    await controller.saveCommentSettings();

    expect(api.saveAppSetting).toHaveBeenCalledWith(
      "generation_profile",
      expect.objectContaining({ personalization_mode: "completed_examples" }),
    );
    expect(api.saveAppSetting).toHaveBeenCalledWith("neighbor_message", {
      message: "안녕하세요. 서로이웃 신청드립니다.",
    });
  });

  it("preserves a non-contiguous allowed-hour policy when another safety value changes", async () => {
    const { root, controller, api } = harness();
    await controller.load();
    controller.render();

    const cap = root.querySelector<HTMLInputElement>("#daily-like-cap");
    if (cap === null) throw new Error("missing daily like cap");
    cap.value = "12";
    cap.dispatchEvent(new Event("change"));
    await controller.saveAutomationSettings();

    expect(api.saveAppSetting).toHaveBeenCalledWith(
      "safety_policy",
      expect.objectContaining({ allowed_hours: [9, 11], daily_like_cap: 12 }),
    );
  });

  it("saves reference and tag limits from the writing defaults", async () => {
    const { root, controller, api } = harness();
    await controller.load();
    controller.render();

    const references = root.querySelector<HTMLInputElement>("#writing-reference-post-count");
    const tags = root.querySelector<HTMLInputElement>("#writing-body-tag-cap");
    if (references === null || tags === null) throw new Error("missing writing limits");
    references.value = "4";
    references.dispatchEvent(new Event("change"));
    tags.value = "12";
    tags.dispatchEvent(new Event("change"));
    await controller.saveWritingSettings();

    expect(api.saveAppSetting).toHaveBeenCalledWith(
      "writing_profile",
      expect.objectContaining({ reference_post_count: 4, body_tag_cap: 12 }),
    );
  });

  it("wires the complete visible settings form to explicit handlers", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const handlers = {
      onAddSearch: vi.fn(),
      onAutomationFieldChange: vi.fn(),
      onCommentFieldChange: vi.fn(),
      onDeleteSearch: vi.fn(),
      onDigestFieldChange: vi.fn(),
      onFieldChange: vi.fn(),
      onNeighborFieldChange: vi.fn(),
      onQueryChange: vi.fn(),
      onRefresh: vi.fn(),
      onRefreshSearch: vi.fn(),
      onSave: vi.fn(),
      onSaveAutomationSettings: vi.fn(),
      onSaveCommentSettings: vi.fn(),
      onSaveDigest: vi.fn(),
      onSaveNeighbor: vi.fn(),
      onSaveWritingSettings: vi.fn(),
      onSectionChange: vi.fn(),
      onScheduleFieldChange: vi.fn(),
      onBudgetFieldChange: vi.fn(),
      onSaveScheduleAndBudget: vi.fn(),
      onSync: vi.fn(),
      onToggleNeighbor: vi.fn(),
      onWritingFieldChange: vi.fn(),
    };
    const state = {
      ...initialSettingsState(),
      digest: DIGEST,
      neighbors: [NEIGHBOR],
      searches: [SEARCH],
      settings: SETTINGS,
    };
    renderSettings(root, state, handlers);

    for (const selector of [
      "#save-discovery-button",
      "#refresh-settings-button",
      "#sync-discovery-button",
      "#add-search-button",
      ".search-refresh",
      ".search-remove",
      "#save-neighbor-button",
      ".neighbor-toggle",
      "#save-digest-button",
      "#save-comment-settings-button",
      "#save-automation-settings-button",
      "#save-writing-settings-button",
    ]) {
      (root.querySelector(selector) as HTMLButtonElement).click();
    }
    const ownBlog = root.querySelector<HTMLInputElement>("#own-blog-id") as HTMLInputElement;
    ownBlog.value = "mine";
    ownBlog.dispatchEvent(new Event("input"));
    const query = root.querySelector<HTMLInputElement>("#new-search-query") as HTMLInputElement;
    query.value = "기록";
    query.dispatchEvent(new Event("input"));
    const consent = root.querySelector<HTMLInputElement>("#automation-consent") as HTMLInputElement;
    consent.checked = true;
    consent.dispatchEvent(new Event("change"));
    (root.querySelector('[aria-label="0시 허용"]') as HTMLInputElement).click();
    const writingLength = root.querySelector<HTMLSelectElement>(
      "#writing-length",
    ) as HTMLSelectElement;
    writingLength.value = "long";
    writingLength.dispatchEvent(new Event("change"));

    expect(handlers.onSave).toHaveBeenCalledTimes(1);
    expect(handlers.onQueryChange).toHaveBeenCalledWith("기록");
    expect(handlers.onAutomationFieldChange).toHaveBeenCalled();
    expect(handlers.onWritingFieldChange).toHaveBeenCalledWith({ targetLength: "long" });
  });
});
