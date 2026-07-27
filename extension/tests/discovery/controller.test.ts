import { readFile } from "node:fs/promises";

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscoveryController } from "../../src/discovery/controller";

const htmlPath = new URL("../../public/sidepanel.html", import.meta.url);
const id = "11111111-1111-4111-8111-111111111111";
const searchId = "22222222-2222-4222-8222-222222222222";
let document: Document;
let domWindow: Window & typeof globalThis;

const client = {
  automaticDiscoverySettings: vi.fn(),
  digestSettings: vi.fn(),
  deleteDiscoverySearch: vi.fn(),
  listDiscoveryNeighbors: vi.fn(),
  listDiscoveryQueue: vi.fn(),
  listDiscoverySearches: vi.fn(),
  saveAutomaticDiscoverySettings: vi.fn(),
  saveDigestSettings: vi.fn(),
  saveDiscoveryNeighbor: vi.fn(),
  saveDiscoverySearch: vi.fn(),
  refreshDiscoverySearch: vi.fn(),
  syncAutomaticDiscovery: vi.fn(),
  updateDiscoveryPostState: vi.fn(),
};
const navigator = { open: vi.fn() };

beforeEach(async () => {
  const dom = new JSDOM(await readFile(htmlPath, "utf8"), {
    url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sidepanel.html",
  });
  document = dom.window.document;
  domWindow = dom.window as unknown as Window & typeof globalThis;
  vi.stubGlobal("window", domWindow);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
  vi.stubGlobal("HTMLFormElement", dom.window.HTMLFormElement);
  vi.stubGlobal("FormData", dom.window.FormData);
  vi.stubGlobal("chrome", { tabs: { update: vi.fn().mockResolvedValue(undefined) } });
  vi.resetAllMocks();
  client.listDiscoveryNeighbors.mockResolvedValue([]);
  client.listDiscoverySearches.mockResolvedValue([{ id, query: "여행", freshnessDays: 14 }]);
  client.listDiscoveryQueue.mockImplementation(async (source: "neighbor" | "search") => [
    {
      createdAt: "2026-07-26T00:00:00Z",
      id: source === "neighbor" ? id : searchId,
      neighborId: source === "neighbor" ? "neighbor-id" : null,
      publishedAt: "2026-07-26T00:00:00Z",
      publisherBlogId: source === "search" ? "candidate" : "friend",
      publisherName: source === "neighbor" ? "이웃" : "신규 후보",
      searchId: source === "search" ? "saved-search-id" : null,
      source,
      sourceUrl:
        source === "neighbor"
          ? "https://blog.naver.com/friend/1"
          : "https://blog.naver.com/candidate/2",
      state: "queued",
      title: source === "neighbor" ? "대기 글" : "검색 후보 글",
      updatedAt: "2026-07-26T00:00:00Z",
    },
  ]);
  client.automaticDiscoverySettings.mockResolvedValue({
    ownBlogId: "",
    enabled: false,
    timezone: "Asia/Seoul",
    hour: 9,
    minute: 0,
    lastSyncedAt: null,
    lastStatus: "never",
    lastDetail: "",
  });
  client.digestSettings.mockResolvedValue({
    timezone: "Asia/Seoul",
    hour: 9,
    minute: 0,
    emailEnabled: false,
    smtpConfigured: false,
  });
  client.saveAutomaticDiscoverySettings.mockResolvedValue({
    ownBlogId: "mine",
    enabled: true,
    timezone: "Asia/Seoul",
    hour: 8,
    minute: 30,
    lastSyncedAt: null,
    lastStatus: "never",
    lastDetail: "",
  });
  client.syncAutomaticDiscovery.mockResolvedValue({
    neighborsAdded: 2,
    neighborPostsAdded: 3,
    searchPostsAdded: 1,
    status: "success",
    detail: "이웃 2개, 이웃 새 글 3개, 검색 후보 1개를 확인했습니다.",
  });
  client.saveDiscoveryNeighbor.mockResolvedValue({});
  client.saveDiscoverySearch.mockResolvedValue({ id });
  client.deleteDiscoverySearch.mockResolvedValue(undefined);
  client.refreshDiscoverySearch.mockResolvedValue({
    importedCount: 2,
    provider: "naver_open_api",
    detail: "공식 네이버 검색 API에서 검색 후보 2개를 확인했습니다.",
  });
  client.saveDigestSettings.mockResolvedValue({});
  client.updateDiscoveryPostState.mockImplementation(async (postId: string) => ({
    id: postId,
    state: "opened",
  }));
  navigator.open.mockResolvedValue(7);
});
afterEach(() => vi.unstubAllGlobals());

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("DiscoveryController", () => {
  it("onboards automatic discovery, synchronizes, and renders the local queue", async () => {
    const controller = new DiscoveryController(document, client as never, navigator);
    controller.start();
    await settle();
    expect(document.querySelector("#discovery-queue")?.textContent).toContain("대기 글");
    expect(document.querySelector("#today-neighbor-count")?.textContent).toBe("1");
    expect(document.querySelector("#today-search-count")?.textContent).toBe("1");
    expect(document.querySelector("#discovery-settings")?.hasAttribute("open")).toBe(false);
    expect(document.querySelector("#discovery-notice")?.textContent).toContain("탐색 설정과 알림");

    const form = document.querySelector("#discovery-automation-form") as HTMLFormElement;
    (form.elements.namedItem("own-blog-id") as HTMLInputElement).value = "mine";
    (form.elements.namedItem("automation-enabled") as HTMLInputElement).checked = true;
    form.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(client.saveAutomaticDiscoverySettings).toHaveBeenCalledWith(
      expect.objectContaining({ ownBlogId: "mine", enabled: true }),
    );

    (document.querySelector("#discovery-sync-button") as HTMLButtonElement).click();
    await settle();
    expect(client.syncAutomaticDiscovery).toHaveBeenCalledOnce();
    expect(document.querySelector("#discovery-notice")?.textContent).toContain("이웃 2개");

    (document.querySelector("[data-action=skip]") as HTMLButtonElement).click();
    await settle();
    expect(client.updateDiscoveryPostState).toHaveBeenCalledWith(id, "skipped");
  });

  it("keeps failures understandable and leaves queue actions safe", async () => {
    const controller = new DiscoveryController(document, client as never, navigator);
    controller.start();
    await settle();
    client.syncAutomaticDiscovery.mockRejectedValueOnce(new Error("동기화 실패"));
    (document.querySelector("#discovery-sync-button") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("#discovery-notice")?.textContent).toContain("동기화 실패");

    client.updateDiscoveryPostState.mockRejectedValueOnce(new Error("상태 실패"));
    (document.querySelector("[data-action=skip]") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("#discovery-notice")?.textContent).toContain("상태 실패");
  });

  it("refreshes a saved search immediately and preserves a useful setup failure", async () => {
    const controller = new DiscoveryController(document, client as never, navigator);
    controller.start();
    await settle();
    const form = document.querySelector("#discovery-search-form") as HTMLFormElement;
    (form.elements.namedItem("query") as HTMLInputElement).value = "전시";
    form.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(client.refreshDiscoverySearch).toHaveBeenCalledWith(id);
    expect(document.querySelector("#discovery-notice")?.textContent).toContain("검색 후보 2개");

    client.refreshDiscoverySearch.mockRejectedValueOnce(
      new Error("NAVER_SEARCH_CLIENT_ID 설정이 필요합니다."),
    );
    form.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(document.querySelector("#discovery-notice")?.textContent).toContain(
      "신규 이웃 검색어를 저장했습니다.",
    );
  });

  it("removes a saved search without removing its existing search candidates", async () => {
    vi.spyOn(domWindow, "confirm").mockReturnValue(true);
    const controller = new DiscoveryController(document, client as never, navigator);
    controller.start();
    await settle();

    (document.querySelector("[data-action=delete-search]") as HTMLButtonElement).click();
    await settle();

    expect(client.deleteDiscoverySearch).toHaveBeenCalledWith(id);
    expect(document.querySelector("#discovery-notice")?.textContent).toContain(
      "기존에 수집된 후보는 유지",
    );
  });

  it("shows persisted automatic status and opens a queued post without a page import", async () => {
    client.automaticDiscoverySettings.mockResolvedValueOnce({
      ownBlogId: "mine",
      enabled: true,
      timezone: "Asia/Seoul",
      hour: 8,
      minute: 30,
      lastSyncedAt: "2026-07-26T00:00:00Z",
      lastStatus: "partial",
      lastDetail: "검색 결과 일부를 다시 시도해 주세요.",
    });
    client.digestSettings.mockResolvedValueOnce({
      timezone: "Asia/Seoul",
      hour: 9,
      minute: 0,
      emailEnabled: true,
      smtpConfigured: true,
    });
    client.listDiscoveryQueue.mockResolvedValueOnce([
      {
        id,
        title: "게시일 미상 글",
        publisherName: null,
        publishedAt: null,
        sourceUrl: "https://blog.naver.com/friend/2",
      },
    ]);
    const controller = new DiscoveryController(document, client as never, navigator);
    controller.start();
    await settle();

    expect(document.querySelector("#discovery-automation-status")?.textContent).toContain(
      "검색 결과 일부",
    );
    expect(document.querySelector("#discovery-smtp-status")?.textContent).toContain(
      "준비되었습니다",
    );
    expect(document.querySelector("#discovery-queue")?.textContent).toContain("게시일 미상");

    (document.querySelector("[data-action=open]") as HTMLButtonElement).click();
    await settle();
    expect(navigator.open).toHaveBeenCalledWith("https://blog.naver.com/friend/2", "current");
    expect(client.updateDiscoveryPostState).toHaveBeenCalledWith(id, "opened");
  });

  it("keeps the current post available while opening a queue item in a new tab", async () => {
    const opened = vi.fn();
    window.addEventListener("discovery-open-post", opened, { once: true });
    const controller = new DiscoveryController(document, client as never, navigator);
    controller.start();
    await settle();

    (document.querySelector("[data-action=open-new]") as HTMLButtonElement).click();
    await settle();

    expect(navigator.open).toHaveBeenCalledWith("https://blog.naver.com/friend/1", "new");
    expect(client.updateDiscoveryPostState).toHaveBeenCalledWith(id, "opened");
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          post: expect.objectContaining({ id }),
          tabId: 7,
        }),
      }),
    );
  });

  it("shows source filters and opens the next item after the current post", async () => {
    const nextId = "33333333-3333-4333-8333-333333333333";
    client.listDiscoveryQueue.mockImplementation(async (source: "neighbor" | "search") =>
      source === "search"
        ? []
        : [
            {
              createdAt: "2026-07-26T00:00:00Z",
              id,
              neighborId: "neighbor-id",
              publishedAt: null,
              publisherBlogId: "friend",
              publisherName: "이웃",
              searchId: null,
              source,
              sourceUrl: "https://blog.naver.com/friend/1",
              state: "opened",
              title: "현재 글",
              updatedAt: "2026-07-26T00:00:00Z",
            },
            {
              createdAt: "2026-07-26T00:00:00Z",
              id: nextId,
              neighborId: "neighbor-id",
              publishedAt: null,
              publisherBlogId: "friend",
              publisherName: "이웃",
              searchId: null,
              source,
              sourceUrl: "https://blog.naver.com/friend/2",
              state: "queued",
              title: "다음 글",
              updatedAt: "2026-07-26T00:00:00Z",
            },
          ],
    );
    const opened = vi.fn();
    window.addEventListener("discovery-open-post", opened);
    const controller = new DiscoveryController(document, client as never, navigator);
    controller.start();
    await settle();

    expect((document.querySelector("#today-current-card") as HTMLElement).hidden).toBe(false);
    expect(document.querySelector("#today-current-post")?.textContent).toContain("현재 글");
    await controller.openNext("neighbor");

    expect(navigator.open).toHaveBeenLastCalledWith("https://blog.naver.com/friend/2", "current");
    expect(client.updateDiscoveryPostState).toHaveBeenLastCalledWith(nextId, "opened");
    expect(opened).toHaveBeenCalled();
  });

  it("clears a locally remembered current card after the server marks it completed", async () => {
    let current = true;
    client.listDiscoveryQueue.mockImplementation(async (source: "neighbor" | "search") =>
      source === "search"
        ? []
        : current
          ? [
              {
                createdAt: "2026-07-26T00:00:00Z",
                id,
                neighborId: "neighbor-id",
                publishedAt: null,
                publisherBlogId: "friend",
                publisherName: "이웃",
                searchId: null,
                source,
                sourceUrl: "https://blog.naver.com/friend/1",
                state: "opened",
                title: "현재 글",
                updatedAt: "2026-07-26T00:00:00Z",
              },
            ]
          : [],
    );
    const controller = new DiscoveryController(document, client as never, navigator);
    controller.start();
    await settle();
    expect((document.querySelector("#today-current-card") as HTMLElement).hidden).toBe(false);

    current = false;
    await controller.refresh();

    expect((document.querySelector("#today-current-card") as HTMLElement).hidden).toBe(true);
  });

  it("returns to Today when no next queue item remains", async () => {
    client.listDiscoveryQueue.mockResolvedValue([]);
    const empty = vi.fn();
    window.addEventListener("discovery-next-empty", empty, { once: true });
    const controller = new DiscoveryController(document, client as never, navigator);
    controller.start();
    await settle();

    await controller.openNext("neighbor");

    expect(empty).toHaveBeenCalledOnce();
    expect(document.querySelector("#discovery-notice")?.textContent).toContain("다음");
  });
});
