import { beforeEach, describe, expect, it } from "vitest";

import { APP_ROOT_ID, createWorkspace, mount } from "../../src/app/main";

const EXTRACTION = {
  sourceUrl: "https://blog.naver.com/example/1",
  title: "합성 제목",
  selectorKind: "modern" as const,
  originalLength: 120,
  transmittedLength: 120,
  truncated: false,
  preview: "합성 본문",
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("mount", () => {
  it("returns null when the workspace root is missing", () => {
    expect(mount()).toBeNull();
  });

  it("renders the Today view immediately and starts a load", () => {
    document.body.innerHTML = `<main id="${APP_ROOT_ID}"></main>`;

    const workspace = mount();

    expect(workspace).not.toBeNull();
    expect(document.getElementById("workspace-status")).not.toBeNull();
    expect(["idle", "loading"]).toContain(workspace?.today.state.phase);
  });

  it("uses the documented workspace root id", () => {
    expect(APP_ROOT_ID).toBe("workspace");
  });
});

describe("createWorkspace", () => {
  it("switches to the comment view for an extraction", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const workspace = createWorkspace(root);

    workspace.openComment(EXTRACTION, "11111111-1111-4111-8111-111111111111");

    expect(document.getElementById("comment-status")).not.toBeNull();
    expect(document.getElementById("preview-title")?.textContent).toBe("합성 제목");
    expect(workspace.comment.state.phase).toBe("preview");
  });

  it("returns to the Today view from the comment view", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const workspace = createWorkspace(root);
    workspace.openComment(EXTRACTION, "11111111-1111-4111-8111-111111111111");

    (document.getElementById("comment-back-button") as HTMLButtonElement).click();

    expect(document.getElementById("workspace-status")).not.toBeNull();
    expect(document.getElementById("comment-status")).toBeNull();
  });
});

describe("navigation", () => {
  function shell(): Element {
    document.body.innerHTML = `
      <nav id="workspace-nav">
        <button type="button" data-section="today" aria-current="page"></button>
        <button type="button" data-section="writing"></button>
      </nav>
      <main id="${APP_ROOT_ID}"></main>
    `;
    const root = document.getElementById(APP_ROOT_ID);
    if (root === null) throw new Error("missing root");
    return root;
  }

  function tab(section: string): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(`[data-section="${section}"]`);
    if (button === null) throw new Error(`missing tab: ${section}`);
    return button;
  }

  it("reaches the writing workspace from the nav", () => {
    const root = shell();
    createWorkspace(root);

    tab("writing").click();

    expect(root.querySelector(".seed-panel")).not.toBeNull();
    expect(tab("writing").getAttribute("aria-current")).toBe("page");
  });

  it("returns to today from the nav", () => {
    const root = shell();
    const workspace = createWorkspace(root);
    workspace.showWriting();

    tab("today").click();

    expect(tab("today").getAttribute("aria-current")).toBe("page");
    expect(tab("writing").hasAttribute("aria-current")).toBe(false);
  });

  it("moves focus into the workspace on a section change", () => {
    const root = shell();
    const workspace = createWorkspace(root);

    workspace.showWriting();

    expect(root.contains(document.activeElement)).toBe(true);
  });

  it("keeps the today tab current while the comment view is open", () => {
    const root = shell();
    const workspace = createWorkspace(root);
    workspace.showWriting();

    workspace.openComment(EXTRACTION, "11111111-1111-4111-8111-111111111111");

    expect(tab("today").getAttribute("aria-current")).toBe("page");
  });

  it("works without a nav in the shell", () => {
    document.body.innerHTML = `<main id="${APP_ROOT_ID}"></main>`;
    const root = document.getElementById(APP_ROOT_ID);
    if (root === null) throw new Error("missing root");

    const workspace = createWorkspace(root);
    workspace.showWriting();

    expect(root.querySelector(".seed-panel")).not.toBeNull();
  });
});
