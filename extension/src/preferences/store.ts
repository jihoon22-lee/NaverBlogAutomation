import type { CommentLength } from "../api/types";
import {
  DEFAULT_GENERATION_PREFERENCES,
  isCommentLength,
  isCommentMood,
  isValidGenerationPreferences,
  type GenerationPreferences,
} from "./model";

// Keep the legacy key so existing V1/V2 choices migrate in place to the V3 default profile.
export const COMMENT_LENGTH_STORAGE_KEY = "commentLengthPreferenceV1";

export type StoredGenerationPreferences = GenerationPreferences;

interface StoredPreferenceV1 {
  length: CommentLength;
  schemaVersion: 1;
}

interface StoredPreferenceV3 {
  commentLength: GenerationPreferences["commentLength"];
  commentMood: GenerationPreferences["commentMood"];
  relationshipLevel: GenerationPreferences["relationshipLevel"];
  schemaVersion: 3;
  speechStyle: GenerationPreferences["speechStyle"];
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
      if (parsed?.schemaVersion === 3) return parsed.preferences;
      const preferences = parsed?.preferences ?? defaults();
      await this.#write(preferences);
      return preferences;
    });
  }

  save(preferences: StoredGenerationPreferences): Promise<void> {
    if (!isValidGenerationPreferences(preferences)) {
      return Promise.reject(new TypeError("Invalid persisted generation preferences"));
    }
    return this.#exclusive(() => this.#write(preferences));
  }

  #write(preferences: StoredGenerationPreferences): Promise<void> {
    return this.#storage.set({
      [COMMENT_LENGTH_STORAGE_KEY]: {
        commentLength: preferences.commentLength,
        commentMood: preferences.commentMood,
        relationshipLevel: preferences.relationshipLevel,
        schemaVersion: 3,
        speechStyle: preferences.speechStyle,
      } satisfies StoredPreferenceV3,
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
  return { ...DEFAULT_GENERATION_PREFERENCES };
}

function parseStoredPreferences(
  value: unknown,
): { preferences: StoredGenerationPreferences; schemaVersion: 1 | 2 | 3 } | null {
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
        relationshipLevel: DEFAULT_GENERATION_PREFERENCES.relationshipLevel,
        speechStyle: DEFAULT_GENERATION_PREFERENCES.speechStyle,
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
      preferences: {
        commentLength: value.length,
        commentMood: value.mood,
        relationshipLevel: DEFAULT_GENERATION_PREFERENCES.relationshipLevel,
        speechStyle: DEFAULT_GENERATION_PREFERENCES.speechStyle,
      },
      schemaVersion: 2,
    };
  }
  if (
    Object.keys(value).length === 5 &&
    "schemaVersion" in value &&
    value.schemaVersion === 3 &&
    "commentLength" in value &&
    "commentMood" in value &&
    "relationshipLevel" in value &&
    "speechStyle" in value
  ) {
    const preferences: GenerationPreferences = {
      commentLength: value.commentLength as GenerationPreferences["commentLength"],
      commentMood: value.commentMood as GenerationPreferences["commentMood"],
      relationshipLevel: value.relationshipLevel as GenerationPreferences["relationshipLevel"],
      speechStyle: value.speechStyle as GenerationPreferences["speechStyle"],
    };
    if (isValidGenerationPreferences(preferences)) {
      return { preferences, schemaVersion: 3 };
    }
  }
  return null;
}
