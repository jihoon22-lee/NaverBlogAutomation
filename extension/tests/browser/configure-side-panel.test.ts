import { describe, expect, it, vi } from "vitest";

import { configureSidePanel, type SidePanelSetupApi } from "../../src/browser/configure-side-panel";

type ActionListener = Parameters<typeof chrome.action.onClicked.addListener>[0];

function setup(options: { behavior?: "pending" | "reject" | "resolve" } = {}) {
  let listener: ActionListener | undefined;
  const addListener = vi.fn((registered: ActionListener) => {
    listener = registered;
  });
  const open = vi.fn<SidePanelSetupApi["sidePanel"]["open"]>().mockResolvedValue(undefined);
  const behavior = options.behavior ?? "resolve";
  const setPanelBehavior = vi.fn<SidePanelSetupApi["sidePanel"]["setPanelBehavior"]>();
  if (behavior === "pending") {
    setPanelBehavior.mockReturnValue(new Promise(() => undefined));
  } else if (behavior === "reject") {
    setPanelBehavior.mockRejectedValue(new Error("synthetic behavior failure"));
  } else {
    setPanelBehavior.mockResolvedValue(undefined);
  }
  const api: SidePanelSetupApi = {
    action: { onClicked: { addListener } },
    sidePanel: { open, setPanelBehavior },
  };
  return {
    addListener,
    api,
    get listener(): ActionListener {
      if (listener === undefined) {
        throw new Error("Action listener was not registered");
      }
      return listener;
    },
    open,
    setPanelBehavior,
  };
}

function clickedTab(id: number | undefined): chrome.tabs.Tab {
  return { id, index: 0, pinned: false, windowId: 1 } as chrome.tabs.Tab;
}

describe("Side Panel setup", () => {
  it.each(["pending", "reject"] as const)(
    "registers the listener before a %s persisted-behavior migration settles",
    async (behavior) => {
      const fixture = setup({ behavior });

      configureSidePanel(fixture.api);

      expect(fixture.addListener).toHaveBeenCalledOnce();
      expect(fixture.setPanelBehavior).toHaveBeenCalledWith({
        openPanelOnActionClick: false,
      });
      expect(fixture.addListener.mock.invocationCallOrder[0]).toBeLessThan(
        fixture.setPanelBehavior.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      await Promise.resolve();
    },
  );

  it("opens the panel immediately for the exact clicked tab", () => {
    const fixture = setup();
    configureSidePanel(fixture.api);

    fixture.listener(clickedTab(42));

    expect(fixture.open).toHaveBeenCalledOnce();
    expect(fixture.open).toHaveBeenCalledWith({ tabId: 42 });
  });

  it.each([undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "fails closed for invalid tab ID %s",
    (tabId) => {
      const fixture = setup();
      configureSidePanel(fixture.api);

      fixture.listener(clickedTab(tabId));

      expect(fixture.open).not.toHaveBeenCalled();
    },
  );

  it("contains a rejected open and still handles the next click", async () => {
    const fixture = setup();
    fixture.open
      .mockRejectedValueOnce(new Error("synthetic open failure"))
      .mockResolvedValueOnce(undefined);
    configureSidePanel(fixture.api);

    fixture.listener(clickedTab(7));
    await Promise.resolve();
    fixture.listener(clickedTab(8));

    expect(fixture.open).toHaveBeenNthCalledWith(1, { tabId: 7 });
    expect(fixture.open).toHaveBeenNthCalledWith(2, { tabId: 8 });
  });

  it("repeats open without guessing toggle state", () => {
    const fixture = setup();
    configureSidePanel(fixture.api);

    fixture.listener(clickedTab(9));
    fixture.listener(clickedTab(9));

    expect(fixture.open).toHaveBeenCalledTimes(2);
    expect(fixture.open).toHaveBeenNthCalledWith(1, { tabId: 9 });
    expect(fixture.open).toHaveBeenNthCalledWith(2, { tabId: 9 });
  });
});
