import { afterEach, describe, expect, it, vi } from "vitest";

import { ChromeDiscoveryPageGateway } from "../../src/browser/discovery-page-gateway";

describe("ChromeDiscoveryPageGateway", () => {
  it("returns the active page discovery capture and fails closed on denied injection", async () => {
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([{ result: { blogs: [], posts: [] } }])
      .mockResolvedValueOnce([{}])
      .mockRejectedValueOnce(new Error("denied"));
    vi.stubGlobal("chrome", { scripting: { executeScript } });
    const gateway = new ChromeDiscoveryPageGateway({
      getActiveTab: vi.fn().mockResolvedValue({ id: 7 }),
      captureAllFrames: vi.fn(),
      subscribeToInvalidation: vi.fn(),
    } as never);

    await expect(gateway.capture()).resolves.toEqual({ blogs: [], posts: [] });
    await expect(gateway.capture()).rejects.toMatchObject({ code: "permission_denied" });
    await expect(gateway.capture()).rejects.toMatchObject({ code: "permission_denied" });
  });
});

afterEach(() => vi.unstubAllGlobals());
