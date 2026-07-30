import { beforeEach, describe, expect, it } from "vitest";

import { APP_ROOT_ID, mount } from "../../src/app/main";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("mount", () => {
  it("returns null when the workspace root is missing", () => {
    expect(mount()).toBeNull();
  });

  it("renders the shell immediately and starts a load", () => {
    document.body.innerHTML = `<main id="${APP_ROOT_ID}"></main>`;

    const controller = mount();

    expect(controller).not.toBeNull();
    expect(document.getElementById("workspace-status")).not.toBeNull();
    expect(["idle", "loading"]).toContain(controller?.state.phase);
  });

  it("uses the documented workspace root id", () => {
    expect(APP_ROOT_ID).toBe("workspace");
  });
});
