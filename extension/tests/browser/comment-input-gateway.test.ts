import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

import {
  ChromeCommentInputGateway,
  type ChromeCommentInputApi,
} from "../../src/browser/comment-input-gateway";

function apiFixture(
  options: {
    activeId?: number;
    activeUrl?: string;
    frames?: Array<{ frameId: number; result: { count: number; empty: boolean } }>;
    fillResult?: "ambiguous" | "filled" | "not_found" | "occupied";
  } = {},
) {
  const executeScript = vi.fn(
    async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
      if ("allFrames" in injection.target && injection.target.allFrames) {
        return options.frames ?? [{ frameId: 3, result: { count: 1, empty: true } }];
      }
      return [{ frameId: 3, result: options.fillResult ?? "filled" }];
    },
  );
  const api = {
    scripting: { executeScript },
    tabs: {
      query: vi.fn(async () => [
        {
          id: options.activeId ?? 7,
          url: options.activeUrl ?? "https://blog.naver.com/synthetic/7",
        },
      ]),
    },
  } as unknown as ChromeCommentInputApi;
  return { api, executeScript };
}

describe("ChromeCommentInputGateway", () => {
  it("fills the sole empty target in its exact frame", async () => {
    const { api, executeScript } = apiFixture();

    await expect(new ChromeCommentInputGateway(api).fill(7, "합성 댓글")).resolves.toBe("filled");

    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript.mock.calls[1]?.[0]).toMatchObject({
      args: ["합성 댓글"],
      target: { frameIds: [3], tabId: 7 },
    });
  });

  it.each([
    [[], "not_found"],
    [[{ frameId: 0, result: { count: 1, empty: false } }], "occupied"],
    [
      [
        { frameId: 0, result: { count: 1, empty: true } },
        { frameId: 2, result: { count: 1, empty: true } },
      ],
      "ambiguous",
    ],
  ] as const)("fails closed for probe %#", async (frames, expected) => {
    const { api, executeScript } = apiFixture({ frames: [...frames] });

    await expect(new ChromeCommentInputGateway(api).fill(7, "합성 댓글")).resolves.toBe(expected);
    expect(executeScript).toHaveBeenCalledOnce();
  });

  it("rejects a changed or unsupported active page before injection", async () => {
    const wrongTab = apiFixture({ activeId: 8 });
    const wrongHost = apiFixture({ activeUrl: "https://example.com/post" });

    await expect(new ChromeCommentInputGateway(wrongTab.api).fill(7, "댓글")).resolves.toBe(
      "stale_page",
    );
    await expect(new ChromeCommentInputGateway(wrongHost.api).fill(7, "댓글")).resolves.toBe(
      "stale_page",
    );
    expect(wrongTab.executeScript).not.toHaveBeenCalled();
    expect(wrongHost.executeScript).not.toHaveBeenCalled();
  });

  it("maps script permission rejection without leaking the browser error", async () => {
    const { api, executeScript } = apiFixture();
    executeScript.mockRejectedValueOnce(new Error("private browser detail"));

    await expect(new ChromeCommentInputGateway(api).fill(7, "댓글")).resolves.toBe(
      "permission_denied",
    );
  });

  it("maps active-tab query rejection without attempting injection", async () => {
    const { api, executeScript } = apiFixture();
    vi.mocked(api.tabs.query).mockRejectedValueOnce(new Error("private tab query detail"));

    await expect(new ChromeCommentInputGateway(api).fill(7, "댓글")).resolves.toBe(
      "permission_denied",
    );
    expect(executeScript).not.toHaveBeenCalled();
  });

  it.each(["ambiguous", "not_found", "occupied"] as const)(
    "returns a changed target state from the fill phase: %s",
    async (fillResult) => {
      const { api } = apiFixture({ fillResult });

      await expect(new ChromeCommentInputGateway(api).fill(7, "댓글")).resolves.toBe(fillResult);
    },
  );
});

describe("injected comment target functions", () => {
  it("sets a textarea through its native setter and dispatches input without submit", async () => {
    const dom = new JSDOM(
      '<form><textarea class="u_cbox_text"></textarea><button type="submit">등록</button></form>',
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    const submitted = vi.fn((event: Event) => event.preventDefault());
    dom.window.document.querySelector("form")?.addEventListener("submit", submitted);
    const input = vi.fn();
    dom.window.document.querySelector("textarea")?.addEventListener("input", input);
    const { api } = apiFixture();
    const execute = api.scripting.executeScript as ReturnType<typeof vi.fn>;
    execute.mockImplementation(
      async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
        const previous = {
          HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
          InputEvent: globalThis.InputEvent,
          document: globalThis.document,
          getComputedStyle: globalThis.getComputedStyle,
        };
        Object.assign(globalThis, {
          HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
          InputEvent: dom.window.InputEvent,
          document: dom.window.document,
          getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        });
        try {
          if (injection.func === undefined) throw new Error("Synthetic function is missing");
          const args = "args" in injection && Array.isArray(injection.args) ? injection.args : [];
          const result = (injection.func as (...values: unknown[]) => unknown)(...args);
          return [{ frameId: 0, result }];
        } finally {
          Object.assign(globalThis, previous);
        }
      },
    );

    await expect(new ChromeCommentInputGateway(api).fill(7, "합성 댓글")).resolves.toBe("filled");
    expect((dom.window.document.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "합성 댓글",
    );
    expect(input).toHaveBeenCalledOnce();
    expect(submitted).not.toHaveBeenCalled();
  });
});
