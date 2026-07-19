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
  pending: (() => void) | null = null;
  value: Record<string, unknown> = {};
  writes: Record<string, unknown>[] = [];

  async get(): Promise<Record<string, unknown>> {
    if (this.getFailure !== null) {
      throw this.getFailure;
    }
    return structuredClone(this.value);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.setFailure !== null) throw this.setFailure;
    this.writes.push(structuredClone(items));
    this.value = { ...this.value, ...structuredClone(items) };
  }
}

describe("CommentLengthPreferenceStore", () => {
  it.each([
    undefined,
    null,
    "long",
    { length: "unknown", schemaVersion: 1 },
    { length: "long", relationship: "close", schemaVersion: 1 },
  ])("falls back to medium for absent or malformed storage: %j", async (stored) => {
    const storage = new MemoryStorage();
    if (stored !== undefined) {
      storage.value[COMMENT_LENGTH_STORAGE_KEY] = stored;
    }

    await expect(new CommentLengthPreferenceStore(storage).load()).resolves.toBe("medium");
    if (stored !== undefined) {
      expect(storage.value[COMMENT_LENGTH_STORAGE_KEY]).toEqual({
        length: "medium",
        schemaVersion: 1,
      });
    }
  });

  it("falls back to medium when storage cannot be read", async () => {
    const storage = new MemoryStorage();
    storage.getFailure = new Error("synthetic read failure");

    await expect(new CommentLengthPreferenceStore(storage).load()).resolves.toBe("medium");
  });

  it("fails closed when malformed storage cannot be sanitized", async () => {
    const storage = new MemoryStorage();
    storage.value[COMMENT_LENGTH_STORAGE_KEY] = { length: "unknown", schemaVersion: 1 };
    storage.setFailure = new Error("synthetic write failure");

    await expect(new CommentLengthPreferenceStore(storage).load()).rejects.toThrow(
      "synthetic write failure",
    );
  });

  it("persists only length and preserves unrelated registry metadata", async () => {
    const storage = new MemoryStorage();
    storage.value.generationRegistryV1 = { entries: [], schemaVersion: 1 };
    const store = new CommentLengthPreferenceStore(storage);

    await store.save("long");

    expect(storage.value.generationRegistryV1).toEqual({ entries: [], schemaVersion: 1 });
    expect(storage.value[COMMENT_LENGTH_STORAGE_KEY]).toEqual({ length: "long", schemaVersion: 1 });
    expect(JSON.stringify(storage.value[COMMENT_LENGTH_STORAGE_KEY])).not.toMatch(
      /relationship|speech|banmal|honorific|close|friendly|polite|new/u,
    );
  });

  it("serializes rapid writes so the last selected length wins", async () => {
    const storage = new MemoryStorage();
    let release: (() => void) | undefined;
    storage.set = async (items): Promise<void> => {
      const length = (items[COMMENT_LENGTH_STORAGE_KEY] as { length: CommentLength }).length;
      if (length === "short") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      storage.writes.push(structuredClone(items));
      storage.value = { ...storage.value, ...structuredClone(items) };
    };
    const store = new CommentLengthPreferenceStore(storage);

    const first = store.save("short");
    const second = store.save("long");
    await Promise.resolve();
    release?.();
    await Promise.all([first, second]);

    expect((storage.value[COMMENT_LENGTH_STORAGE_KEY] as { length: string }).length).toBe("long");
  });
});
