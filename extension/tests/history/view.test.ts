import { readFile } from "node:fs/promises";

import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DomHistoryView } from "../../src/history/view";
import type { HistoryActions } from "../../src/history/state";

const htmlPath = new URL("../../public/sidepanel.html", import.meta.url);
let document: Document;
let view: DomHistoryView;

function actions(): HistoryActions {
  return {
    clearPersonalization: vi.fn(),
    copy: vi.fn(),
    delete: vi.fn(),
    refresh: vi.fn(),
    togglePersonalization: vi.fn(),
  };
}

beforeEach(async () => {
  const html = await readFile(htmlPath, "utf8");
  const dom = new JSDOM(html, { url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/" });
  document = dom.window.document;
  view = new DomHistoryView(document);
});

describe("DomHistoryView", () => {
  it("renders service diagnostics and usable recent history", () => {
    view.render({
      items: [
        {
          comment: "이전에 승인한 댓글",
          createdAt: "2026-07-17T00:00:00Z",
          id: "00000000-0000-4000-8000-000000000010",
          reviewStatus: "approved",
          sourceUrl: "https://blog.naver.com/synthetic/10",
          title: "합성 전시 후기",
          updatedAt: "2026-07-17T00:01:00Z",
          personalizationEligible: true,
        },
      ],
      kind: "ready",
      service: {
        apiVersion: "1.0.0",
        appEnvironment: "production",
        database: "ready",
        generatorMode: "openai",
        generatorModel: "gpt-test",
        status: "ready",
      },
    });

    expect(document.querySelector("#service-status")?.textContent).toContain("gpt-test");
    expect(document.querySelector("#history-count")?.textContent).toBe("1");
    expect(document.querySelector(".history-item")?.textContent).toContain("이전에 승인한 댓글");
    expect(document.querySelector<HTMLAnchorElement>(".history-item a")?.target).toBe("_blank");
  });

  it("binds refresh, copy, personalization, and confirmed delete actions", () => {
    const bound = actions();
    view.bind(bound);
    view.render({
      items: [
        {
          comment: "복사할 댓글",
          createdAt: "2026-07-17T00:00:00Z",
          id: "history-id",
          reviewStatus: "completed",
          sourceUrl: "https://blog.naver.com/synthetic/10",
          title: "합성 후기",
          updatedAt: null,
          personalizationEligible: true,
        },
      ],
      kind: "ready",
      service: {
        apiVersion: "1.0.0",
        appEnvironment: "test",
        database: "ready",
        generatorMode: "fake",
        generatorModel: "deterministic-fake",
        status: "ready",
      },
    });
    vi.spyOn(document.defaultView as Window, "confirm").mockReturnValue(true);

    document.querySelector<HTMLButtonElement>("#history-refresh-button")?.click();
    document.querySelector<HTMLButtonElement>('[data-history-action="copy"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-history-action="personalization"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-history-action="delete"]')?.click();
    document.querySelector<HTMLButtonElement>("#personalization-clear-button")?.click();

    expect(bound.refresh).toHaveBeenCalledOnce();
    expect(bound.copy).toHaveBeenCalledWith("history-id");
    expect(bound.togglePersonalization).toHaveBeenCalledWith("history-id");
    expect(bound.delete).toHaveBeenCalledWith("history-id");
    expect(bound.clearPersonalization).toHaveBeenCalledOnce();
  });

  it("renders loading and disconnected states without stale history", () => {
    view.render({ kind: "loading" });
    expect(document.querySelector("#service-status")?.textContent).toContain("확인 중");
    view.render({ kind: "error", message: "연결 실패" });
    expect(document.querySelector("#history-empty")?.textContent).toBe("연결 실패");
    expect(document.querySelector("#service-status")?.getAttribute("data-status")).toBe("error");
  });

  it("keeps a selectable fallback visible when clipboard access is unavailable", async () => {
    await expect(view.copyText("직접 복사할 댓글")).resolves.toBe(false);

    const fallback = document.querySelector<HTMLTextAreaElement>("#history-copy-fallback");
    expect(fallback?.hidden).toBe(false);
    expect(fallback?.value).toBe("직접 복사할 댓글");
    expect(document.activeElement).toBe(fallback);
  });
});
