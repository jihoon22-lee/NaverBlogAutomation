import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("background discovery notification", () => {
  it("polls the local queue, updates a badge, and notifies only when it grows", async () => {
    let alarmListener: ((alarm: { name: string }) => void) | undefined;
    const get = vi
      .fn()
      .mockResolvedValueOnce({ "discovery-queued-neighbor-count": 1 })
      .mockResolvedValue({ "discovery-queued-neighbor-count": 2 });
    const chromeMock = {
      action: {
        onClicked: { addListener: vi.fn() },
        setBadgeText: vi.fn().mockResolvedValue(undefined),
      },
      sidePanel: {
        open: vi.fn().mockResolvedValue(undefined),
        setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      },
      alarms: {
        create: vi.fn(),
        onAlarm: {
          addListener: vi.fn((listener) => {
            alarmListener = listener;
          }),
        },
      },
      storage: { local: { get, set: vi.fn().mockResolvedValue(undefined) } },
      notifications: { create: vi.fn().mockResolvedValue(undefined) },
      runtime: { getURL: vi.fn((value) => `chrome-extension://test/${value}`) },
    };
    vi.stubGlobal("chrome", chromeMock);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }), { status: 200 }),
        ),
    );

    // @ts-expect-error Vitest loads the service-worker entrypoint at runtime.
    await import("../../src/background");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "2" });
    expect(chromeMock.notifications.create).toHaveBeenCalledOnce();
    alarmListener?.({ name: "other" });
    alarmListener?.({ name: "discovery-queue-check" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chromeMock.alarms.create).toHaveBeenCalledWith("discovery-queue-check", {
      periodInMinutes: 60,
    });
    expect(chromeMock.notifications.create).toHaveBeenCalledOnce();
  });
});
