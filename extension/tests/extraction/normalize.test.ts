import { describe, expect, it } from "vitest";

import {
  boundCodePoints,
  countCodePoints,
  normalizeExtractedText,
  normalizeRequestText,
} from "../../src/extraction/normalize";

describe("text normalization", () => {
  it("preserves meaningful extracted paragraphs", () => {
    expect(normalizeExtractedText(" 첫 문단  \n\n 둘째\t문단 ")).toBe("첫 문단\n둘째 문단");
    expect(normalizeRequestText(" 첫 문단  \n 둘째\t문단 ")).toBe("첫 문단 둘째 문단");
  });

  it("counts and bounds Unicode code points rather than UTF-16 units", () => {
    expect(countCodePoints("가😀나")).toBe(3);
    expect(boundCodePoints("가😀나", 2)).toEqual({
      originalLength: 3,
      text: "가😀",
      truncated: true,
    });
  });

  it("does not mark an exact bound as truncated", () => {
    expect(boundCodePoints("본문", 2)).toEqual({
      originalLength: 2,
      text: "본문",
      truncated: false,
    });
  });
});
