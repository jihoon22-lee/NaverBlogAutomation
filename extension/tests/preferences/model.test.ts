import { describe, expect, it } from "vitest";

import {
  DEFAULT_GENERATION_PREFERENCES,
  appendClosingPhrase,
  isValidGenerationPreferences,
  normalizeClosingPhrase,
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
        personalizationMode: "completed_examples",
        relationshipLevel: "close",
        speechStyle: "banmal",
      }),
    ).toBe(true);
    expect(
      isValidGenerationPreferences({
        commentLength: "long",
        commentMood: "warm",
        personalizationMode: "completed_examples",
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
        personalizationMode: "off",
        relationshipLevel: "polite",
        speechStyle: "honorific",
      }),
    ).toEqual({
      comment_length: "short",
      comment_mood: "calm",
      personalization_mode: "off",
      relationship_level: "polite",
      speech_style: "honorific",
    });
  });

  it("normalizes and appends one bounded reusable closing phrase", () => {
    expect(normalizeClosingPhrase(`  좋은   하루예요 ${"가".repeat(60)}`)).toHaveLength(50);
    expect(appendClosingPhrase("본문 댓글", "  좋은   하루예요!  ")).toBe(
      "본문 댓글 좋은 하루예요!",
    );
    expect(appendClosingPhrase("본문 댓글 좋은 하루예요!", "좋은 하루예요!")).toBe(
      "본문 댓글 좋은 하루예요!",
    );
    expect(appendClosingPhrase("본문 댓글", "   ")).toBe("본문 댓글");
  });
});
