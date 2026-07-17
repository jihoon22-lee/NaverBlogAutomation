import { BrowserCaptureError, type TabCaptureGateway } from "../browser/tab-capture-gateway";
import { chooseCapturedPost } from "../extraction/rank-captures";
import { parseSupportedNaverUrl } from "../extraction/source-url";
import type { CaptureFailureCode } from "../extraction/types";
import type { PanelState, PanelView } from "./state";

export class SidePanelController {
  readonly #gateway: TabCaptureGateway;
  readonly #view: PanelView;
  #activeTabId: number | null = null;
  #operation = 0;
  #unsubscribe: (() => void) | null = null;

  constructor(gateway: TabCaptureGateway, view: PanelView) {
    this.#gateway = gateway;
    this.#view = view;
    this.#view.onRetry(() => {
      void this.captureActivePost();
    });
  }

  start(): void {
    this.#unsubscribe = this.#gateway.subscribeToInvalidation((event) => {
      if (event.kind === "updated" && event.tabId !== this.#activeTabId) {
        return;
      }
      this.#operation += 1;
      if (event.kind === "activated") {
        this.#activeTabId = event.tabId;
      }
      this.#renderError("stale_page");
    });
    void this.captureActivePost();
  }

  dispose(): void {
    this.#operation += 1;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  async captureActivePost(): Promise<void> {
    const operation = ++this.#operation;
    this.#view.render({ kind: "extracting" });
    try {
      const before = await this.#gateway.getActiveTab();
      if (operation !== this.#operation) {
        return;
      }
      this.#activeTabId = before.id;
      if (parseSupportedNaverUrl(before.url) === null) {
        this.#renderIfCurrent(operation, { failure: { code: "unsupported_url" }, kind: "error" });
        return;
      }
      const frames = await this.#gateway.captureAllFrames(before.id);
      if (operation !== this.#operation) {
        return;
      }
      const after = await this.#gateway.getActiveTab();
      if (operation !== this.#operation) {
        return;
      }
      if (before.id !== after.id || before.url !== after.url) {
        this.#renderError("stale_page");
        return;
      }
      const result = chooseCapturedPost(before, frames);
      this.#view.render(
        result.ok
          ? { kind: "preview", preview: result.preview }
          : { failure: result.failure, kind: "error" },
      );
    } catch (error) {
      const code = error instanceof BrowserCaptureError ? error.code : "extraction_failed";
      this.#renderIfCurrent(operation, { failure: { code }, kind: "error" });
    }
  }

  #renderError(code: CaptureFailureCode): void {
    this.#view.render({ failure: { code }, kind: "error" });
  }

  #renderIfCurrent(operation: number, state: PanelState): void {
    if (operation === this.#operation) {
      this.#view.render(state);
    }
  }
}
