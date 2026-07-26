import { describe, expect, it, vi } from "vitest";

import { ChromeDiscoveryTabNavigator } from "../../src/browser/discovery-tab-navigator";

function event() {
  return { addListener: vi.fn(), removeListener: vi.fn() };
}

describe("ChromeDiscoveryTabNavigator", () => {
  it("opens a candidate in the current tab and waits for the completed document", async () => {
    const onUpdated = event();
    const create = vi.fn();
    const update = vi.fn().mockResolvedValue({ id: 7, status: "loading" });
    const api = {
      tabs: {
        create,
        onUpdated,
        update,
      },
    } as never;
    const navigator = new ChromeDiscoveryTabNavigator(api);
    const pending = navigator.open("https://blog.naver.com/friend/1", "current");
    await Promise.resolve();
    const listener = onUpdated.addListener.mock.calls[0]?.[0];
    listener?.(7, { status: "complete" });

    await expect(pending).resolves.toBe(7);
    expect(update).toHaveBeenCalledWith({ url: "https://blog.naver.com/friend/1" });
  });

  it("opens a candidate in a new active tab without waiting when Chrome already completed it", async () => {
    const create = vi.fn().mockResolvedValue({ id: 8, status: "complete" });
    const api = {
      tabs: {
        create,
        onUpdated: event(),
        update: vi.fn(),
      },
    } as never;

    await expect(
      new ChromeDiscoveryTabNavigator(api).open("https://blog.naver.com/friend/2", "new"),
    ).resolves.toBe(8);
    expect(create).toHaveBeenCalledWith({ active: true, url: "https://blog.naver.com/friend/2" });
  });

  it("keeps a queued post pending when Chrome cannot create its tab", async () => {
    const api = {
      tabs: {
        create: vi.fn().mockResolvedValue({}),
        onUpdated: event(),
        update: vi.fn(),
      },
    } as never;

    await expect(
      new ChromeDiscoveryTabNavigator(api).open("https://blog.naver.com/friend/3", "new"),
    ).rejects.toThrow("탐색할 탭을 열지 못했습니다.");
  });

  it("reports a bounded loading failure when another tab finishes instead", async () => {
    vi.useFakeTimers();
    const onUpdated = event();
    const api = {
      tabs: {
        create: vi.fn(),
        onUpdated,
        update: vi.fn().mockResolvedValue({ id: 9, status: "loading" }),
      },
    } as never;
    const pending = new ChromeDiscoveryTabNavigator(api).open(
      "https://blog.naver.com/friend/4",
      "current",
    );
    await Promise.resolve();
    const listener = onUpdated.addListener.mock.calls[0]?.[0];
    listener?.(8, { status: "complete" });
    const rejected = expect(pending).rejects.toThrow("시간이 초과");
    await vi.advanceTimersByTimeAsync(15_000);

    await rejected;
    vi.useRealTimers();
  });
});
