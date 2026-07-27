import { readFile } from "node:fs/promises";

import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MUTUAL_NEIGHBOR_MESSAGE,
  MUTUAL_NEIGHBOR_MESSAGE_STORAGE_KEY,
  type MessageSettingsStorage,
  MutualNeighborMessageSettings,
} from "../../src/engagement/message-settings";

const htmlPath = new URL("../../public/sidepanel.html", import.meta.url);

class MemoryStorage implements MessageSettingsStorage {
  value: Record<string, unknown> = {};
  get = vi.fn(async () => this.value);
  set = vi.fn(async (items: Record<string, unknown>) => {
    this.value = { ...this.value, ...items };
  });
}

let document: Document;
let domWindow: Window & typeof globalThis;
let storage: MemoryStorage;

beforeEach(async () => {
  const dom = new JSDOM(await readFile(htmlPath, "utf8"), {
    url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sidepanel.html",
  });
  document = dom.window.document;
  domWindow = dom.window as unknown as Window & typeof globalThis;
  storage = new MemoryStorage();
});

describe("MutualNeighborMessageSettings", () => {
  it.each([
    null,
    [],
    { message: "필드 부족" },
    { message: 123, schemaVersion: 1 },
    { message: " 앞뒤 공백 ", schemaVersion: 1 },
    { extra: true, message: "필드 초과", schemaVersion: 1 },
  ])("falls back for malformed persisted value %#", async (stored) => {
    storage.value[MUTUAL_NEIGHBOR_MESSAGE_STORAGE_KEY] = stored;
    const settings = new MutualNeighborMessageSettings(document, storage);

    await expect(settings.start()).resolves.toBe(DEFAULT_MUTUAL_NEIGHBOR_MESSAGE);
  });

  it("loads the safe default and stores one bounded message", async () => {
    const changed = vi.fn();
    domWindow.addEventListener("mutual-neighbor-message-changed", changed);
    const settings = new MutualNeighborMessageSettings(document, storage);

    await expect(settings.start()).resolves.toBe(DEFAULT_MUTUAL_NEIGHBOR_MESSAGE);
    const input = document.querySelector<HTMLTextAreaElement>("#mutual-neighbor-default-message");
    const form = document.querySelector<HTMLFormElement>("#mutual-neighbor-message-form");
    if (input === null || form === null) throw new Error("Synthetic message form missing");
    input.value = "새 기본 신청 메시지";
    input.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
    form.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(storage.set).toHaveBeenCalledWith({
      [MUTUAL_NEIGHBOR_MESSAGE_STORAGE_KEY]: {
        message: "새 기본 신청 메시지",
        schemaVersion: 1,
      },
    });
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { message: "새 기본 신청 메시지" } }),
    );
    expect(document.querySelector("#mutual-neighbor-message-notice")?.textContent).toContain(
      "저장했습니다",
    );
  });

  it("restores a valid saved message and rejects an empty replacement", async () => {
    storage.value[MUTUAL_NEIGHBOR_MESSAGE_STORAGE_KEY] = {
      message: "저장된 신청 메시지",
      schemaVersion: 1,
    };
    const settings = new MutualNeighborMessageSettings(document, storage);
    await expect(settings.start()).resolves.toBe("저장된 신청 메시지");
    const input = document.querySelector<HTMLTextAreaElement>("#mutual-neighbor-default-message");
    const form = document.querySelector<HTMLFormElement>("#mutual-neighbor-message-form");
    if (input === null || form === null) throw new Error("Synthetic message form missing");
    input.value = " ";
    form.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }));

    expect(storage.set).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    expect(document.querySelector("#mutual-neighbor-message-notice")?.textContent).toContain(
      "한 글자",
    );
  });

  it("bounds Unicode input and falls back when storage cannot be read", async () => {
    storage.get.mockRejectedValueOnce(new Error("storage unavailable"));
    const settings = new MutualNeighborMessageSettings(document, storage);
    await expect(settings.start()).resolves.toBe(DEFAULT_MUTUAL_NEIGHBOR_MESSAGE);
    const input = document.querySelector<HTMLTextAreaElement>("#mutual-neighbor-default-message");
    if (input === null) throw new Error("Synthetic message input missing");
    input.value = "🙂".repeat(501);
    input.dispatchEvent(new domWindow.Event("input", { bubbles: true }));

    expect(Array.from(input.value)).toHaveLength(500);
    expect(document.querySelector("#mutual-neighbor-message-count")?.textContent).toContain(
      "500 / 500",
    );
    expect(document.querySelector("#mutual-neighbor-message-notice")?.textContent).toContain(
      "기본 문구",
    );
  });

  it("ignores malformed storage and explains a failed save", async () => {
    storage.value[MUTUAL_NEIGHBOR_MESSAGE_STORAGE_KEY] = {
      message: "신뢰할 수 없는 schema",
      schemaVersion: 2,
    };
    storage.set.mockRejectedValueOnce(new Error("write unavailable"));
    const settings = new MutualNeighborMessageSettings(document, storage);
    await expect(settings.start()).resolves.toBe(DEFAULT_MUTUAL_NEIGHBOR_MESSAGE);
    const input = document.querySelector<HTMLTextAreaElement>("#mutual-neighbor-default-message");
    const form = document.querySelector<HTMLFormElement>("#mutual-neighbor-message-form");
    if (input === null || form === null) throw new Error("Synthetic message form missing");
    input.value = "저장에 실패할 메시지";
    form.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector("#mutual-neighbor-message-notice")?.textContent).toContain(
      "저장하지 못했습니다",
    );
  });
});
