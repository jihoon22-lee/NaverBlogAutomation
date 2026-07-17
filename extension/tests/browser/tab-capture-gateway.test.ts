import { describe, expect, it, vi } from "vitest";

import {
  BrowserCaptureError,
  type ChromeCaptureApi,
  ChromeTabCaptureGateway,
} from "../../src/browser/tab-capture-gateway";

function event() {
  return {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
}

function chromeApi(): {
  api: ChromeCaptureApi;
  executeScript: ReturnType<typeof vi.fn>;
  onActivated: ReturnType<typeof event>;
  onUpdated: ReturnType<typeof event>;
  query: ReturnType<typeof vi.fn>;
} {
  const executeScript = vi.fn();
  const query = vi.fn();
  const onActivated = event();
  const onUpdated = event();
  return {
    api: {
      scripting: { executeScript },
      tabs: { onActivated, onUpdated, query },
    } as unknown as ChromeCaptureApi,
    executeScript,
    onActivated,
    onUpdated,
    query,
  };
}

describe("ChromeTabCaptureGateway", () => {
  it("queries the focused active tab", async () => {
    const fixture = chromeApi();
    fixture.query.mockResolvedValue([
      { id: 9, title: "합성 글", url: "https://blog.naver.com/synthetic/9" },
    ]);

    const tab = await new ChromeTabCaptureGateway(fixture.api).getActiveTab();

    expect(tab).toEqual({
      id: 9,
      title: "합성 글",
      url: "https://blog.naver.com/synthetic/9",
    });
    expect(fixture.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
  });

  it("rejects a missing or inaccessible active tab", async () => {
    const fixture = chromeApi();
    fixture.query.mockResolvedValue([{}]);

    await expect(new ChromeTabCaptureGateway(fixture.api).getActiveTab()).rejects.toEqual(
      new BrowserCaptureError("no_active_tab"),
    );
  });

  it("injects the self-contained extractor into all frames", async () => {
    const fixture = chromeApi();
    fixture.executeScript.mockResolvedValue([
      { documentId: "doc-1", frameId: 0, result: null },
      {
        frameId: 3,
        result: {
          body: "충분히 긴 합성 본문입니다. 구체적인 경험과 감상을 함께 담았습니다.",
          canonicalUrl: null,
          frameUrl: "https://blog.naver.com/synthetic/3",
          originalLength: 35,
          selectorConfidence: 500,
          selectorKind: "modern",
          title: "합성 제목",
        },
      },
    ]);

    const result = await new ChromeTabCaptureGateway(fixture.api).captureAllFrames(9);

    expect(fixture.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { allFrames: true, tabId: 9 },
        world: "ISOLATED",
      }),
    );
    expect(result).toEqual([
      { documentId: "doc-1", frameId: 0, result: null },
      expect.objectContaining({ frameId: 3 }),
    ]);
  });

  it("maps script injection errors to a stable permission failure", async () => {
    const fixture = chromeApi();
    fixture.executeScript.mockRejectedValue(new Error("raw chrome error"));

    await expect(new ChromeTabCaptureGateway(fixture.api).captureAllFrames(9)).rejects.toEqual(
      new BrowserCaptureError("permission_denied"),
    );
  });

  it("subscribes to activation and meaningful navigation changes", () => {
    const fixture = chromeApi();
    const listener = vi.fn();
    const unsubscribe = new ChromeTabCaptureGateway(fixture.api).subscribeToInvalidation(listener);
    const activation = fixture.onActivated.addListener.mock.calls[0]?.[0];
    const updated = fixture.onUpdated.addListener.mock.calls[0]?.[0];

    activation?.({ tabId: 4, windowId: 1 });
    updated?.(4, { status: "complete" }, {});
    updated?.(4, { status: "loading" }, {});
    updated?.(4, { url: "https://blog.naver.com/new" }, {});

    expect(listener.mock.calls).toEqual([
      [{ kind: "activated", tabId: 4 }],
      [{ kind: "updated", tabId: 4 }],
      [{ kind: "updated", tabId: 4 }],
    ]);
    unsubscribe();
    expect(fixture.onActivated.removeListener).toHaveBeenCalledWith(activation);
    expect(fixture.onUpdated.removeListener).toHaveBeenCalledWith(updated);
  });
});
