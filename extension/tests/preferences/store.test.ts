import { describe, expect, it } from "vitest";

import type { CommentLength } from "../../src/api/types";
import {
  COMMENT_LENGTH_STORAGE_KEY,
  CommentLengthPreferenceStore,
  type PreferenceStorageArea,
} from "../../src/preferences/store";

class MemoryStorage implements PreferenceStorageArea {
  getFailure: Error | null = null;
  setFailure: Error | null = null;
  value: Record<string, unknown> = {};
  writes: Record<string, unknown>[] = [];

  async get(): Promise<Record<string, unknown>> {
    if (this.getFailure !== null) throw this.getFailure;
    return structuredClone(this.value);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.setFailure !== null) throw this.setFailure;
    this.writes.push(structuredClone(items));
    this.value = { ...this.value, ...structuredClone(items) };
  }
}

describe("CommentLengthPreferenceStore", () => {
  it("uses medium and warm when storage is absent or unreadable", async () => {
    await expect(new CommentLengthPreferenceStore(new MemoryStorage()).load()).resolves.toEqual({
      commentLength: "medium",
      commentMood: "warm",
    });
    const unreadable = new MemoryStorage();
    unreadable.getFailure = new Error("synthetic read failure");
    await expect(new CommentLengthPreferenceStore(unreadable).load()).resolves.toEqual({
      commentLength: "medium",
      commentMood: "warm",
    });
  });

  it("migrates the version 1 length record and defaults mood to warm", async () => {
    const storage = new MemoryStorage();
    storage.value[COMMENT_LENGTH_STORAGE_KEY] = { length: "long", schemaVersion: 1 };

    await expect(new CommentLengthPreferenceStore(storage).load()).resolves.toEqual({
      commentLength: "long",
      commentMood: "warm",
    });
    expect(storage.value[COMMENT_LENGTH_STORAGE_KEY]).toEqual({
      length: "long",
      mood: "warm",
      schemaVersion: 2,
    });
  });

  it("sanitizes malformed records and fails closed if sanitization cannot persist", async () => {
    const storage = new MemoryStorage();
    storage.value[COMMENT_LENGTH_STORAGE_KEY] = { mood: "unknown", schemaVersion: 2 };
    await expect(new CommentLengthPreferenceStore(storage).load()).resolves.toEqual({
      commentLength: "medium",
      commentMood: "warm",
    });
    expect(storage.value[COMMENT_LENGTH_STORAGE_KEY]).toEqual({
      length: "medium",
      mood: "warm",
      schemaVersion: 2,
    });

    const blocked = new MemoryStorage();
    blocked.value[COMMENT_LENGTH_STORAGE_KEY] = null;
    blocked.setFailure = new Error("synthetic write failure");
    await expect(new CommentLengthPreferenceStore(blocked).load()).rejects.toThrow(
      "synthetic write failure",
    );
  });

  it("persists only length and mood while preserving registry metadata", async () => {
    const storage = new MemoryStorage();
    storage.value.generationRegistryV1 = { entries: [], schemaVersion: 1 };
    const store = new CommentLengthPreferenceStore(storage);
    await store.save({ commentLength: "short", commentMood: "calm" });

    expect(storage.value.generationRegistryV1).toEqual({ entries: [], schemaVersion: 1 });
    expect(storage.value[COMMENT_LENGTH_STORAGE_KEY]).toEqual({
      length: "short",
      mood: "calm",
      schemaVersion: 2,
    });
    expect(JSON.stringify(storage.value[COMMENT_LENGTH_STORAGE_KEY])).not.toMatch(
      /relationship|speech|banmal|honorific|close|friendly|polite|new/u,
    );
  });

  it("serializes rapid writes so the last selected values win", async () => {
    const storage = new MemoryStorage();
    let release: (() => void) | undefined;
    storage.set = async (items): Promise<void> => {
      const length = (items[COMMENT_LENGTH_STORAGE_KEY] as { length: CommentLength }).length;
      if (length === "short") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      storage.value = { ...storage.value, ...structuredClone(items) };
    };
    const store = new CommentLengthPreferenceStore(storage);
    const first = store.save({ commentLength: "short", commentMood: "calm" });
    const second = store.save({ commentLength: "long", commentMood: "lively" });
    await Promise.resolve();
    release?.();
    await Promise.all([first, second]);

    expect(storage.value[COMMENT_LENGTH_STORAGE_KEY]).toEqual({
      length: "long",
      mood: "lively",
      schemaVersion: 2,
    });
  });
});
