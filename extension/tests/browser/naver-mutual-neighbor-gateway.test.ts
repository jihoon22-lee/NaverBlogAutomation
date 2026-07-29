import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChromeNaverMutualNeighborGateway,
  type MutualNeighborActionResult,
} from "../../src/browser/naver-mutual-neighbor-gateway";

const POST_URL = "https://blog.naver.com/candidate/123";
const liveEntryFixture = readFileSync(
  new URL("../fixtures/naver-mutual-neighbor-entry.html", import.meta.url),
  "utf8",
);
const liveControlsFixture = readFileSync(
  new URL("../fixtures/naver-live-controls.html", import.meta.url),
  "utf8",
);
const wizardFixture = readFileSync(
  new URL("../fixtures/naver-mutual-neighbor-wizard.html", import.meta.url),
  "utf8",
);
const livePopupApplicationFixture = readFileSync(
  new URL("../fixtures/naver-mutual-neighbor-popup-application.html", import.meta.url),
  "utf8",
);
const livePopupCompleteFixture = readFileSync(
  new URL("../fixtures/naver-mutual-neighbor-popup-complete.html", import.meta.url),
  "utf8",
);

function postDom(html = '<button class="btn_add_buddy">이웃추가</button>'): JSDOM {
  return new JSDOM(html, { pretendToBeVisual: true, url: POST_URL });
}

function requestForm(message = ""): string {
  return `
    <form id="buddyAddForm">
      <label><input id="both_buddy" name="relation" type="radio" value="both">서로이웃</label>
      <textarea id="message" name="message">${message}</textarea>
      <button class="btn_ok" type="submit">신청</button>
    </form>
  `;
}

function browserFixture(dom: JSDOM, activeUrl = POST_URL) {
  let active: Partial<chrome.tabs.Tab> = { id: 7, status: "complete", url: activeUrl };
  const documents = new Map<number, JSDOM>([[7, dom]]);
  const tabs = new Map<number, Partial<chrome.tabs.Tab>>([[7, active]]);
  const query = vi.fn(async (queryInfo?: chrome.tabs.QueryInfo) => {
    if (queryInfo?.url === undefined) return [active];
    const patterns = Array.isArray(queryInfo.url) ? queryInfo.url : [queryInfo.url];
    return [...tabs.values()].filter((tab) =>
      patterns.some((pattern) =>
        new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\*", ".*")}$`).test(
          tab.url ?? "",
        ),
      ),
    );
  });
  const remove = vi.fn(async (tabId: number) => {
    documents.delete(tabId);
    tabs.delete(tabId);
  });
  const executeScript = vi.fn(
    async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
      const target = injection.target;
      const targetDom = documents.get(target.tabId);
      if (targetDom === undefined) throw new Error("missing synthetic tab");
      const previous = {
        Event: globalThis.Event,
        HTMLInputElement: globalThis.HTMLInputElement,
        HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
        InputEvent: globalThis.InputEvent,
        document: globalThis.document,
        getComputedStyle: globalThis.getComputedStyle,
        window: globalThis.window,
      };
      Object.assign(globalThis, {
        Event: targetDom.window.Event,
        HTMLInputElement: targetDom.window.HTMLInputElement,
        HTMLTextAreaElement: targetDom.window.HTMLTextAreaElement,
        InputEvent: targetDom.window.InputEvent,
        document: targetDom.window.document,
        getComputedStyle: targetDom.window.getComputedStyle.bind(targetDom.window),
        window: targetDom.window,
      });
      try {
        if (injection.func === undefined) throw new Error("Synthetic function is missing");
        const args = "args" in injection && Array.isArray(injection.args) ? injection.args : [];
        const result = await (injection.func as (...values: unknown[]) => unknown)(...args);
        return [{ frameId: "frameIds" in target ? (target.frameIds?.[0] ?? 0) : 0, result }];
      } finally {
        Object.assign(globalThis, previous);
      }
    },
  );
  return {
    api: { scripting: { executeScript }, tabs: { query, remove } } as never,
    documents,
    executeScript,
    remove,
    gateway: new ChromeNaverMutualNeighborGateway({
      scripting: { executeScript },
      tabs: { query, remove },
    } as never),
    openPopup(id: number, popup: JSDOM, focus = true): void {
      documents.set(id, popup);
      const tab: Partial<chrome.tabs.Tab> = {
        id,
        status: "complete",
        url: "https://blog.naver.com/BuddyAddForm.naver?blogId=candidate",
      };
      tabs.set(id, tab);
      if (focus) active = tab;
    },
    navigatePopup(id: number, popup: JSDOM): void {
      documents.set(id, popup);
      const tab: Partial<chrome.tabs.Tab> = {
        id,
        status: "complete",
        url: "https://blog.naver.com/BuddyAdd.naver",
      };
      tabs.set(id, tab);
      if (active.id === id) active = tab;
    },
    setActive(tab: Partial<chrome.tabs.Tab>): void {
      active = tab;
      if (tab.id !== undefined) tabs.set(tab.id, tab);
    },
    query,
  };
}

function installInlineForm(dom: JSDOM, onSubmit?: () => void): void {
  dom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
    dom.window.document.body.insertAdjacentHTML("beforeend", requestForm());
    dom.window.document.querySelector("#buddyAddForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      onSubmit?.();
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ChromeNaverMutualNeighborGateway", () => {
  it("selects mutual neighbor, fills the approved message, and confirms one request", async () => {
    const dom = postDom();
    const submitted = vi.fn();
    installInlineForm(dom, () => {
      submitted();
      const status = dom.window.document.createElement("p");
      status.setAttribute("role", "status");
      status.textContent = "서로이웃 신청이 완료되었습니다.";
      dom.window.document.body.append(status);
    });
    const { gateway } = browserFixture(dom);

    await expect(
      gateway.request(7, "candidate", " 반갑습니다. 서로이웃 부탁드려요. "),
    ).resolves.toEqual({
      code: "requested",
    });
    expect(submitted).toHaveBeenCalledOnce();
    expect(
      (dom.window.document.querySelector("#both_buddy") as HTMLInputElement | null)?.checked,
    ).toBe(true);
    expect(
      (dom.window.document.querySelector("#message") as HTMLTextAreaElement | null)?.value,
    ).toBe(" 반갑습니다. 서로이웃 부탁드려요. ");
  });

  it("continues in the exact Naver popup tab opened by the trusted entry", async () => {
    const dom = postDom();
    const popup = new JSDOM(requestForm(), {
      pretendToBeVisual: true,
      url: "https://blog.naver.com/BuddyAddForm.naver?blogId=candidate",
    });
    const fixture = browserFixture(dom);
    dom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
      fixture.openPopup(8, popup);
    });
    popup.window.document.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const status = popup.window.document.createElement("p");
      status.setAttribute("role", "status");
      status.textContent = "서로이웃 신청이 완료되었습니다.";
      popup.window.document.body.append(status);
    });

    await expect(fixture.gateway.request(7, "candidate", "승인한 신청 메시지")).resolves.toEqual({
      code: "requested",
    });
    expect(
      fixture.executeScript.mock.calls.some(
        ([injection]) =>
          (injection as chrome.scripting.ScriptInjection<unknown[], unknown>).target.tabId === 8,
      ),
    ).toBe(true);
  });

  it("finds an unfocused Naver popup, follows its second page, and preserves the selected group", async () => {
    const dom = postDom();
    const relationship = new JSDOM(
      `
        <form name="buddyFrm">
          <label><input id="buddy_add" name="relation" type="radio" value="0" checked>이웃</label>
          <label><input id="each_buddy_add" name="relation" type="radio" value="1">서로이웃</label>
          <a class="button_next _buddyAddNext" href="#">다음</a>
        </form>
      `,
      {
        pretendToBeVisual: true,
        url: "https://blog.naver.com/BuddyAdd.naver?blogId=candidate",
      },
    );
    const application = new JSDOM(livePopupApplicationFixture, {
      pretendToBeVisual: true,
      url: "https://blog.naver.com/BuddyAdd.naver",
    });
    const fixture = browserFixture(dom);
    const closed = vi.fn();
    let submittedMessage = "";
    dom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
      fixture.openPopup(8, relationship, false);
    });
    relationship.window.document
      .querySelector("._buddyAddNext")
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        fixture.navigatePopup(8, application);
      });
    application.window.document
      .querySelector("._addBothBuddy")
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        submittedMessage = (
          application.window.document.querySelector("#message") as HTMLTextAreaElement
        ).value;
        const complete = new JSDOM(livePopupCompleteFixture);
        application.window.document.body.innerHTML = complete.window.document.body.innerHTML;
        application.window.document
          .querySelector(".button_close")
          ?.addEventListener("click", closed);
      });

    await expect(fixture.gateway.request(7, "candidate", "승인한 신청 메시지")).resolves.toEqual({
      code: "requested",
    });
    expect(
      (relationship.window.document.querySelector("#each_buddy_add") as HTMLInputElement).checked,
    ).toBe(true);
    expect(submittedMessage).toBe("승인한 신청 메시지");
    expect(closed).toHaveBeenCalledOnce();
    expect(fixture.remove).toHaveBeenCalledWith(8);
    expect(fixture.query).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.arrayContaining(["https://blog.naver.com/BuddyAdd.naver*"]),
      }),
    );
  });

  it("recognizes the sanitized current Naver post entry selector", async () => {
    const dom = postDom(liveEntryFixture);
    const entry = dom.window.document.querySelector("._buddy_popup_btn");
    entry?.addEventListener("click", (event) => {
      event.preventDefault();
      dom.window.document.body.insertAdjacentHTML("beforeend", requestForm());
      dom.window.document.querySelector("form")?.addEventListener("submit", (submitEvent) => {
        submitEvent.preventDefault();
        const status = dom.window.document.createElement("p");
        status.setAttribute("role", "status");
        status.textContent = "서로이웃 신청이 완료되었습니다.";
        dom.window.document.body.append(status);
      });
    });
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "승인한 신청 메시지")).resolves.toEqual({
      code: "requested",
    });
  });

  it("uses the canonical visible neighbor entry and ignores an ancestor-hidden duplicate", async () => {
    const dom = postDom(liveControlsFixture);
    const canonical = dom.window.document.querySelector("#canonical-neighbor") as HTMLAnchorElement;
    const hidden = dom.window.document.querySelector(".btn_add_buddy") as HTMLAnchorElement;
    const hiddenClicked = vi.fn();
    hidden.addEventListener("click", hiddenClicked);
    canonical.addEventListener("click", (event) => {
      event.preventDefault();
      dom.window.document.body.insertAdjacentHTML("beforeend", requestForm());
      dom.window.document.querySelector("form")?.addEventListener("submit", (submitEvent) => {
        submitEvent.preventDefault();
        const status = dom.window.document.createElement("p");
        status.setAttribute("role", "status");
        status.textContent = "서로이웃 신청이 완료되었습니다.";
        dom.window.document.body.append(status);
      });
    });
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "승인한 신청 메시지")).resolves.toEqual({
      code: "requested",
    });
    expect(hiddenClicked).not.toHaveBeenCalled();
  });

  it("selects only mutual neighbor and completes the two-next popup before closing", async () => {
    const dom = postDom(`<button class="btn_add_buddy">이웃추가</button>${wizardFixture}`);
    const form = dom.window.document.querySelector("form[name='buddyFrm']") as HTMLFormElement;
    const defaultOption = form.querySelector("#buddy_add") as HTMLInputElement;
    const mutualOption = form.querySelector("#each_buddy_add") as HTMLInputElement;
    const closed = vi.fn();
    form.hidden = true;
    dom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
      form.hidden = false;
    });
    form.querySelector("._buddyAddNext")?.addEventListener("click", (event) => {
      event.preventDefault();
      dom.window.document.body.innerHTML = `
        <form name="buddyApplyFrm">
          <textarea id="message" name="message"></textarea>
          <a class="button_next _addBothBuddy" href="#">다음</a>
        </form>
      `;
      dom.window.document
        .querySelector("._addBothBuddy")
        ?.addEventListener("click", (nextEvent) => {
          nextEvent.preventDefault();
          dom.window.document.body.innerHTML =
            '<p role="status">서로이웃 신청이 완료되었습니다.</p><a class="button_close" href="#">닫기</a>';
          dom.window.document
            .querySelector(".button_close")
            ?.addEventListener("click", (closeEvent) => {
              closeEvent.preventDefault();
              closed();
            });
        });
    });
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "승인한 신청 메시지")).resolves.toEqual({
      code: "requested",
    });
    expect(mutualOption.checked).toBe(true);
    expect(defaultOption.checked).toBe(false);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("selects a custom-rendered mutual option and default group before filling the message", async () => {
    const dom = postDom(`
      <button class="btn_add_buddy">이웃추가</button>
      <form name="buddyFrm" hidden>
        <label for="hidden-mutual">서로이웃</label>
        <input id="hidden-mutual" name="relation" type="radio" value="mutual" style="display:none">
        <a class="button_next" href="#">다음</a>
      </form>
    `);
    const relationship = dom.window.document.querySelector(
      "form[name='buddyFrm']",
    ) as HTMLFormElement;
    const mutual = relationship.querySelector("#hidden-mutual") as HTMLInputElement;
    const closed = vi.fn();
    dom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
      relationship.hidden = false;
    });
    relationship.querySelector(".button_next")?.addEventListener("click", (event) => {
      event.preventDefault();
      dom.window.document.body.innerHTML = `
        <form id="buddyGroupForm" name="buddyApplyFrm">
          <select name="buddyGroup"><option value="">그룹 선택</option><option value="daily">일상</option></select>
          <textarea name="buddyMessage"></textarea>
          <button type="button">다음</button>
        </form>
      `;
      dom.window.document.querySelector("#buddyGroupForm button")?.addEventListener("click", () => {
        dom.window.document.body.innerHTML =
          '<p role="status">서로이웃 신청이 완료되었습니다.</p><button>닫기</button>';
        dom.window.document.querySelector("button")?.addEventListener("click", closed);
      });
    });
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "자동 입력 신청 메시지")).resolves.toEqual({
      code: "requested",
    });
    expect(mutual.checked).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("fails closed instead of guessing between unselected custom neighbor groups", async () => {
    const dom = postDom(
      '<button class="btn_add_buddy">이웃추가</button><form name="buddyFrm"><input id="each_buddy_add" type="radio" value="1"><a class="button_next">다음</a></form>',
    );
    const relationship = dom.window.document.querySelector(
      "form[name='buddyFrm']",
    ) as HTMLFormElement;
    relationship.hidden = true;
    dom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
      relationship.hidden = false;
    });
    relationship.querySelector(".button_next")?.addEventListener("click", (event) => {
      event.preventDefault();
      dom.window.document.body.innerHTML = `
        <form name="buddyApplyFrm">
          <a aria-selected="false" class="_selectGroup" groupid="1">새 그룹</a>
          <a aria-selected="false" class="_selectGroup" groupid="2">의학</a>
          <textarea id="message"></textarea><a class="button_next">다음</a>
        </form>
      `;
    });
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "승인한 신청 메시지")).resolves.toEqual({
      code: "state_unknown",
    });
  });

  it("selects the only custom neighbor group before submitting the message", async () => {
    const dom = postDom(
      '<button class="btn_add_buddy">이웃추가</button><form name="buddyFrm"><input id="each_buddy_add" type="radio" value="1"><a class="button_next">다음</a></form>',
    );
    const relationship = dom.window.document.querySelector(
      "form[name='buddyFrm']",
    ) as HTMLFormElement;
    relationship.hidden = true;
    const closed = vi.fn();
    dom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
      relationship.hidden = false;
    });
    relationship.querySelector(".button_next")?.addEventListener("click", (event) => {
      event.preventDefault();
      dom.window.document.body.innerHTML = `
        <form name="buddyApplyFrm">
          <a aria-selected="false" class="_selectGroup" groupid="1">새 그룹</a>
          <textarea id="message"></textarea><a class="button_next">다음</a>
        </form>
      `;
      dom.window.document
        .querySelector("._selectGroup")
        ?.addEventListener("click", (groupEvent) => {
          (groupEvent.currentTarget as HTMLElement | null)?.setAttribute("aria-selected", "true");
        });
      dom.window.document.querySelector(".button_next")?.addEventListener("click", (nextEvent) => {
        nextEvent.preventDefault();
        dom.window.document.body.innerHTML =
          '<p role="status">서로이웃 신청이 완료되었습니다.</p><a class="button_close">닫기</a>';
        dom.window.document.querySelector(".button_close")?.addEventListener("click", closed);
      });
    });
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "승인한 신청 메시지")).resolves.toEqual({
      code: "requested",
    });
    expect(closed).toHaveBeenCalledOnce();
  });

  it("fails closed when a completed mutual-neighbor popup has duplicate close controls", async () => {
    const dom = postDom();
    installInlineForm(dom, () => {
      dom.window.document.body.insertAdjacentHTML(
        "beforeend",
        '<p role="status">서로이웃 신청이 완료되었습니다.</p><a class="button_close">닫기</a><a class="button_close">닫기</a>',
      );
    });
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "승인한 신청 메시지")).resolves.toEqual({
      code: "ambiguous",
    });
  });

  it("closes Naver's class-only completion control after a confirmed request", async () => {
    const dom = postDom();
    const closed = vi.fn();
    installInlineForm(dom, () => {
      dom.window.document.body.insertAdjacentHTML(
        "beforeend",
        '<p role="status">서로이웃 신청이 완료되었습니다.</p><a class="button_close" title="완료">×</a>',
      );
      dom.window.document.querySelector(".button_close")?.addEventListener("click", closed);
    });
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "승인한 신청 메시지")).resolves.toEqual({
      code: "requested",
    });
    expect(closed).toHaveBeenCalledOnce();
  });

  it.each([
    [
      '<form name="buddyApplyFrm"><textarea id="message"></textarea><textarea name="buddyMessage"></textarea><a class="button_next">다음</a></form>',
      "ambiguous",
    ],
    [
      '<form name="buddyApplyFrm"><textarea id="message">기존 메시지</textarea><a class="button_next">다음</a></form>',
      "message_occupied",
    ],
    ['<form name="buddyApplyFrm"><a class="button_next">다음</a></form>', "not_found"],
    [
      '<form name="buddyApplyFrm"><textarea id="message" readonly></textarea><a class="button_next">다음</a></form>',
      "not_found",
    ],
    ['<form name="buddyApplyFrm"><textarea id="message"></textarea></form>', "not_found"],
    [
      '<form name="buddyApplyFrm"><textarea id="message"></textarea><a class="button_next">다음</a><button>다음</button></form>',
      "ambiguous",
    ],
  ] as const)(
    "fails closed for an invalid mutual-neighbor application step",
    async (application, code) => {
      const dom = postDom(
        '<button class="btn_add_buddy">이웃추가</button><form name="buddyFrm"><input id="each_buddy_add" type="radio" value="1"><a class="button_next">다음</a></form>',
      );
      const relationship = dom.window.document.querySelector(
        "form[name='buddyFrm']",
      ) as HTMLFormElement;
      relationship.hidden = true;
      dom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
        relationship.hidden = false;
      });
      relationship.querySelector(".button_next")?.addEventListener("click", (event) => {
        event.preventDefault();
        dom.window.document.body.innerHTML = application;
      });
      const { gateway } = browserFixture(dom);

      await expect(gateway.request(7, "candidate", "승인한 신청 메시지")).resolves.toEqual({
        code,
      });
    },
  );

  it.each([
    ['<div data-buddy-status="mutual">서로이웃</div>', "already_mutual"],
    ['<div data-buddy-status="neighbor">이웃</div>', "already_neighbor"],
    ['<div data-buddy-status="pending">신청 중</div>', "request_pending"],
    ['<button class="btn_add_buddy" disabled>이웃추가</button>', "request_unavailable"],
    ['<button class="btn_add_buddy">이웃 관리</button>', "state_unknown"],
  ] as const)("does not click an existing or unavailable relationship: %s", async (html, code) => {
    const dom = postDom(html);
    const clicked = vi.fn();
    dom.window.document.querySelector("*")?.addEventListener("click", clicked);
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "신청 메시지")).resolves.toEqual({ code });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("rejects a post whose exact author does not match the queued candidate", async () => {
    const dom = postDom();
    const fixture = browserFixture(dom);

    await expect(fixture.gateway.request(7, "different", "신청 메시지")).resolves.toEqual({
      code: "author_mismatch",
    });
    expect(fixture.executeScript).not.toHaveBeenCalled();
  });

  it("accepts the PostView query form of an exact author URL", async () => {
    const dom = postDom();
    installInlineForm(dom, () => {
      const status = dom.window.document.createElement("p");
      status.setAttribute("role", "status");
      status.textContent = "서로이웃 신청이 완료되었습니다.";
      dom.window.document.body.append(status);
    });
    const { gateway } = browserFixture(
      dom,
      "https://blog.naver.com/PostView.naver?blogId=candidate&logNo=123",
    );

    await expect(gateway.request(7, "candidate", "신청 메시지")).resolves.toEqual({
      code: "requested",
    });
  });

  it("does not guess between duplicate entry points and returns sanitized diagnostics", async () => {
    const dom = postDom(
      '<button class="btn_add_buddy">이웃추가</button><button class="_addBuddy">이웃추가</button>',
    );
    const clicked = vi.fn();
    for (const button of dom.window.document.querySelectorAll("button")) {
      button.addEventListener("click", clicked);
    }
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "신청 메시지")).resolves.toEqual({
      code: "ambiguous",
      diagnostic: {
        candidateCount: 2,
        matchedKinds: ["add_buddy_action", "btn_add_buddy"],
        stage: "entry",
      },
    });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("preserves an occupied application message", async () => {
    const dom = postDom();
    installInlineForm(dom);
    dom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
      const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("#message");
      if (textarea !== null) textarea.value = "기존 신청 메시지";
    });
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "새 신청 메시지")).resolves.toEqual({
      code: "message_occupied",
    });
  });

  it.each([
    [
      '<form id="buddyAddForm"><textarea id="message"></textarea><button class="btn_ok" type="submit">신청</button></form>',
      "state_unknown",
    ],
    [
      '<form id="buddyAddForm"><input id="both_buddy" type="radio" value="both"><input id="relation_both" type="radio" value="both"><textarea id="message"></textarea><button class="btn_ok" type="submit">신청</button></form>',
      "ambiguous",
    ],
    [
      '<form id="buddyAddForm"><input id="both_buddy" type="radio" value="both"><button class="btn_ok" type="submit">신청</button></form>',
      "not_found",
    ],
    [
      '<form id="buddyAddForm"><input id="both_buddy" type="radio" value="both"><textarea id="message"></textarea><textarea name="buddyMessage"></textarea><button class="btn_ok" type="submit">신청</button></form>',
      "ambiguous",
    ],
    [
      '<form id="buddyAddForm"><input id="both_buddy" type="radio" value="both"><textarea id="message"></textarea></form>',
      "not_found",
    ],
    [
      '<form id="buddyAddForm"><input id="both_buddy" type="radio" value="both"><textarea id="message"></textarea><button class="btn_ok" type="submit">신청</button><button class="_submit">확인</button></form>',
      "ambiguous",
    ],
  ] as const)("fails closed for an incomplete or ambiguous request form", async (form, code) => {
    const dom = postDom();
    dom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
      dom.window.document.body.insertAdjacentHTML("beforeend", form);
    });
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "신청 메시지")).resolves.toEqual({ code });
  });

  it("fails closed when the trusted entry opens duplicate request forms", async () => {
    const dom = postDom();
    dom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
      dom.window.document.body.insertAdjacentHTML("beforeend", requestForm() + requestForm());
    });
    const { gateway } = browserFixture(dom);

    await expect(gateway.request(7, "candidate", "신청 메시지")).resolves.toEqual({
      code: "ambiguous",
      diagnostic: {
        candidateCount: 2,
        matchedKinds: ["buddy_add_form_id"],
        stage: "form",
      },
    });
  });

  it("stops when the entry opens Naver login or a form for another author", async () => {
    const loginDom = postDom();
    const login = browserFixture(loginDom);
    loginDom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
      login.setActive({ id: 8, url: "https://nid.naver.com/nidlogin.login" });
    });
    await expect(login.gateway.request(7, "candidate", "신청 메시지")).resolves.toEqual({
      code: "login_required",
    });

    const mismatchDom = postDom();
    const mismatch = browserFixture(mismatchDom);
    mismatchDom.window.document.querySelector(".btn_add_buddy")?.addEventListener("click", () => {
      mismatch.setActive({
        id: 9,
        url: "https://blog.naver.com/BuddyAdd.naver?blogId=different",
      });
    });
    await expect(mismatch.gateway.request(7, "candidate", "신청 메시지")).resolves.toEqual({
      code: "author_mismatch",
    });
  });

  it.each([
    ["<p>로그인 후 이웃 신청을 사용할 수 있습니다.</p>", "login_required"],
    ['<iframe title="안부게시판 캡차"></iframe>', "captcha_required"],
    ["<p>이웃 신청을 할 수 없습니다.</p>", "request_unavailable"],
  ] as const)("diagnoses a missing entry without clicking: %s", async (html, code) => {
    const { gateway } = browserFixture(postDom(html));

    const result = await gateway.request(7, "candidate", "신청 메시지");

    expect(result).toMatchObject({ code });
    expect(result.diagnostic).toEqual({
      candidateCount: 0,
      matchedKinds: [],
      stage: "entry",
    });
  });

  it("does not automatically submit the same unconfirmed request twice", async () => {
    vi.useFakeTimers();
    const dom = postDom();
    const submitted = vi.fn();
    installInlineForm(dom, submitted);
    const { executeScript, gateway } = browserFixture(dom);
    const pending = gateway.request(7, "candidate", "결과 불명 신청");
    await vi.advanceTimersByTimeAsync(3_100);

    await expect(pending).resolves.toEqual({ code: "request_unconfirmed" });
    await expect(gateway.request(7, "candidate", "결과 불명 신청")).resolves.toEqual({
      code: "request_unconfirmed",
    });
    expect(submitted).toHaveBeenCalledOnce();
    expect(
      executeScript.mock.calls.filter(
        ([injection]) =>
          (injection as chrome.scripting.ScriptInjection<unknown[], unknown>).func?.name ===
          "selectMutualNeighborAndAdvance",
      ),
    ).toHaveLength(1);
  });

  it("reports stale tabs and permission failures before an external action", async () => {
    const stale = browserFixture(postDom());
    stale.query.mockResolvedValueOnce([{ id: 8, url: POST_URL }]);
    await expect(stale.gateway.request(7, "candidate", "신청 메시지")).resolves.toEqual({
      code: "stale_page",
    });

    const denied = browserFixture(postDom());
    denied.query.mockRejectedValueOnce(new Error("denied"));
    await expect(denied.gateway.request(7, "candidate", "신청 메시지")).resolves.toEqual({
      code: "permission_denied",
    });
  });

  it("fails closed for invalid blog IDs and messages", async () => {
    const { gateway } = browserFixture(postDom());
    const cases: [string, string, MutualNeighborActionResult][] = [
      ["candidate/other", "신청 메시지", { code: "state_unknown" }],
      ["candidate", " ", { code: "state_unknown" }],
      ["candidate", "가".repeat(501), { code: "state_unknown" }],
    ];

    for (const [blogId, message, expected] of cases) {
      await expect(gateway.request(7, blogId, message)).resolves.toEqual(expected);
    }
  });
});
