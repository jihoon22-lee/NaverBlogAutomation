import type { CommentLength } from "../api/types";
import {
  DEFAULT_COMMENT_PREFERENCES,
  isCommentLength,
  isCommentMood,
  isValidCommentPreferences,
  normalizeClosingPhrase,
  type CommentPreferences,
} from "./model";

// Keep the legacy key so existing choices migrate in place to the V5 profile.
export const COMMENT_LENGTH_STORAGE_KEY = "commentLengthPreferenceV1";

export type StoredCommentPreferences = CommentPreferences;

interface StoredPreferenceV1 {
  length: CommentLength;
  schemaVersion: 1;
}

interface StoredPreferenceV5 extends CommentPreferences {
  schemaVersion: 5;
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

  load(): Promise<StoredCommentPreferences> {
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
      if (parsed?.schemaVersion === 5) return parsed.preferences;
      const preferences = parsed?.preferences ?? defaults();
      await this.#write(preferences);
      return preferences;
    });
  }

  save(preferences: StoredCommentPreferences): Promise<void> {
    if (!isValidCommentPreferences(preferences)) {
      return Promise.reject(new TypeError("Invalid persisted comment preferences"));
    }
    return this.#exclusive(() => this.#write(preferences));
  }

  #write(preferences: StoredCommentPreferences): Promise<void> {
    return this.#storage.set({
      [COMMENT_LENGTH_STORAGE_KEY]: {
        closingPhrase: preferences.closingPhrase,
        commentLength: preferences.commentLength,
        commentMood: preferences.commentMood,
        personalizationMode: preferences.personalizationMode,
        relationshipLevel: preferences.relationshipLevel,
        schemaVersion: 5,
        speechStyle: preferences.speechStyle,
      } satisfies StoredPreferenceV5,
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

function defaults(): StoredCommentPreferences {
  return { ...DEFAULT_COMMENT_PREFERENCES };
}

function parseStoredPreferences(
  value: unknown,
): { preferences: StoredCommentPreferences; schemaVersion: 1 | 2 | 3 | 4 | 5 } | null {
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
        closingPhrase: "",
        commentLength: legacy.length,
        commentMood: DEFAULT_COMMENT_PREFERENCES.commentMood,
        relationshipLevel: DEFAULT_COMMENT_PREFERENCES.relationshipLevel,
        speechStyle: DEFAULT_COMMENT_PREFERENCES.speechStyle,
        personalizationMode: DEFAULT_COMMENT_PREFERENCES.personalizationMode,
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
        closingPhrase: "",
        commentLength: value.length,
        commentMood: value.mood,
        relationshipLevel: DEFAULT_COMMENT_PREFERENCES.relationshipLevel,
        speechStyle: DEFAULT_COMMENT_PREFERENCES.speechStyle,
        personalizationMode: DEFAULT_COMMENT_PREFERENCES.personalizationMode,
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
    const preferences: CommentPreferences = {
      closingPhrase: "",
      commentLength: value.commentLength as CommentPreferences["commentLength"],
      commentMood: value.commentMood as CommentPreferences["commentMood"],
      relationshipLevel: value.relationshipLevel as CommentPreferences["relationshipLevel"],
      speechStyle: value.speechStyle as CommentPreferences["speechStyle"],
      personalizationMode: DEFAULT_COMMENT_PREFERENCES.personalizationMode,
    };
    if (isValidCommentPreferences(preferences)) {
      return { preferences, schemaVersion: 3 };
    }
  }
  if (
    Object.keys(value).length === 6 &&
    "schemaVersion" in value &&
    value.schemaVersion === 4 &&
    "closingPhrase" in value &&
    typeof value.closingPhrase === "string" &&
    "commentLength" in value &&
    "commentMood" in value &&
    "relationshipLevel" in value &&
    "speechStyle" in value
  ) {
    const preferences: CommentPreferences = {
      closingPhrase: normalizeClosingPhrase(value.closingPhrase),
      commentLength: value.commentLength as CommentPreferences["commentLength"],
      commentMood: value.commentMood as CommentPreferences["commentMood"],
      relationshipLevel: value.relationshipLevel as CommentPreferences["relationshipLevel"],
      speechStyle: value.speechStyle as CommentPreferences["speechStyle"],
      personalizationMode: DEFAULT_COMMENT_PREFERENCES.personalizationMode,
    };
    if (
      isValidCommentPreferences(preferences) &&
      preferences.closingPhrase === value.closingPhrase
    ) {
      return { preferences, schemaVersion: 4 };
    }
  }
  if (
    Object.keys(value).length === 7 &&
    "schemaVersion" in value &&
    value.schemaVersion === 5 &&
    "closingPhrase" in value &&
    typeof value.closingPhrase === "string" &&
    "commentLength" in value &&
    "commentMood" in value &&
    "personalizationMode" in value &&
    "relationshipLevel" in value &&
    "speechStyle" in value
  ) {
    const preferences: CommentPreferences = {
      closingPhrase: normalizeClosingPhrase(value.closingPhrase),
      commentLength: value.commentLength as CommentPreferences["commentLength"],
      commentMood: value.commentMood as CommentPreferences["commentMood"],
      personalizationMode: value.personalizationMode as CommentPreferences["personalizationMode"],
      relationshipLevel: value.relationshipLevel as CommentPreferences["relationshipLevel"],
      speechStyle: value.speechStyle as CommentPreferences["speechStyle"],
    };
    if (
      isValidCommentPreferences(preferences) &&
      preferences.closingPhrase === value.closingPhrase
    ) {
      return { preferences, schemaVersion: 5 };
    }
  }
  return null;
}
