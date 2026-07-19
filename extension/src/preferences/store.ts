import type { CommentLength } from "../api/types";
import { DEFAULT_GENERATION_PREFERENCES, isCommentLength } from "./model";

export const COMMENT_LENGTH_STORAGE_KEY = "commentLengthPreferenceV1";

interface StoredCommentLength {
  length: CommentLength;
  schemaVersion: 1;
}

export interface PreferenceStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class CommentLengthPreferenceStore {
  readonly #storage: PreferenceStorageArea;
  #pending: Promise<void> = Promise.resolve();

  constructor(storage: PreferenceStorageArea = chrome.storage.local) {
    this.#storage = storage;
  }

  load(): Promise<CommentLength> {
    return this.#exclusive(async () => {
      let raw: Record<string, unknown>;
      try {
        raw = await this.#storage.get(COMMENT_LENGTH_STORAGE_KEY);
      } catch {
        return DEFAULT_GENERATION_PREFERENCES.commentLength;
      }
      const stored = raw[COMMENT_LENGTH_STORAGE_KEY];
      if (stored === undefined) return DEFAULT_GENERATION_PREFERENCES.commentLength;
      const parsed = parseStoredLength(stored);
      if (parsed !== null) return parsed;
      const fallback = DEFAULT_GENERATION_PREFERENCES.commentLength;
      await this.#storage.set({
        [COMMENT_LENGTH_STORAGE_KEY]: { length: fallback, schemaVersion: 1 },
      });
      return fallback;
    });
  }

  save(length: CommentLength): Promise<void> {
    if (!isCommentLength(length)) {
      return Promise.reject(new TypeError("Invalid comment length"));
    }
    return this.#exclusive(() =>
      this.#storage.set({
        [COMMENT_LENGTH_STORAGE_KEY]: { length, schemaVersion: 1 } satisfies StoredCommentLength,
      }),
    );
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation, operation);
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function parseStoredLength(value: unknown): CommentLength | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("length" in value) ||
    !isCommentLength(value.length)
  ) {
    return null;
  }
  return value.length;
}
