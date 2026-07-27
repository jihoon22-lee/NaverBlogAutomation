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
    openers?: Array<{ frameId: number; result: { count: number; empty: boolean } }>;
    fillResult?: "ambiguous" | "filled" | "not_found" | "occupied" | "open_failed";
  } = {},
) {
  const executeScript = vi.fn(
    async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
      if ("allFrames" in injection.target && injection.target.allFrames) {
        if (injection.func?.name === "probeCommentOpener") {
          return options.openers ?? [];
        }
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

  it("returns not_found when neither an input nor a trusted opener exists", async () => {
    const { api, executeScript } = apiFixture({ frames: [], openers: [] });

    await expect(new ChromeCommentInputGateway(api).fill(7, "합성 댓글")).resolves.toBe(
      "not_found",
    );
    expect(executeScript).toHaveBeenCalledTimes(2);
  });

  it("opens the sole trusted comment opener before filling its exact frame", async () => {
    const { api, executeScript } = apiFixture({
      frames: [],
      openers: [{ frameId: 4, result: { count: 1, empty: false } }],
    });

    await expect(new ChromeCommentInputGateway(api).fill(7, "합성 댓글")).resolves.toBe("filled");
    expect(executeScript).toHaveBeenCalledTimes(3);
    expect(executeScript.mock.calls[2]?.[0]).toMatchObject({
      args: ["합성 댓글"],
      target: { frameIds: [4], tabId: 7 },
    });
  });

  it("rejects multiple trusted comment openers without clicking either one", async () => {
    const { api, executeScript } = apiFixture({
      frames: [],
      openers: [
        { frameId: 0, result: { count: 1, empty: false } },
        { frameId: 1, result: { count: 1, empty: false } },
      ],
    });

    await expect(new ChromeCommentInputGateway(api).fill(7, "합성 댓글")).resolves.toBe(
      "ambiguous",
    );
    expect(executeScript).toHaveBeenCalledTimes(2);
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

  it.each(["ambiguous", "not_found", "occupied", "open_failed"] as const)(
    "returns a changed target state from the fill phase: %s",
    async (fillResult) => {
      const { api } = apiFixture({ fillResult });

      await expect(new ChromeCommentInputGateway(api).fill(7, "댓글")).resolves.toBe(fillResult);
    },
  );
});

describe("injected comment target functions", () => {
  it("sets the current Naver contenteditable input and dispatches input without submit", async () => {
    const dom = new JSDOM(
      '<form><div class="u_cbox_text u_cbox_text_mention" contenteditable="true"></div><button type="submit">등록</button></form>',
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    const submitted = vi.fn((event: Event) => event.preventDefault());
    dom.window.document.querySelector("form")?.addEventListener("submit", submitted);
    const input = vi.fn();
    dom.window.document.querySelector("div")?.addEventListener("input", input);
    const { api } = apiFixture();
    const execute = api.scripting.executeScript as ReturnType<typeof vi.fn>;
    execute.mockImplementation(
      async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
        const previous = {
          HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
          InputEvent: globalThis.InputEvent,
          document: globalThis.document,
          getComputedStyle: globalThis.getComputedStyle,
          window: globalThis.window,
        };
        Object.assign(globalThis, {
          HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
          InputEvent: dom.window.InputEvent,
          document: dom.window.document,
          getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
          window: dom.window,
        });
        try {
          if (injection.func === undefined) throw new Error("Synthetic function is missing");
          const args = "args" in injection && Array.isArray(injection.args) ? injection.args : [];
          const result = await (injection.func as (...values: unknown[]) => unknown)(...args);
          return [{ frameId: 0, result }];
        } finally {
          Object.assign(globalThis, previous);
        }
      },
    );

    await expect(new ChromeCommentInputGateway(api).fill(7, "합성 댓글")).resolves.toBe("filled");
    expect(dom.window.document.querySelector("div")?.textContent).toBe("합성 댓글");
    expect(input).toHaveBeenCalledOnce();
    expect(submitted).not.toHaveBeenCalled();
  });

  it("clicks the trusted opener and fills the rendered input without submitting", async () => {
    const dom = new JSDOM(
      '<form><a class="btn_write_comment _naverCommentWriteBtn">댓글쓰기</a><button type="submit">등록</button></form>',
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    const form = dom.window.document.querySelector("form");
    const opener = dom.window.document.querySelector("a");
    const submitted = vi.fn((event: Event) => event.preventDefault());
    form?.addEventListener("submit", submitted);
    opener?.addEventListener("click", () => {
      const input = dom.window.document.createElement("div");
      input.className = "u_cbox_text u_cbox_text_mention";
      input.setAttribute("contenteditable", "true");
      form?.prepend(input);
    });
    const { api } = apiFixture();
    const execute = api.scripting.executeScript as ReturnType<typeof vi.fn>;
    execute.mockImplementation(
      async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
        const previous = {
          HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
          InputEvent: globalThis.InputEvent,
          document: globalThis.document,
          getComputedStyle: globalThis.getComputedStyle,
          window: globalThis.window,
        };
        Object.assign(globalThis, {
          HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
          InputEvent: dom.window.InputEvent,
          document: dom.window.document,
          getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
          window: dom.window,
        });
        try {
          if (injection.func === undefined) throw new Error("Synthetic function is missing");
          const args = "args" in injection && Array.isArray(injection.args) ? injection.args : [];
          const result = await (injection.func as (...values: unknown[]) => unknown)(...args);
          return [{ frameId: 0, result }];
        } finally {
          Object.assign(globalThis, previous);
        }
      },
    );

    await expect(new ChromeCommentInputGateway(api).fill(7, "합성 댓글")).resolves.toBe("filled");
    expect(dom.window.document.querySelector(".u_cbox_text")?.textContent).toBe("합성 댓글");
    expect(submitted).not.toHaveBeenCalled();
  });

  it("opens a folded comment section before filling its contenteditable input", async () => {
    const dom = new JSDOM(
      [
        '<section id="comments" hidden>',
        '<a class="btn_write_comment _naverCommentWriteBtn">댓글쓰기</a>',
        '<div class="u_cbox_text u_cbox_text_mention" contenteditable="true"></div>',
        "</section>",
        '<a class="btn_comment _cmtList">댓글</a>',
      ].join(""),
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    const comments = dom.window.document.querySelector("#comments") as HTMLElement;
    dom.window.document.querySelector(".btn_comment")?.addEventListener("click", () => {
      comments.hidden = false;
    });
    const { api } = apiFixture();
    const execute = api.scripting.executeScript as ReturnType<typeof vi.fn>;
    execute.mockImplementation(
      async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
        const previous = {
          HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
          InputEvent: globalThis.InputEvent,
          document: globalThis.document,
          getComputedStyle: globalThis.getComputedStyle,
          window: globalThis.window,
        };
        Object.assign(globalThis, {
          HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
          InputEvent: dom.window.InputEvent,
          document: dom.window.document,
          getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
          window: dom.window,
        });
        try {
          if (injection.func === undefined) throw new Error("Synthetic function is missing");
          const args = "args" in injection && Array.isArray(injection.args) ? injection.args : [];
          return [
            {
              frameId: 0,
              result: await (injection.func as (...values: unknown[]) => unknown)(...args),
            },
          ];
        } finally {
          Object.assign(globalThis, previous);
        }
      },
    );

    await expect(new ChromeCommentInputGateway(api).fill(7, "접힌 댓글")).resolves.toBe("filled");
    expect(comments.hidden).toBe(false);
    expect(dom.window.document.querySelector(".u_cbox_text")?.textContent).toBe("접힌 댓글");
  });
});
