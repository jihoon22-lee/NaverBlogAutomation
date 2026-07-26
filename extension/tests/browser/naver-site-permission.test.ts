import { describe, expect, it, vi } from "vitest";

import { NaverSitePermission } from "../../src/browser/naver-site-permission";

describe("NaverSitePermission", () => {
  it("requests only the two supported Naver Blog origins", async () => {
    const contains = vi.fn(async () => false);
    const request = vi.fn(async () => true);
    const permission = new NaverSitePermission({ contains, request } as never);

    await expect(permission.granted()).resolves.toBe(false);
    await expect(permission.request()).resolves.toBe(true);
    expect(contains).toHaveBeenCalledWith({
      origins: ["https://blog.naver.com/*", "https://m.blog.naver.com/*"],
    });
    expect(request).toHaveBeenCalledWith({
      origins: ["https://blog.naver.com/*", "https://m.blog.naver.com/*"],
    });
  });
});
