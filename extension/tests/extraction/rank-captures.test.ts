import { describe, expect, it } from "vitest";

import { MAX_BODY_CODE_POINTS } from "../../src/extraction/normalize";
import { chooseCapturedPost } from "../../src/extraction/rank-captures";
import type { ActiveTab, FrameExecution, RawFrameCapture } from "../../src/extraction/types";

const tab: ActiveTab = {
  id: 17,
  title: "합성 탭 제목",
  url: "https://blog.naver.com/synthetic/1001",
};

function capture(overrides: Partial<RawFrameCapture> = {}): RawFrameCapture {
  return {
    body: "합성 글의 핵심 경험과 구체적인 감상을 충분한 길이로 정리한 본문입니다.",
    canonicalUrl: "https://blog.naver.com/synthetic/1001",
    frameUrl: "https://blog.naver.com/PostView.naver?blogId=synthetic&logNo=1001",
    originalLength: 37,
    selectorConfidence: 500,
    selectorKind: "modern",
    title: "합성 글 제목",
    ...overrides,
  };
}

function frame(frameId: number, overrides: Partial<RawFrameCapture> = {}): FrameExecution {
  return { documentId: `document-${frameId}`, frameId, result: capture(overrides) };
}

describe("frame ranking", () => {
  it("prefers selector confidence over a longer semantic shell", () => {
    const result = chooseCapturedPost(tab, [
      frame(0, {
        body: "길지만 의미 없는 shell 본문 ".repeat(20),
        selectorConfidence: 220,
        selectorKind: "semantic",
        title: "Shell",
      }),
      frame(3),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview.frameId).toBe(3);
      expect(result.preview.documentId).toBe("document-3");
      expect(result.preview.title).toBe("합성 글 제목");
    }
  });

  it("is deterministic when Chrome returns frames in a different order", () => {
    const first = frame(7, { canonicalUrl: null });
    const second = frame(2, { canonicalUrl: null });

    const result = chooseCapturedPost(tab, [first, second]);

    expect(result.ok && result.preview.frameId).toBe(2);
  });

  it("rejects external canonical URLs and falls back to the active tab URL", () => {
    const result = chooseCapturedPost(tab, [
      frame(1, { canonicalUrl: "https://blog.naver.com.evil.example/post" }),
    ]);

    expect(result.ok && result.preview.sourceUrl).toBe(tab.url);
  });

  it("bounds over-limit content by Unicode code points and discloses truncation", () => {
    const body = `${"가".repeat(MAX_BODY_CODE_POINTS - 1)}😀나`;
    const result = chooseCapturedPost(tab, [frame(1, { body })]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.from(result.preview.body)).toHaveLength(MAX_BODY_CODE_POINTS);
      expect(result.preview.originalLength).toBe(MAX_BODY_CODE_POINTS + 1);
      expect(result.preview.transmittedLength).toBe(MAX_BODY_CODE_POINTS);
      expect(result.preview.truncated).toBe(true);
      expect(result.preview.body.endsWith("😀")).toBe(true);
    }
  });

  it("preserves the extractor's original length when its transmitted body is already bounded", () => {
    const body = `${"가".repeat(MAX_BODY_CODE_POINTS - 1)}😀`;
    const result = chooseCapturedPost(tab, [
      frame(1, { body, originalLength: MAX_BODY_CODE_POINTS + 7 }),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview.originalLength).toBe(MAX_BODY_CODE_POINTS + 7);
      expect(result.preview.transmittedLength).toBe(MAX_BODY_CODE_POINTS);
      expect(result.preview.truncated).toBe(true);
      expect(result.preview.body.endsWith("😀")).toBe(true);
    }
  });

  it("classifies unsupported, empty, short, and title-less captures", () => {
    expect(chooseCapturedPost({ ...tab, url: "https://example.com/post" }, [frame(1)])).toEqual({
      failure: { code: "unsupported_url" },
      ok: false,
    });
    expect(chooseCapturedPost(tab, [{ frameId: 1, result: null }])).toEqual({
      failure: { code: "empty_article" },
      ok: false,
    });
    expect(chooseCapturedPost(tab, [frame(1, { body: "짧은 본문" })])).toEqual({
      failure: { code: "short_article" },
      ok: false,
    });
    expect(chooseCapturedPost({ ...tab, title: "" }, [frame(1, { title: "" })])).toEqual({
      failure: { code: "extraction_failed" },
      ok: false,
    });
  });

  it("ignores captures from unsupported frame origins", () => {
    expect(
      chooseCapturedPost(tab, [frame(1, { frameUrl: "https://example.com/embedded" })]),
    ).toEqual({ failure: { code: "empty_article" }, ok: false });
  });
});
