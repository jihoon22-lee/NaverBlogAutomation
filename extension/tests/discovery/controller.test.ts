import { readFile } from "node:fs/promises";

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscoveryController } from "../../src/discovery/controller";

const htmlPath = new URL("../../public/sidepanel.html", import.meta.url);
const id = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-07-26T00:00:00Z";
let document: Document;
let domWindow: Window & typeof globalThis;

const client = {
  listDiscoveryNeighbors: vi.fn(),
  listDiscoverySearches: vi.fn(),
  listDiscoveryQueue: vi.fn(),
  refreshDiscoveryNeighbors: vi.fn(),
  saveDiscoveryNeighbor: vi.fn(),
  saveDiscoverySearch: vi.fn(),
  importDiscoveryPosts: vi.fn(),
  updateDiscoveryPostState: vi.fn(),
  digestSettings: vi.fn(),
  saveDigestSettings: vi.fn(),
};
const gateway = { capture: vi.fn() };

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
  Object.assign(domWindow, { confirm: vi.fn(() => true) });
  vi.stubGlobal("chrome", { tabs: { update: vi.fn().mockResolvedValue(undefined) } });
  vi.clearAllMocks();
  client.listDiscoveryNeighbors.mockResolvedValue([{ id, name: "이웃", feedStatus: "ready" }]);
  client.listDiscoverySearches.mockResolvedValue([{ id, query: "여행", freshnessDays: 14 }]);
  client.listDiscoveryQueue.mockResolvedValue([
    {
      id,
      title: "대기 글",
      publisherName: "이웃",
      publishedAt: timestamp,
      sourceUrl: "https://blog.naver.com/friend/1",
    },
  ]);
  client.refreshDiscoveryNeighbors.mockResolvedValue(2);
  client.saveDiscoveryNeighbor.mockResolvedValue({});
  client.saveDiscoverySearch.mockResolvedValue({});
  client.importDiscoveryPosts.mockResolvedValue(1);
  client.updateDiscoveryPostState.mockResolvedValue({});
  client.digestSettings.mockResolvedValue({
    timezone: "Asia/Seoul",
    hour: 9,
    minute: 0,
    emailEnabled: false,
    smtpConfigured: false,
  });
  client.saveDigestSettings.mockResolvedValue({
    timezone: "Asia/Seoul",
    hour: 8,
    minute: 30,
    emailEnabled: false,
    smtpConfigured: false,
  });
  gateway.capture.mockResolvedValue({
    blogs: [{ name: "가져온 이웃", blogId: "friend", blogUrl: "https://blog.naver.com/friend" }],
    posts: [
      { title: "검색 글", sourceUrl: "https://blog.naver.com/friend/2", publisherName: null },
    ],
  });
});
afterEach(() => vi.unstubAllGlobals());

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("DiscoveryController", () => {
  it("renders queues and handles user-confirmed refresh, imports, saves, and opening", async () => {
    const controller = new DiscoveryController(document, gateway as never, client as never);
    controller.start();
    await settle();
    expect(document.querySelector("#discovery-queue")?.textContent).toContain("대기 글");

    (document.querySelector("#discovery-refresh-button") as HTMLButtonElement).click();
    await settle();
    expect(client.refreshDiscoveryNeighbors).toHaveBeenCalledOnce();
    (document.querySelector("#import-neighbors-button") as HTMLButtonElement).click();
    await settle();
    expect(client.saveDiscoveryNeighbor).toHaveBeenCalledWith(
      expect.objectContaining({ name: "가져온 이웃" }),
    );

    const neighborForm = document.querySelector("#discovery-neighbor-form") as HTMLFormElement;
    (neighborForm.elements.namedItem("name") as HTMLInputElement).value = "직접 이웃";
    (neighborForm.elements.namedItem("blog-id") as HTMLInputElement).value = "direct";
    (neighborForm.elements.namedItem("blog-url") as HTMLInputElement).value =
      "https://blog.naver.com/direct";
    neighborForm.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(client.saveDiscoveryNeighbor).toHaveBeenCalledWith(
      expect.objectContaining({ name: "직접 이웃" }),
    );

    const searchForm = document.querySelector("#discovery-search-form") as HTMLFormElement;
    (searchForm.elements.namedItem("query") as HTMLInputElement).value = "여행";
    searchForm.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(client.saveDiscoverySearch).toHaveBeenCalled();

    const digestForm = document.querySelector("#discovery-digest-form") as HTMLFormElement;
    digestForm.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(client.saveDigestSettings).toHaveBeenCalled();

    (document.querySelector("[data-import-search]") as HTMLButtonElement).click();
    await settle();
    expect(client.importDiscoveryPosts).toHaveBeenCalledWith("search", id, expect.any(Array));
    (document.querySelector("[data-action=skip]") as HTMLButtonElement).click();
    await settle();
    expect(client.updateDiscoveryPostState).toHaveBeenCalledWith(id, "skipped");
    (document.querySelector("[data-action=open]") as HTMLButtonElement).click();
    await settle();
    expect(chrome.tabs.update).toHaveBeenCalledWith({ url: "https://blog.naver.com/friend/1" });
  });

  it("keeps the queue safe when discovery actions cannot proceed", async () => {
    const controller = new DiscoveryController(document, gateway as never, client as never);
    controller.start();
    await settle();

    client.refreshDiscoveryNeighbors.mockRejectedValueOnce(new Error("갱신 실패"));
    (document.querySelector("#discovery-refresh-button") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("#discovery-notice")?.textContent).toContain("갱신 실패");
    client.refreshDiscoveryNeighbors.mockRejectedValueOnce("unknown");
    (document.querySelector("#discovery-refresh-button") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("#discovery-notice")?.textContent).toContain(
      "갱신하지 못했습니다",
    );

    gateway.capture.mockResolvedValueOnce({ blogs: [], posts: [] });
    (document.querySelector("#import-neighbors-button") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("#discovery-notice")?.textContent).toContain("찾지 못했습니다");

    gateway.capture.mockResolvedValueOnce({ blogs: [], posts: [] });
    (document.querySelector("[data-import-search]") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("#discovery-notice")?.textContent).toContain("찾지 못했습니다");

    client.updateDiscoveryPostState.mockRejectedValueOnce(new Error("상태 실패"));
    (document.querySelector("[data-action=skip]") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("#discovery-notice")?.textContent).toContain("상태 실패");

    (document.querySelector("#discovery-search-tab") as HTMLButtonElement).click();
    await settle();
    expect(client.listDiscoveryQueue).toHaveBeenCalledWith("search");
    (document.querySelector("#discovery-neighbor-tab") as HTMLButtonElement).click();
    await settle();

    (document.querySelector("#discovery-searches") as HTMLElement).click();
    (document.querySelector("#discovery-queue") as HTMLElement).click();
    await settle();

    Object.assign(domWindow, { confirm: vi.fn(() => false) });
    gateway.capture.mockResolvedValueOnce({
      blogs: [{ name: "이웃", blogId: "friend", blogUrl: "https://blog.naver.com/friend" }],
      posts: [{ title: "글", sourceUrl: "https://blog.naver.com/friend/3", publisherName: null }],
    });
    (document.querySelector("#import-neighbors-button") as HTMLButtonElement).click();
    await settle();
    expect(client.saveDiscoveryNeighbor).not.toHaveBeenCalled();

    gateway.capture.mockResolvedValueOnce({
      blogs: [],
      posts: [{ title: "글", sourceUrl: "https://blog.naver.com/friend/3", publisherName: null }],
    });
    (document.querySelector("[data-import-search]") as HTMLButtonElement).click();
    await settle();
    expect(client.importDiscoveryPosts).not.toHaveBeenCalled();

    const row = document.querySelector("#discovery-queue li") as HTMLLIElement;
    delete row.dataset.url;
    (document.querySelector("[data-action=open]") as HTMLButtonElement).click();
    await settle();
    expect(chrome.tabs.update).not.toHaveBeenCalled();

    client.saveDigestSettings.mockRejectedValueOnce(new Error("요약 실패"));
    (document.querySelector("#discovery-digest-form") as HTMLFormElement).dispatchEvent(
      new domWindow.Event("submit", { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(document.querySelector("#discovery-notice")?.textContent).toContain("요약 실패");
  });
});
