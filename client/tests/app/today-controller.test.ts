import { beforeEach, describe, expect, it, vi } from "vitest";

import { TodayController } from "../../src/app/controllers/today";

beforeEach(() => {
  document.body.innerHTML = '<main id="workspace"></main>';
});

describe("TodayController home navigation", () => {
  it("forwards the home writing action to its navigation callback", () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onWritingRequested = vi.fn();
    const controller = new TodayController(root, {
      api: {} as never,
      onWritingRequested,
    });

    controller.setView("home");
    controller.render();
    const action = document.getElementById("home-start-writing") as HTMLButtonElement | null;
    expect(action).not.toBeNull();
    action?.click();

    expect(onWritingRequested).toHaveBeenCalledOnce();
  });
});
