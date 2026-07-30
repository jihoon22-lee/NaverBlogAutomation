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

    workspace.openComment(EXTRACTION);

    expect(document.getElementById("comment-status")).not.toBeNull();
    expect(document.getElementById("preview-title")?.textContent).toBe("합성 제목");
    expect(workspace.comment.state.phase).toBe("preview");
  });

  it("returns to the Today view from the comment view", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const workspace = createWorkspace(root);
    workspace.openComment(EXTRACTION);

    (document.getElementById("comment-back-button") as HTMLButtonElement).click();

    expect(document.getElementById("workspace-status")).not.toBeNull();
    expect(document.getElementById("comment-status")).toBeNull();
  });
});
