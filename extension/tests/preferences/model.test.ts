import { describe, expect, it } from "vitest";

import {
  DEFAULT_GENERATION_PREFERENCES,
  isValidGenerationPreferences,
  preferencesFromRequest,
  requestPreferenceFields,
} from "../../src/preferences/model";

describe("generation preferences", () => {
  it("uses the named API defaults when optional request fields are absent", () => {
    expect(
      preferencesFromRequest({
        body: "충분히 긴 합성 본문입니다.",
        source_url: "https://blog.naver.com/example/1",
        title: "합성 제목",
      }),
    ).toEqual(DEFAULT_GENERATION_PREFERENCES);
  });

  it("allows banmal only for a close relationship", () => {
    expect(
      isValidGenerationPreferences({
        commentLength: "long",
        commentMood: "lively",
        relationshipLevel: "close",
        speechStyle: "banmal",
      }),
    ).toBe(true);
    expect(
      isValidGenerationPreferences({
        commentLength: "long",
        commentMood: "warm",
        relationshipLevel: "friendly",
        speechStyle: "banmal",
      }),
    ).toBe(false);
  });

  it("maps the UI model to exact API field names", () => {
    expect(
      requestPreferenceFields({
        commentLength: "short",
        commentMood: "calm",
        relationshipLevel: "polite",
        speechStyle: "honorific",
      }),
    ).toEqual({
      comment_length: "short",
      comment_mood: "calm",
      relationship_level: "polite",
      speech_style: "honorific",
    });
  });
});
