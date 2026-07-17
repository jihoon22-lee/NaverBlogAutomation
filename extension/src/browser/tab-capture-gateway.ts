import { captureCurrentFrame } from "../extraction/capture-current-frame";
import type { ActiveTab, CaptureFailureCode, FrameExecution } from "../extraction/types";

export interface TabCaptureGateway {
  captureAllFrames(tabId: number): Promise<readonly FrameExecution[]>;
  getActiveTab(): Promise<ActiveTab>;
  subscribeToInvalidation(listener: (event: TabInvalidation) => void): () => void;
}

export type TabInvalidation =
  | { kind: "activated"; tabId: number }
  | { kind: "updated"; tabId: number };

export class BrowserCaptureError extends Error {
  readonly code: CaptureFailureCode;

  constructor(code: CaptureFailureCode) {
    super(code);
    this.name = "BrowserCaptureError";
    this.code = code;
  }
}

export interface ChromeCaptureApi {
  scripting: Pick<typeof chrome.scripting, "executeScript">;
  tabs: Pick<typeof chrome.tabs, "onActivated" | "onUpdated" | "query">;
}

export class ChromeTabCaptureGateway implements TabCaptureGateway {
  readonly #api: ChromeCaptureApi;

  constructor(api: ChromeCaptureApi = chrome) {
    this.#api = api;
  }

  async getActiveTab(): Promise<ActiveTab> {
    const [tab] = await this.#api.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined || tab.url === undefined) {
      throw new BrowserCaptureError("no_active_tab");
    }
    return {
      id: tab.id,
      title: tab.title ?? "",
      url: tab.url,
    };
  }

  async captureAllFrames(tabId: number): Promise<readonly FrameExecution[]> {
    try {
      const results = await this.#api.scripting.executeScript({
        func: captureCurrentFrame,
        target: { allFrames: true, tabId },
        world: "ISOLATED",
      });
      return results.map((injection) => ({
        frameId: injection.frameId,
        result: injection.result ?? null,
        ...(injection.documentId === undefined ? {} : { documentId: injection.documentId }),
      }));
    } catch {
      throw new BrowserCaptureError("permission_denied");
    }
  }

  subscribeToInvalidation(listener: (event: TabInvalidation) => void): () => void {
    const onActivated = ({ tabId }: chrome.tabs.OnActivatedInfo): void =>
      listener({ kind: "activated", tabId });
    const onUpdated = (
      tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      _tab: chrome.tabs.Tab,
    ): void => {
      if (changeInfo.url !== undefined || changeInfo.status === "loading") {
        listener({ kind: "updated", tabId });
      }
    };
    this.#api.tabs.onActivated.addListener(onActivated);
    this.#api.tabs.onUpdated.addListener(onUpdated);
    return () => {
      this.#api.tabs.onActivated.removeListener(onActivated);
      this.#api.tabs.onUpdated.removeListener(onUpdated);
    };
  }
}
