import type { CommentLength, CommentMood } from "../api/types";
import { DEFAULT_GENERATION_PREFERENCES, isCommentLength, isCommentMood } from "./model";

// Keep the legacy key so existing length choices migrate in place to the V2 length+mood record.
export const COMMENT_LENGTH_STORAGE_KEY = "commentLengthPreferenceV1";

export interface StoredGenerationPreferences {
  readonly commentLength: CommentLength;
  readonly commentMood: CommentMood;
}

interface StoredPreferenceV1 {
  length: CommentLength;
  schemaVersion: 1;
}

interface StoredPreferenceV2 {
  length: CommentLength;
  mood: CommentMood;
  schemaVersion: 2;
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

  load(): Promise<StoredGenerationPreferences> {
    return this.#exclusive(async () => {
      let raw: Record<string, unknown>;
      try {
        raw = await this.#storage.get(COMMENT_LENGTH_STORAGE_KEY);
      } catch {
        return defaults();
      }
      const stored = raw[COMMENT_LENGTH_STORAGE_KEY];
      if (stored === undefined) return defaults();
      const parsed = parseStoredPreferences(stored);
      if (parsed?.schemaVersion === 2) return parsed.preferences;
      const preferences = parsed?.preferences ?? defaults();
      await this.#write(preferences);
      return preferences;
    });
  }

  save(preferences: StoredGenerationPreferences): Promise<void> {
    if (!isCommentLength(preferences.commentLength) || !isCommentMood(preferences.commentMood)) {
      return Promise.reject(new TypeError("Invalid persisted generation preferences"));
    }
    return this.#exclusive(() => this.#write(preferences));
  }

  #write(preferences: StoredGenerationPreferences): Promise<void> {
    return this.#storage.set({
      [COMMENT_LENGTH_STORAGE_KEY]: {
        length: preferences.commentLength,
        mood: preferences.commentMood,
        schemaVersion: 2,
      } satisfies StoredPreferenceV2,
    });
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

function defaults(): StoredGenerationPreferences {
  return {
    commentLength: DEFAULT_GENERATION_PREFERENCES.commentLength,
    commentMood: DEFAULT_GENERATION_PREFERENCES.commentMood,
  };
}

function parseStoredPreferences(
  value: unknown,
): { preferences: StoredGenerationPreferences; schemaVersion: 1 | 2 } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (
    Object.keys(value).length === 2 &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "length" in value &&
    isCommentLength(value.length)
  ) {
    const legacy = value as StoredPreferenceV1;
    return {
      preferences: {
        commentLength: legacy.length,
        commentMood: DEFAULT_GENERATION_PREFERENCES.commentMood,
      },
      schemaVersion: 1,
    };
  }
  if (
    Object.keys(value).length === 3 &&
    "schemaVersion" in value &&
    value.schemaVersion === 2 &&
    "length" in value &&
    isCommentLength(value.length) &&
    "mood" in value &&
    isCommentMood(value.mood)
  ) {
    return {
      preferences: { commentLength: value.length, commentMood: value.mood },
      schemaVersion: 2,
    };
  }
  return null;
}
