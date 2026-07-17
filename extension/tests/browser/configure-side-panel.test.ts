import { describe, expect, it, vi } from "vitest";

import { configureSidePanel } from "../../src/browser/configure-side-panel";

describe("Side Panel setup", () => {
  it("opens the panel from the toolbar action", async () => {
    const setPanelBehavior = vi.fn().mockResolvedValue(undefined);

    await configureSidePanel({ sidePanel: { setPanelBehavior } });

    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
  });
});
