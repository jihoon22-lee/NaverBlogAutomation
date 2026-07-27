import { readFile } from "node:fs/promises";

import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SidePanelWorkspaceController } from "../../src/sidepanel/workspace-controller";

const htmlPath = new URL("../../public/sidepanel.html", import.meta.url);
let controller: SidePanelWorkspaceController;
let document: Document;
let domWindow: Window & typeof globalThis;

beforeEach(async () => {
  const dom = new JSDOM(await readFile(htmlPath, "utf8"), {
    pretendToBeVisual: true,
    url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sidepanel.html",
  });
  document = dom.window.document;
  domWindow = dom.window as unknown as Window & typeof globalThis;
  controller = new SidePanelWorkspaceController(document);
  controller.start();
});

describe("SidePanelWorkspaceController", () => {
  it("opens only Today first and relocates long settings away from the queue", () => {
    expect(controller.active).toBe("today");
    expect((document.querySelector("#workspace-today") as HTMLElement).hidden).toBe(false);
    expect((document.querySelector("#workspace-comment") as HTMLElement).hidden).toBe(true);
    expect(document.querySelector("#discovery-panel")?.parentElement?.id).toBe("workspace-today");
    expect(document.querySelector("#discovery-settings")?.parentElement?.id).toBe(
      "workspace-settings",
    );
    expect(document.querySelector("#engagement-consent-card")?.parentElement?.id).toBe(
      "workspace-settings",
    );
    expect(document.querySelector("#workspace-today-button")?.getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("switches workspaces with click, arrow, Home, and End keyboard navigation", async () => {
    const changed = vi.fn();
    domWindow.addEventListener("workspace-changed", changed);
    const comment = document.querySelector<HTMLButtonElement>("#workspace-comment-button");
    if (comment === null) throw new Error("Synthetic Comment workspace button missing");
    comment.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(controller.active).toBe("comment");
    expect(document.activeElement?.id).toBe("workspace-comment-title");
    expect(comment.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector("#workspace-today-button")?.hasAttribute("aria-current")).toBe(
      false,
    );

    comment.dispatchEvent(
      new domWindow.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
    );
    expect(controller.active).toBe("history");
    expect(document.activeElement?.id).toBe("workspace-history-button");

    document
      .querySelector("#workspace-history-button")
      ?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { bubbles: true, key: "End" }));
    expect(controller.active).toBe("settings");
    document
      .querySelector("#workspace-settings-button")
      ?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
    expect(controller.active).toBe("today");
    document
      .querySelector("#workspace-today-button")
      ?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    expect(controller.active).toBe("settings");
    document
      .querySelector("#workspace-navigation")
      ?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    document.querySelector<HTMLButtonElement>("#workspace-navigation")?.click();
    expect(controller.active).toBe("settings");
    expect(changed).toHaveBeenCalled();
  });

  it("returns to Today and resumes Comment with the completion shortcuts", () => {
    controller.activate("comment", false);
    document.querySelector<HTMLButtonElement>("#back-today-button")?.click();
    expect(controller.active).toBe("today");

    document.querySelector<HTMLButtonElement>("#today-continue-button")?.click();
    expect(controller.active).toBe("comment");
  });
});
