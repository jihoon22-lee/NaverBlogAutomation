import type { CommentLength } from "../api/types";
import {
  DEFAULT_COMMENT_PREFERENCES,
  isCommentLength,
  isCommentMood,
  isValidCommentPreferences,
  normalizeClosingPhrase,
  type CommentPreferences,
} from "./model";

// Keep the legacy key so existing V1/V2/V3 choices migrate in place to the V4 profile.
export const COMMENT_LENGTH_STORAGE_KEY = "commentLengthPreferenceV1";

export type StoredCommentPreferences = CommentPreferences;

interface StoredPreferenceV1 {
  length: CommentLength;
  schemaVersion: 1;
}

interface StoredPreferenceV4 {
  closingPhrase: string;
  commentLength: CommentPreferences["commentLength"];
  commentMood: CommentPreferences["commentMood"];
  relationshipLevel: CommentPreferences["relationshipLevel"];
  schemaVersion: 4;
  speechStyle: CommentPreferences["speechStyle"];
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
      if (parsed?.schemaVersion === 4) return parsed.preferences;
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
        relationshipLevel: preferences.relationshipLevel,
        schemaVersion: 4,
        speechStyle: preferences.speechStyle,
      } satisfies StoredPreferenceV4,
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
): { preferences: StoredCommentPreferences; schemaVersion: 1 | 2 | 3 | 4 } | null {
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
    };
    if (
      isValidCommentPreferences(preferences) &&
      preferences.closingPhrase === value.closingPhrase
    ) {
      return { preferences, schemaVersion: 4 };
    }
  }
  return null;
}
