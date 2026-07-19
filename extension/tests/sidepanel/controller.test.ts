import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BrowserCaptureError,
  type TabCaptureGateway,
  type TabInvalidation,
} from "../../src/browser/tab-capture-gateway";
import type { ActiveTab, FrameExecution } from "../../src/extraction/types";
import { SidePanelController } from "../../src/sidepanel/controller";
import type { PanelActions, PanelState, PanelView } from "../../src/sidepanel/state";

const activeTab: ActiveTab = {
  id: 11,
  title: "합성 글",
  url: "https://blog.naver.com/synthetic/11",
};

const frames: readonly FrameExecution[] = [
  {
    documentId: "document-11",
    frameId: 1,
    result: {
      body: "관람한 작품과 이동 동선을 충분히 자세하게 기록한 합성 테스트 본문입니다.",
      canonicalUrl: activeTab.url,
      frameUrl: activeTab.url,
      originalLength: 38,
      selectorConfidence: 500,
      selectorKind: "modern",
      title: activeTab.title,
    },
  },
];

beforeEach(() => {
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
  });
});

class RecordingView implements PanelView {
  actions: PanelActions | null = null;
  readonly states: PanelState[] = [];

  bind(actions: PanelActions): void {
    this.actions = actions;
  }

  clearSensitiveContent(): void {}

  async copyText(_value: string): Promise<boolean> {
    return true;
  }

  render(state: PanelState): void {
    this.states.push(state);
  }
}

class FakeGateway implements TabCaptureGateway {
  activeTabs: ActiveTab[] = [activeTab, activeTab];
  captureError: Error | null = null;
  captures = 0;
  frames: readonly FrameExecution[] = frames;
  invalidation: ((event: TabInvalidation) => void) | null = null;
  unsubscribed = false;

  async captureAllFrames(_tabId: number): Promise<readonly FrameExecution[]> {
    this.captures += 1;
    if (this.captureError !== null) {
      throw this.captureError;
    }
    return this.frames;
  }

  async getActiveTab(): Promise<ActiveTab> {
    const next = this.activeTabs.shift();
    if (next === undefined) {
      throw new BrowserCaptureError("no_active_tab");
    }
    return next;
  }

  subscribeToInvalidation(listener: (event: TabInvalidation) => void): () => void {
    this.invalidation = listener;
    return () => {
      this.unsubscribed = true;
    };
  }
}

describe("SidePanelController", () => {
  it("automatically renders an extracted preview without an API request", async () => {
    const gateway = new FakeGateway();
    const view = new RecordingView();
    const controller = new SidePanelController(gateway, view);

    await controller.captureActivePost();

    expect(view.states[0]).toEqual({ kind: "extracting" });
    expect(view.states.at(-1)?.kind).toBe("preview");
    expect(gateway.captures).toBe(1);
  });

  it("rejects unsupported tabs before script injection", async () => {
    const gateway = new FakeGateway();
    gateway.activeTabs = [{ ...activeTab, url: "https://example.com/post" }];
    const view = new RecordingView();

    await new SidePanelController(gateway, view).captureActivePost();

    expect(gateway.captures).toBe(0);
    expect(view.states.at(-1)).toEqual({
      failure: { code: "unsupported_url" },
      kind: "error",
    });
  });

  it("reports a missing active tab with a stable recovery code", async () => {
    const gateway = new FakeGateway();
    gateway.activeTabs = [];
    const view = new RecordingView();

    await new SidePanelController(gateway, view).captureActivePost();

    expect(view.states.at(-1)).toEqual({
      failure: { code: "no_active_tab" },
      kind: "error",
    });
  });

  it("rejects a result when the active page changed during capture", async () => {
    const gateway = new FakeGateway();
    gateway.activeTabs = [activeTab, { ...activeTab, url: `${activeTab.url}?changed=true` }];
    const view = new RecordingView();

    await new SidePanelController(gateway, view).captureActivePost();

    expect(view.states.at(-1)).toEqual({ failure: { code: "stale_page" }, kind: "error" });
  });

  it("maps browser permission failures without exposing raw errors", async () => {
    const gateway = new FakeGateway();
    gateway.activeTabs = [activeTab];
    gateway.captureError = new BrowserCaptureError("permission_denied");
    const view = new RecordingView();

    await new SidePanelController(gateway, view).captureActivePost();

    expect(view.states.at(-1)).toEqual({
      failure: { code: "permission_denied" },
      kind: "error",
    });
  });

  it("invalidates an in-flight operation on tab events and disposes listeners", async () => {
    const pending: { resolve?: (value: readonly FrameExecution[]) => void } = {};
    const gateway = new FakeGateway();
    gateway.captureAllFrames = vi.fn(
      () =>
        new Promise<readonly FrameExecution[]>((resolve) => {
          pending.resolve = resolve;
        }),
    );
    const view = new RecordingView();
    const controller = new SidePanelController(gateway, view);

    controller.start();
    await vi.waitFor(() => expect(gateway.invalidation).not.toBeNull());
    await vi.waitFor(() => expect(pending.resolve).toBeDefined());
    gateway.invalidation?.({ kind: "activated", tabId: 99 });
    pending.resolve?.(frames);
    await Promise.resolve();

    expect(view.states.at(-1)).toEqual({ failure: { code: "stale_page" }, kind: "error" });
    controller.dispose();
    expect(gateway.unsubscribed).toBe(true);
  });

  it("ignores a delayed capture rejection after the page becomes stale", async () => {
    const pending: { reject?: (error: unknown) => void } = {};
    const gateway = new FakeGateway();
    gateway.captureAllFrames = vi.fn(
      () =>
        new Promise<readonly FrameExecution[]>((_resolve, reject) => {
          pending.reject = reject;
        }),
    );
    const view = new RecordingView();
    const controller = new SidePanelController(gateway, view);

    controller.start();
    await vi.waitFor(() => expect(pending.reject).toBeDefined());
    gateway.invalidation?.({ kind: "updated", tabId: activeTab.id });
    pending.reject?.(new BrowserCaptureError("permission_denied"));
    await Promise.resolve();

    expect(view.states.at(-1)).toEqual({ failure: { code: "stale_page" }, kind: "error" });
  });

  it("lets the retry control start another capture", async () => {
    const gateway = new FakeGateway();
    gateway.activeTabs = [activeTab, activeTab];
    const view = new RecordingView();
    new SidePanelController(gateway, view);

    view.actions?.retry();
    await vi.waitFor(() => expect(view.states.at(-1)?.kind).toBe("preview"));
  });

  it("ignores background-tab updates without corrupting active-tab identity", async () => {
    const gateway = new FakeGateway();
    const view = new RecordingView();
    const controller = new SidePanelController(gateway, view);

    controller.start();
    await vi.waitFor(() => expect(view.states.at(-1)?.kind).toBe("preview"));
    const previewStateCount = view.states.length;

    gateway.invalidation?.({ kind: "updated", tabId: 99 });
    expect(view.states).toHaveLength(previewStateCount);
    expect(view.states.at(-1)?.kind).toBe("preview");

    gateway.invalidation?.({ kind: "updated", tabId: activeTab.id });
    expect(view.states.at(-1)).toEqual({ failure: { code: "stale_page" }, kind: "error" });
  });

  it("treats activation as stale and ignores later updates from the old tab", async () => {
    const gateway = new FakeGateway();
    const view = new RecordingView();
    const controller = new SidePanelController(gateway, view);

    controller.start();
    await vi.waitFor(() => expect(view.states.at(-1)?.kind).toBe("preview"));
    gateway.invalidation?.({ kind: "activated", tabId: 99 });
    const staleStateCount = view.states.length;

    expect(view.states.at(-1)).toEqual({ failure: { code: "stale_page" }, kind: "error" });
    gateway.invalidation?.({ kind: "updated", tabId: activeTab.id });
    expect(view.states).toHaveLength(staleStateCount);
  });

  it("does not let a delayed stale tab query overwrite a retried operation", async () => {
    const firstQuery: { resolve?: (tab: ActiveTab) => void } = {};
    const nextTab: ActiveTab = {
      id: 99,
      title: "새 합성 글",
      url: "https://blog.naver.com/synthetic/99",
    };
    const gateway = new FakeGateway();
    let queryCount = 0;
    gateway.getActiveTab = vi.fn(async () => {
      queryCount += 1;
      if (queryCount === 1) {
        return new Promise<ActiveTab>((resolve) => {
          firstQuery.resolve = resolve;
        });
      }
      return nextTab;
    });
    gateway.captureAllFrames = vi.fn(async () => frames);
    const view = new RecordingView();
    const controller = new SidePanelController(gateway, view);

    controller.start();
    await vi.waitFor(() => expect(firstQuery.resolve).toBeDefined());
    gateway.invalidation?.({ kind: "activated", tabId: nextTab.id });
    view.actions?.retry();
    await vi.waitFor(() => expect(view.states.at(-1)?.kind).toBe("preview"));

    firstQuery.resolve?.(activeTab);
    await vi.waitFor(() => expect(gateway.captureAllFrames).toHaveBeenCalledTimes(1));
    expect(gateway.captureAllFrames).toHaveBeenCalledWith(nextTab.id);

    const previewStateCount = view.states.length;
    gateway.invalidation?.({ kind: "updated", tabId: activeTab.id });
    expect(view.states).toHaveLength(previewStateCount);
    gateway.invalidation?.({ kind: "updated", tabId: nextTab.id });
    expect(view.states.at(-1)).toEqual({ failure: { code: "stale_page" }, kind: "error" });
  });
});
