import { beforeEach, describe, expect, it } from "vitest";

import { APP_ROOT_ID, mount, renderShell } from "../../src/app/main";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("renderShell", () => {
  it("renders one accessible status element", () => {
    const root = document.createElement("main");
    document.body.append(root);

    const status = renderShell(root);

    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toContain("로컬 서비스");
    expect(root.children).toHaveLength(1);
  });

  it("replaces previous content instead of appending", () => {
    const root = document.createElement("main");
    root.textContent = "이전 내용";
    document.body.append(root);

    renderShell(root);
    renderShell(root);

    expect(root.children).toHaveLength(1);
    expect(root.textContent).not.toContain("이전 내용");
  });
});

describe("mount", () => {
  it("mounts into the workspace root", () => {
    document.body.innerHTML = `<main id="${APP_ROOT_ID}"></main>`;

    const status = mount();

    expect(status).not.toBeNull();
    expect(document.getElementById("workspace-status")).toBe(status);
  });

  it("returns null when the workspace root is missing", () => {
    expect(mount()).toBeNull();
  });
});
