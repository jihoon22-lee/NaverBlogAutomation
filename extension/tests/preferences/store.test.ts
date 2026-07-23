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
  it("uses safe generation and personalization defaults when storage is absent or unreadable", async () => {
    await expect(new CommentLengthPreferenceStore(new MemoryStorage()).load()).resolves.toEqual({
      closingPhrase: "",
      commentLength: "medium",
      commentMood: "warm",
      relationshipLevel: "friendly",
      speechStyle: "honorific",
      personalizationMode: "completed_examples",
    });
    const unreadable = new MemoryStorage();
    unreadable.getFailure = new Error("synthetic read failure");
    await expect(new CommentLengthPreferenceStore(unreadable).load()).resolves.toEqual({
      closingPhrase: "",
      commentLength: "medium",
      commentMood: "warm",
      relationshipLevel: "friendly",
      speechStyle: "honorific",
      personalizationMode: "completed_examples",
    });
  });

  it("migrates the version 1 length record and defaults mood to warm", async () => {
    const storage = new MemoryStorage();
    storage.value[COMMENT_LENGTH_STORAGE_KEY] = { length: "long", schemaVersion: 1 };

    await expect(new CommentLengthPreferenceStore(storage).load()).resolves.toEqual({
      closingPhrase: "",
      commentLength: "long",
      commentMood: "warm",
      relationshipLevel: "friendly",
      speechStyle: "honorific",
      personalizationMode: "completed_examples",
    });
    expect(storage.value[COMMENT_LENGTH_STORAGE_KEY]).toEqual({
      closingPhrase: "",
      commentLength: "long",
      commentMood: "warm",
      relationshipLevel: "friendly",
      schemaVersion: 5,
      speechStyle: "honorific",
      personalizationMode: "completed_examples",
    });
  });

  it("sanitizes malformed records and fails closed if sanitization cannot persist", async () => {
    const storage = new MemoryStorage();
    storage.value[COMMENT_LENGTH_STORAGE_KEY] = { mood: "unknown", schemaVersion: 2 };
    await expect(new CommentLengthPreferenceStore(storage).load()).resolves.toEqual({
      closingPhrase: "",
      commentLength: "medium",
      commentMood: "warm",
      relationshipLevel: "friendly",
      speechStyle: "honorific",
      personalizationMode: "completed_examples",
    });
    expect(storage.value[COMMENT_LENGTH_STORAGE_KEY]).toEqual({
      closingPhrase: "",
      commentLength: "medium",
      commentMood: "warm",
      relationshipLevel: "friendly",
      schemaVersion: 5,
      speechStyle: "honorific",
      personalizationMode: "completed_examples",
    });

    const blocked = new MemoryStorage();
    blocked.value[COMMENT_LENGTH_STORAGE_KEY] = null;
    blocked.setFailure = new Error("synthetic write failure");
    await expect(new CommentLengthPreferenceStore(blocked).load()).rejects.toThrow(
      "synthetic write failure",
    );
  });

  it("persists a validated default profile while preserving registry metadata", async () => {
    const storage = new MemoryStorage();
    storage.value.generationRegistryV1 = { entries: [], schemaVersion: 1 };
    const store = new CommentLengthPreferenceStore(storage);
    await store.save({
      closingPhrase: "좋은 하루 보내세요!",
      commentLength: "short",
      commentMood: "calm",
      relationshipLevel: "close",
      speechStyle: "banmal",
      personalizationMode: "completed_examples",
    });

    expect(storage.value.generationRegistryV1).toEqual({ entries: [], schemaVersion: 1 });
    expect(storage.value[COMMENT_LENGTH_STORAGE_KEY]).toEqual({
      closingPhrase: "좋은 하루 보내세요!",
      commentLength: "short",
      commentMood: "calm",
      relationshipLevel: "close",
      schemaVersion: 5,
      speechStyle: "banmal",
      personalizationMode: "completed_examples",
    });
  });

  it("migrates a valid version 3 profile with an empty closing phrase", async () => {
    const storage = new MemoryStorage();
    storage.value[COMMENT_LENGTH_STORAGE_KEY] = {
      commentLength: "short",
      commentMood: "calm",
      relationshipLevel: "close",
      schemaVersion: 3,
      speechStyle: "banmal",
    };

    await expect(new CommentLengthPreferenceStore(storage).load()).resolves.toEqual({
      closingPhrase: "",
      commentLength: "short",
      commentMood: "calm",
      relationshipLevel: "close",
      speechStyle: "banmal",
      personalizationMode: "completed_examples",
    });
    expect(storage.value[COMMENT_LENGTH_STORAGE_KEY]).toEqual({
      closingPhrase: "",
      commentLength: "short",
      commentMood: "calm",
      relationshipLevel: "close",
      schemaVersion: 5,
      speechStyle: "banmal",
      personalizationMode: "completed_examples",
    });
    expect(storage.writes).toHaveLength(1);
  });

  it("migrates a valid version 4 profile to the version 5 personalization default", async () => {
    const storage = new MemoryStorage();
    storage.value[COMMENT_LENGTH_STORAGE_KEY] = {
      closingPhrase: "오늘도 좋은 하루 보내세요!",
      commentLength: "medium",
      commentMood: "warm",
      relationshipLevel: "friendly",
      schemaVersion: 4,
      speechStyle: "honorific",
    };

    await expect(new CommentLengthPreferenceStore(storage).load()).resolves.toMatchObject({
      closingPhrase: "오늘도 좋은 하루 보내세요!",
      personalizationMode: "completed_examples",
    });
    expect(storage.writes).toHaveLength(1);
  });

  it("loads a valid version 5 profile without rewriting its personalization choice", async () => {
    const storage = new MemoryStorage();
    storage.value[COMMENT_LENGTH_STORAGE_KEY] = {
      closingPhrase: "스타일 예시 없이 작성해요.",
      commentLength: "medium",
      commentMood: "warm",
      personalizationMode: "off",
      relationshipLevel: "friendly",
      schemaVersion: 5,
      speechStyle: "honorific",
    };

    await expect(new CommentLengthPreferenceStore(storage).load()).resolves.toMatchObject({
      personalizationMode: "off",
    });
    expect(storage.writes).toHaveLength(0);
  });

  it("replaces a version 5 profile with an invalid personalization mode", async () => {
    const storage = new MemoryStorage();
    storage.value[COMMENT_LENGTH_STORAGE_KEY] = {
      closingPhrase: "",
      commentLength: "medium",
      commentMood: "warm",
      personalizationMode: "unknown",
      relationshipLevel: "friendly",
      schemaVersion: 5,
      speechStyle: "honorific",
    };

    await expect(new CommentLengthPreferenceStore(storage).load()).resolves.toMatchObject({
      personalizationMode: "completed_examples",
    });
    expect(storage.writes).toHaveLength(1);
  });

  it("replaces a non-canonical or oversized closing phrase with safe defaults", async () => {
    const storage = new MemoryStorage();
    storage.value[COMMENT_LENGTH_STORAGE_KEY] = {
      closingPhrase: `  ${"가".repeat(51)}  `,
      commentLength: "medium",
      commentMood: "warm",
      relationshipLevel: "friendly",
      schemaVersion: 4,
      speechStyle: "honorific",
    };

    await expect(new CommentLengthPreferenceStore(storage).load()).resolves.toEqual({
      closingPhrase: "",
      commentLength: "medium",
      commentMood: "warm",
      relationshipLevel: "friendly",
      speechStyle: "honorific",
      personalizationMode: "completed_examples",
    });
    expect(storage.writes).toHaveLength(1);
  });

  it("replaces an invalid version 3 relationship and speech combination with safe defaults", async () => {
    const storage = new MemoryStorage();
    storage.value[COMMENT_LENGTH_STORAGE_KEY] = {
      commentLength: "long",
      commentMood: "lively",
      relationshipLevel: "friendly",
      schemaVersion: 3,
      speechStyle: "banmal",
    };

    await expect(new CommentLengthPreferenceStore(storage).load()).resolves.toEqual({
      closingPhrase: "",
      commentLength: "medium",
      commentMood: "warm",
      relationshipLevel: "friendly",
      speechStyle: "honorific",
      personalizationMode: "completed_examples",
    });
    expect(storage.writes).toHaveLength(1);
  });

  it("serializes rapid writes so the last selected values win", async () => {
    const storage = new MemoryStorage();
    let release: (() => void) | undefined;
    storage.set = async (items): Promise<void> => {
      const length = (items[COMMENT_LENGTH_STORAGE_KEY] as { commentLength: CommentLength })
        .commentLength;
      if (length === "short") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      storage.value = { ...storage.value, ...structuredClone(items) };
    };
    const store = new CommentLengthPreferenceStore(storage);
    const first = store.save({
      closingPhrase: "첫 문구",
      commentLength: "short",
      commentMood: "calm",
      relationshipLevel: "new",
      speechStyle: "honorific",
      personalizationMode: "completed_examples",
    });
    const second = store.save({
      closingPhrase: "마지막 문구",
      commentLength: "long",
      commentMood: "lively",
      relationshipLevel: "close",
      speechStyle: "banmal",
      personalizationMode: "completed_examples",
    });
    await Promise.resolve();
    release?.();
    await Promise.all([first, second]);

    expect(storage.value[COMMENT_LENGTH_STORAGE_KEY]).toEqual({
      closingPhrase: "마지막 문구",
      commentLength: "long",
      commentMood: "lively",
      relationshipLevel: "close",
      schemaVersion: 5,
      speechStyle: "banmal",
      personalizationMode: "completed_examples",
    });
  });
});
