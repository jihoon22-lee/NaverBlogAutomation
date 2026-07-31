/** Settings screen: discovery form, synchronization reporting, and search terms. */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AutoDiscoverySettings,
  DiscoverySyncResult,
  SavedSearch,
} from "../../src/app/api/types";
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

interface Api {
  autoDiscoverySettings: ReturnType<typeof vi.fn>;
  saveAutoDiscoverySettings: ReturnType<typeof vi.fn>;
  syncDiscovery: ReturnType<typeof vi.fn>;
  savedSearches: ReturnType<typeof vi.fn>;
  saveSearch: ReturnType<typeof vi.fn>;
  deleteSearch: ReturnType<typeof vi.fn>;
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

    click(root, `[data-search-id="${SEARCH.id}"]`);
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
});
