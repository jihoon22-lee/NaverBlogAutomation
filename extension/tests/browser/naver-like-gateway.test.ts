import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

import {
  ChromeNaverLikeGateway,
  type LikeActionResult,
} from "../../src/browser/naver-like-gateway";

function fixture(options: {
  active?: Partial<chrome.tabs.Tab>;
  clickResult?: LikeActionResult;
  probe?: { count: number; liked: boolean | null };
}) {
  const executeScript = vi
    .fn()
    .mockResolvedValueOnce([{ frameId: 3, result: options.probe ?? { count: 1, liked: false } }])
    .mockResolvedValueOnce([{ frameId: 3, result: options.clickResult ?? "clicked" }]);
  const query = vi
    .fn()
    .mockResolvedValue([options.active ?? { id: 7, url: "https://blog.naver.com/synthetic/7" }]);
  return {
    api: {
      scripting: { executeScript },
      tabs: { query },
    } as never,
    executeScript,
    query,
  };
}

describe("ChromeNaverLikeGateway", () => {
  it("clicks the sole known-off target in its exact frame", async () => {
    const { api, executeScript } = fixture({});

    await expect(new ChromeNaverLikeGateway(api).like(7)).resolves.toBe("clicked");
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript.mock.calls[1]?.[0].target).toEqual({ frameIds: [3], tabId: 7 });
  });

  it("supports the mobile Naver Blog host", async () => {
    const { api } = fixture({
      active: { id: 7, url: "https://m.blog.naver.com/synthetic/7" },
    });

    await expect(new ChromeNaverLikeGateway(api).like(7)).resolves.toBe("clicked");
  });

  it("does not click an already-liked target", async () => {
    const { api, executeScript } = fixture({ probe: { count: 1, liked: true } });

    await expect(new ChromeNaverLikeGateway(api).like(7)).resolves.toBe("already_liked");
    expect(executeScript).toHaveBeenCalledOnce();
  });

  it.each([
    [{ count: 0, liked: null }, "not_found"],
    [{ count: 2, liked: null }, "ambiguous"],
    [{ count: 1, liked: null }, "state_unknown"],
  ] as const)("does not guess when the probe is %o", async (probe, expected) => {
    const { api, executeScript } = fixture({ probe });

    await expect(new ChromeNaverLikeGateway(api).like(7)).resolves.toBe(expected);
    expect(executeScript).toHaveBeenCalledOnce();
  });

  it("rejects a stale or unsupported active tab before injection", async () => {
    const { api, executeScript } = fixture({
      active: { id: 8, url: "https://example.com/" },
    });

    await expect(new ChromeNaverLikeGateway(api).like(7)).resolves.toBe("stale_page");
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("reports tab-query and script permission failures", async () => {
    const queryFailure = fixture({});
    queryFailure.query.mockRejectedValueOnce(new Error("denied"));
    await expect(new ChromeNaverLikeGateway(queryFailure.api).like(7)).resolves.toBe(
      "permission_denied",
    );

    const probeFailure = fixture({});
    probeFailure.executeScript.mockReset().mockRejectedValueOnce(new Error("denied"));
    await expect(new ChromeNaverLikeGateway(probeFailure.api).like(7)).resolves.toBe(
      "permission_denied",
    );

    const clickFailure = fixture({});
    clickFailure.executeScript
      .mockReset()
      .mockResolvedValueOnce([{ frameId: 3, result: { count: 1, liked: false } }])
      .mockRejectedValueOnce(new Error("denied"));
    await expect(new ChromeNaverLikeGateway(clickFailure.api).like(7)).resolves.toBe(
      "permission_denied",
    );
  });

  it("returns not_found when the exact-frame click has no result", async () => {
    const { api, executeScript } = fixture({});
    executeScript
      .mockReset()
      .mockResolvedValueOnce([{ frameId: 3, result: { count: 1, liked: false } }])
      .mockResolvedValueOnce([]);

    await expect(new ChromeNaverLikeGateway(api).like(7)).resolves.toBe("not_found");
  });
});

describe("injected Naver like functions", () => {
  it.each([
    ['<button class="u_likeit_list_btn on"></button>', "already_liked", 0],
    ['<button class="u_likeit_list_btn off"></button>', "clicked", 1],
    ['<button class="u_likeit_list_btn" aria-pressed="true"></button>', "already_liked", 0],
    ['<button class="u_likeit_list_btn" aria-pressed="false"></button>', "clicked", 1],
    ['<button class="u_likeit_list_btn" data-status="liked"></button>', "already_liked", 0],
    ['<button class="u_likeit_list_btn" data-state="unliked"></button>', "clicked", 1],
    ['<button class="u_likeit_list_btn" title="공감 취소"></button>', "already_liked", 0],
    ['<button class="u_likeit_list_btn"></button>', "state_unknown", 0],
  ] as const)("reads state before clicking %s", async (html, expected, clicks) => {
    const dom = new JSDOM(html, {
      pretendToBeVisual: true,
      url: "https://blog.naver.com/synthetic/7",
    });
    const clicked = vi.fn();
    dom.window.document.querySelector("button")?.addEventListener("click", clicked);
    const { api, executeScript: execute } = fixture({});
    execute.mockReset();
    execute.mockImplementation(
      async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
        const previous = {
          document: globalThis.document,
          getComputedStyle: globalThis.getComputedStyle,
        };
        Object.assign(globalThis, {
          document: dom.window.document,
          getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        });
        try {
          if (injection.func === undefined) throw new Error("Synthetic function is missing");
          const result = await (injection.func as () => unknown)();
          return [{ frameId: 0, result }];
        } finally {
          Object.assign(globalThis, previous);
        }
      },
    );

    await expect(new ChromeNaverLikeGateway(api).like(7)).resolves.toBe(expected);
    expect(clicked).toHaveBeenCalledTimes(clicks);
  });

  it.each([
    '<button class="u_likeit_list_btn off" disabled></button>',
    '<button class="u_likeit_list_btn off" aria-disabled="true"></button>',
    '<button class="u_likeit_list_btn off" hidden></button>',
  ])("ignores a non-actionable target: %s", async (html) => {
    const dom = new JSDOM(html, {
      pretendToBeVisual: true,
      url: "https://blog.naver.com/synthetic/7",
    });
    const { api, executeScript: execute } = fixture({});
    execute.mockReset();
    execute.mockImplementation(
      async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
        const previous = {
          document: globalThis.document,
          getComputedStyle: globalThis.getComputedStyle,
        };
        Object.assign(globalThis, {
          document: dom.window.document,
          getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        });
        try {
          if (injection.func === undefined) throw new Error("Synthetic function is missing");
          return [{ frameId: 0, result: await (injection.func as () => unknown)() }];
        } finally {
          Object.assign(globalThis, previous);
        }
      },
    );

    await expect(new ChromeNaverLikeGateway(api).like(7)).resolves.toBe("not_found");
  });

  it("does not click when two actionable targets exist in one frame", async () => {
    const dom = new JSDOM(
      '<button class="u_likeit_list_btn off"></button><a class="u_likeit_list_btn off"></a>',
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    const clicked = vi.fn();
    for (const element of dom.window.document.querySelectorAll(".u_likeit_list_btn")) {
      element.addEventListener("click", clicked);
    }
    const { api, executeScript: execute } = fixture({});
    execute.mockReset();
    execute.mockImplementation(
      async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
        const previous = {
          document: globalThis.document,
          getComputedStyle: globalThis.getComputedStyle,
        };
        Object.assign(globalThis, {
          document: dom.window.document,
          getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        });
        try {
          if (injection.func === undefined) throw new Error("Synthetic function is missing");
          return [{ frameId: 0, result: await (injection.func as () => unknown)() }];
        } finally {
          Object.assign(globalThis, previous);
        }
      },
    );

    await expect(new ChromeNaverLikeGateway(api).like(7)).resolves.toBe("ambiguous");
    expect(clicked).not.toHaveBeenCalled();
  });
});
