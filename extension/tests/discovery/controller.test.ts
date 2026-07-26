import { readFile } from "node:fs/promises";

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscoveryController } from "../../src/discovery/controller";

const htmlPath = new URL("../../public/sidepanel.html", import.meta.url);
const id = "11111111-1111-4111-8111-111111111111";
let document: Document;
let domWindow: Window & typeof globalThis;

const client = {
  automaticDiscoverySettings: vi.fn(),
  digestSettings: vi.fn(),
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
  vi.clearAllMocks();
  client.listDiscoveryNeighbors.mockResolvedValue([]);
  client.listDiscoverySearches.mockResolvedValue([{ id, query: "여행", freshnessDays: 14 }]);
  client.listDiscoveryQueue.mockResolvedValue([
    {
      id,
      title: "대기 글",
      publisherName: "이웃",
      publishedAt: "2026-07-26T00:00:00Z",
      sourceUrl: "https://blog.naver.com/friend/1",
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
  client.refreshDiscoverySearch.mockResolvedValue({
    importedCount: 2,
    provider: "naver_open_api",
    detail: "공식 네이버 검색 API에서 검색 후보 2개를 확인했습니다.",
  });
  client.saveDigestSettings.mockResolvedValue({});
  client.updateDiscoveryPostState.mockResolvedValue({});
});
afterEach(() => vi.unstubAllGlobals());

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("DiscoveryController", () => {
  it("onboards automatic discovery, synchronizes, and renders the local queue", async () => {
    const controller = new DiscoveryController(document, client as never);
    controller.start();
    await settle();
    expect(document.querySelector("#discovery-queue")?.textContent).toContain("대기 글");

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
    const controller = new DiscoveryController(document, client as never);
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
    const controller = new DiscoveryController(document, client as never);
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
    const controller = new DiscoveryController(document, client as never);
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
    expect(chrome.tabs.update).toHaveBeenCalledWith({ url: "https://blog.naver.com/friend/2" });
    expect(client.updateDiscoveryPostState).toHaveBeenCalledWith(id, "opened");
  });
});
