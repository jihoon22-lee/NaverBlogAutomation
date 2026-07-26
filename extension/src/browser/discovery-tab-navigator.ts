export type DiscoveryNavigationTarget = "current" | "new";

export interface DiscoveryTabNavigator {
  open(url: string, target: DiscoveryNavigationTarget): Promise<number>;
}

export interface ChromeDiscoveryTabNavigationApi {
  tabs: Pick<typeof chrome.tabs, "create" | "onUpdated" | "update">;
}

export class ChromeDiscoveryTabNavigator implements DiscoveryTabNavigator {
  readonly #api: ChromeDiscoveryTabNavigationApi;

  constructor(api: ChromeDiscoveryTabNavigationApi = chrome) {
    this.#api = api;
  }

  async open(url: string, target: DiscoveryNavigationTarget): Promise<number> {
    const tab =
      target === "new"
        ? await this.#api.tabs.create({ active: true, url })
        : await this.#api.tabs.update({ url });
    if (tab?.id === undefined) throw new Error("탐색할 탭을 열지 못했습니다.");
    const tabId = tab.id;
    if (tab.status === "complete") return tabId;
    await this.#waitForComplete(tabId);
    return tabId;
  }

  #waitForComplete(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        cleanup();
        reject(new Error("글 페이지를 불러오는 시간이 초과되었습니다."));
      }, 15_000);
      const listener = (changedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo): void => {
        if (changedTabId !== tabId || changeInfo.status !== "complete") return;
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        globalThis.clearTimeout(timeout);
        this.#api.tabs.onUpdated.removeListener(listener);
      };
      this.#api.tabs.onUpdated.addListener(listener);
    });
  }
}
