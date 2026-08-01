/** Settings screen: discovery form, synchronization reporting, and search terms. */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AutoDiscoverySettings,
  DigestSettings,
  DiscoveryNeighbor,
  DiscoverySearchRefresh,
  DiscoverySyncResult,
  SavedSearch,
} from "../../src/app/api/types";
import { ApiError } from "../../src/app/api/client";
import { SettingsController } from "../../src/app/controllers/settings";

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

interface Api {
  autoDiscoverySettings: ReturnType<typeof vi.fn>;
  saveAutoDiscoverySettings: ReturnType<typeof vi.fn>;
  syncDiscovery: ReturnType<typeof vi.fn>;
  savedSearches: ReturnType<typeof vi.fn>;
  saveSearch: ReturnType<typeof vi.fn>;
  deleteSearch: ReturnType<typeof vi.fn>;
  discoveryNeighbors: ReturnType<typeof vi.fn>;
  saveDiscoveryNeighbor: ReturnType<typeof vi.fn>;
  refreshSavedSearch: ReturnType<typeof vi.fn>;
  digestSettings: ReturnType<typeof vi.fn>;
  saveDigestSettings: ReturnType<typeof vi.fn>;
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
    autoDiscoverySettings: vi.fn(async () => SETTINGS),
    saveAutoDiscoverySettings: vi.fn(async () => SETTINGS),
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
