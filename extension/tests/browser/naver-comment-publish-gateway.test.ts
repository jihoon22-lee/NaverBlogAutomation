import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommentInputResult } from "../../src/browser/comment-input-gateway";
import {
  ChromeCommentPublishGateway,
  type CommentPublishResult,
} from "../../src/browser/naver-comment-publish-gateway";

function gatewayFixture(options: {
  confirmResult?: CommentPublishResult;
  diagnoses?: { blocked: boolean; captcha: boolean; loginRequired: boolean }[];
  fillResult?: CommentInputResult;
  probeCount?: number;
}) {
  const fill = vi.fn().mockResolvedValue(options.fillResult ?? "filled");
  const executeScript = vi.fn();
  if ((options.fillResult ?? "filled") === "filled") {
    executeScript
      .mockResolvedValueOnce([{ frameId: 3, result: { count: options.probeCount ?? 1 } }])
      .mockResolvedValueOnce([{ frameId: 3, result: options.confirmResult ?? "submitted" }]);
  } else {
    executeScript.mockResolvedValueOnce(
      (options.diagnoses ?? []).map((result, frameId) => ({ frameId, result })),
    );
  }
  return {
    executeScript,
    fill,
    gateway: new ChromeCommentPublishGateway(
      { scripting: { executeScript }, tabs: { query: vi.fn() } } as never,
      { input: { fill } },
    ),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ChromeCommentPublishGateway", () => {
  it("fills first, then submits in the exact matched frame", async () => {
    const { executeScript, fill, gateway } = gatewayFixture({});

    await expect(gateway.publish(7, "승인 댓글")).resolves.toBe("submitted");
    expect(fill).toHaveBeenCalledWith(7, "승인 댓글");
    expect(executeScript.mock.calls[1]?.[0].target).toEqual({ frameIds: [3], tabId: 7 });
  });

  it.each([
    [0, "not_found"],
    [2, "ambiguous"],
  ] as const)(
    "does not click when the publish target count is %s",
    async (probeCount, expected) => {
      const { executeScript, gateway } = gatewayFixture({ probeCount });

      await expect(gateway.publish(7, "댓글")).resolves.toBe(expected);
      expect(executeScript).toHaveBeenCalledOnce();
    },
  );

  it("keeps submission_unconfirmed distinct for duplicate prevention", async () => {
    const { executeScript, fill, gateway } = gatewayFixture({
      confirmResult: "submission_unconfirmed",
    });

    await expect(gateway.publish(7, "댓글")).resolves.toBe("submission_unconfirmed");
    await expect(gateway.publish(7, "댓글")).resolves.toBe("submission_unconfirmed");
    expect(fill).toHaveBeenCalledOnce();
    expect(executeScript).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ blocked: false, captcha: true, loginRequired: false }, "captcha_required"],
    [{ blocked: false, captcha: false, loginRequired: true }, "login_required"],
    [{ blocked: true, captcha: false, loginRequired: false }, "comment_blocked"],
  ] as const)("diagnoses an unavailable input as %s", async (diagnosis, expected) => {
    const { gateway } = gatewayFixture({
      diagnoses: [diagnosis],
      fillResult: "not_found",
    });

    await expect(gateway.publish(7, "댓글")).resolves.toBe(expected);
  });

  it("preserves an occupied input without probing a submit button", async () => {
    const { executeScript, gateway } = gatewayFixture({ fillResult: "occupied" });

    await expect(gateway.publish(7, "댓글")).resolves.toBe("occupied");
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("reports permission failures without retrying", async () => {
    const probeFailure = gatewayFixture({});
    probeFailure.executeScript.mockReset().mockRejectedValueOnce(new Error("denied"));
    await expect(probeFailure.gateway.publish(7, "댓글")).resolves.toBe("permission_denied");

    const confirmFailure = gatewayFixture({});
    confirmFailure.executeScript
      .mockReset()
      .mockResolvedValueOnce([{ frameId: 3, result: { count: 1 } }])
      .mockRejectedValueOnce(new Error("denied"));
    await expect(confirmFailure.gateway.publish(7, "댓글")).resolves.toBe("permission_denied");
  });
});

describe("injected comment publish functions", () => {
  function injectedGateway(dom: JSDOM) {
    const fill = vi.fn().mockResolvedValue("filled");
    const executeScript = vi.fn(
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
    return {
      executeScript,
      gateway: new ChromeCommentPublishGateway(
        { scripting: { executeScript }, tabs: { query: vi.fn() } } as never,
        { input: { fill } },
      ),
    };
  }

  it("opens a trusted editor, fills it, and submits through the complete gateway", async () => {
    const dom = new JSDOM(
      '<form class="u_cbox_write_wrap"><a class="btn_write_comment _naverCommentWriteBtn">댓글쓰기</a></form>',
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    const clicked = vi.fn();
    dom.window.document.querySelector("a")?.addEventListener("click", () => {
      const input = dom.window.document.createElement("div");
      input.className = "u_cbox_text u_cbox_text_mention";
      input.setAttribute("contenteditable", "true");
      const submit = dom.window.document.createElement("button");
      submit.className = "u_cbox_btn_upload";
      submit.addEventListener("click", () => {
        clicked();
        input.textContent = "";
      });
      dom.window.document.querySelector("form")?.append(input, submit);
    });
    const { executeScript } = injectedGateway(dom);
    const gateway = new ChromeCommentPublishGateway({
      scripting: { executeScript },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7, url: "https://blog.naver.com/synthetic/7" }]),
      },
    } as never);

    await expect(gateway.publish(7, "승인 댓글")).resolves.toBe("submitted");
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("submits an exact draft that was already inserted before approval", async () => {
    const dom = new JSDOM(
      '<form class="u_cbox_write_area"><div class="u_cbox_text" contenteditable="true">승인 댓글</div><button class="u_cbox_btn_upload">등록</button></form>',
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    const clicked = vi.fn();
    dom.window.document.querySelector("button")?.addEventListener("click", () => {
      clicked();
      const input = dom.window.document.querySelector(".u_cbox_text");
      if (input !== null) input.textContent = "";
    });
    const { executeScript } = injectedGateway(dom);
    const gateway = new ChromeCommentPublishGateway({
      scripting: { executeScript },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7, url: "https://blog.naver.com/synthetic/7" }]),
      },
    } as never);

    await expect(gateway.publish(7, "승인 댓글")).resolves.toBe("submitted");
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("finds Naver's sibling upload button from the outer write wrap", async () => {
    const dom = new JSDOM(
      `
        <div class="u_cbox_write_wrap">
          <form><fieldset><div class="u_cbox_write"><div class="u_cbox_write_inner">
            <div class="u_cbox_write_area"><div class="u_cbox_text u_cbox_text_mention" contenteditable="true">승인 댓글</div></div>
            <div class="u_cbox_upload"><button class="u_cbox_btn_upload">등록</button></div>
          </div></div></fieldset></form>
        </div>
      `,
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    const clicked = vi.fn();
    dom.window.document.querySelector("button")?.addEventListener("click", () => {
      clicked();
      const input = dom.window.document.querySelector(".u_cbox_text");
      if (input !== null) input.textContent = "";
    });
    const { gateway } = injectedGateway(dom);

    await expect(gateway.publish(7, "승인 댓글")).resolves.toBe("submitted");
    expect(clicked).toHaveBeenCalledOnce();
  });

  it.each([
    '<form class="u_cbox_write_area"><textarea class="u_cbox_text">승인 댓글</textarea><button class="u_cbox_btn_upload">등록</button></form>',
    '<form class="u_cbox_write_wrap"><div class="u_cbox_text u_cbox_text_mention" contenteditable="true">승인 댓글</div><button class="_submitButton">등록</button></form>',
  ])("clicks one trusted button and confirms an emptied input: %s", async (html) => {
    const dom = new JSDOM(html, {
      pretendToBeVisual: true,
      url: "https://blog.naver.com/synthetic/7",
    });
    const clicked = vi.fn();
    const input = dom.window.document.querySelector<HTMLElement>(".u_cbox_text");
    dom.window.document.querySelector("button")?.addEventListener("click", () => {
      clicked();
      if (input instanceof dom.window.HTMLTextAreaElement) input.value = "";
      else if (input !== null) input.textContent = "";
    });
    const { gateway } = injectedGateway(dom);

    await expect(gateway.publish(7, "승인 댓글")).resolves.toBe("submitted");
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("confirms a newly rendered matching comment", async () => {
    const dom = new JSDOM(
      '<form class="u_cbox_write_area"><div class="u_cbox_text" contenteditable="true">승인 댓글</div><button class="u_cbox_btn_upload">등록</button></form><div class="u_cbox_comment"></div>',
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    dom.window.document.querySelector("button")?.addEventListener("click", () => {
      const contents = dom.window.document.createElement("div");
      contents.className = "u_cbox_contents";
      contents.textContent = "승인 댓글";
      dom.window.document.querySelector(".u_cbox_comment")?.append(contents);
    });
    const { gateway } = injectedGateway(dom);

    await expect(gateway.publish(7, "승인 댓글")).resolves.toBe("submitted");
  });

  it("clicks once and returns submission_unconfirmed when the page never changes", async () => {
    vi.useFakeTimers();
    const dom = new JSDOM(
      '<form class="u_cbox_write_area"><div class="u_cbox_text" contenteditable="true">승인 댓글</div><button class="u_cbox_btn_upload">등록</button></form>',
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    const clicked = vi.fn();
    dom.window.document.querySelector("button")?.addEventListener("click", clicked);
    const { gateway } = injectedGateway(dom);
    const pending = gateway.publish(7, "승인 댓글");
    await vi.advanceTimersByTimeAsync(3_100);

    await expect(pending).resolves.toBe("submission_unconfirmed");
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("stops on a captcha rendered after the first click", async () => {
    const dom = new JSDOM(
      '<form class="u_cbox_write_area"><div class="u_cbox_text" contenteditable="true">승인 댓글</div><button class="u_cbox_btn_upload">등록</button></form>',
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    const clicked = vi.fn();
    dom.window.document.querySelector("button")?.addEventListener("click", () => {
      clicked();
      const captcha = dom.window.document.createElement("div");
      captcha.className = "u_cbox_captcha";
      Object.defineProperty(captcha, "getBoundingClientRect", {
        value: () => new dom.window.DOMRect(0, 0, 320, 160),
      });
      dom.window.document.body.append(captcha);
    });
    const { gateway } = injectedGateway(dom);

    await expect(gateway.publish(7, "승인 댓글")).resolves.toBe("captcha_required");
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("confirms a submitted comment before ignoring Naver's zero-sized captcha placeholder", async () => {
    const dom = new JSDOM(
      '<form class="u_cbox_write_wrap"><div class="u_cbox_write_area"><div class="u_cbox_text" contenteditable="true">승인 댓글</div></div><div class="u_cbox_upload"><button class="u_cbox_btn_upload">등록</button></div></form><iframe id="captchalayeredframe" title="안부게시판 캡차" src="about:blank"></iframe>',
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    dom.window.document.querySelector("button")?.addEventListener("click", () => {
      const input = dom.window.document.querySelector(".u_cbox_text");
      if (input !== null) input.textContent = "";
    });
    const { gateway } = injectedGateway(dom);

    await expect(gateway.publish(7, "승인 댓글")).resolves.toBe("submitted");
  });

  it("does not submit when two buttons are associated with the input", async () => {
    const dom = new JSDOM(
      '<form class="u_cbox_write_area"><div class="u_cbox_text" contenteditable="true">승인 댓글</div><button class="u_cbox_btn_upload">등록</button><button class="_submitButton">다른 등록</button></form>',
      { pretendToBeVisual: true, url: "https://blog.naver.com/synthetic/7" },
    );
    const clicked = vi.fn();
    for (const button of dom.window.document.querySelectorAll("button")) {
      button.addEventListener("click", clicked);
    }
    const { gateway } = injectedGateway(dom);

    await expect(gateway.publish(7, "승인 댓글")).resolves.toBe("ambiguous");
    expect(clicked).not.toHaveBeenCalled();
  });
});
