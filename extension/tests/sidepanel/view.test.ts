import { readFile } from "node:fs/promises";

import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DomPanelView } from "../../src/sidepanel/view";

const htmlPath = new URL("../../public/sidepanel.html", import.meta.url);
let document: Document;
let view: DomPanelView;

beforeEach(async () => {
  const html = await readFile(htmlPath, "utf8");
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sidepanel.html",
  });
  document = dom.window.document;
  view = new DomPanelView(document);
});

describe("DomPanelView", () => {
  it("announces progress without exposing preview controls", () => {
    view.render({ kind: "extracting" });

    expect(document.querySelector("#app")?.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector("#status")?.textContent).toContain("확인하고");
    expect((document.querySelector("#preview-panel") as HTMLElement).hidden).toBe(true);
  });

  it("renders a bounded preview and keeps generation disabled", async () => {
    view.render({
      kind: "preview",
      preview: {
        body: "구체적인 전시 감상과 관람 동선을 정리한 합성 본문입니다. ".repeat(40),
        documentId: "document-1",
        frameId: 1,
        originalLength: 120_000,
        sourceUrl: "https://blog.naver.com/synthetic/1",
        tabId: 1,
        title: "합성 전시 후기",
        transmittedLength: 100_000,
        truncated: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((document.querySelector("#preview-panel") as HTMLElement).hidden).toBe(false);
    expect(document.querySelector("#post-title")?.textContent).toBe("합성 전시 후기");
    expect(document.querySelector("#character-count")?.textContent).toContain("100,000");
    expect(document.querySelector("#truncation-notice")?.textContent).toContain("API 제한");
    expect(document.querySelector("#body-preview")?.textContent?.endsWith("…")).toBe(true);
    expect((document.querySelector("#generate-button") as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement?.id).toBe("preview-title");
  });

  it("hides the truncation notice for content within the API limit", () => {
    view.render({
      kind: "preview",
      preview: {
        body: "충분한 길이의 합성 본문 내용입니다.",
        frameId: 0,
        originalLength: 20,
        sourceUrl: "https://blog.naver.com/synthetic/2",
        tabId: 2,
        title: "합성 제목",
        transmittedLength: 20,
        truncated: false,
      },
    });

    expect((document.querySelector("#truncation-notice") as HTMLElement).hidden).toBe(true);
    expect(document.querySelector("#body-preview")?.textContent).toBe(
      "충분한 길이의 합성 본문 내용입니다.",
    );
  });

  it("renders actionable errors and invokes retry from a keyboard-operable button", async () => {
    const retry = vi.fn();
    view.onRetry(retry);

    view.render({ failure: { code: "permission_denied" }, kind: "error" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    (document.querySelector("#retry-button") as HTMLButtonElement).click();

    expect((document.querySelector("#error-panel") as HTMLElement).hidden).toBe(false);
    expect(document.querySelector("#error-message")?.textContent).toContain("권한");
    expect(document.activeElement?.id).toBe("error-title");
    expect(retry).toHaveBeenCalledOnce();
  });

  it("fails fast when required static markup is missing", () => {
    expect(() => new DomPanelView(document.implementation.createHTMLDocument())).toThrow(
      "Missing Side Panel element",
    );
  });
});
