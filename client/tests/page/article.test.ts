import { beforeEach, describe, expect, it } from "vitest";

import { MAX_BODY_CODE_POINTS, captureArticle } from "../../src/page/article";
import { legacyPost, modernPost, setBody } from "../fixtures/naver";

beforeEach(() => {
  setBody("");
  document.title = "";
  document.head.innerHTML = "";
});

describe("captureArticle", () => {
  it("captures the modern editor container with its title", () => {
    setBody(modernPost({ body: "합성 본문입니다.", title: "합성 제목" }));

    const capture = captureArticle();

    expect(capture).not.toBeNull();
    expect(capture?.selectorKind).toBe("modern");
    expect(capture?.selectorConfidence).toBe(500);
    expect(capture?.title).toBe("합성 제목");
    expect(capture?.body).toContain("합성 본문입니다.");
  });

  it("captures the legacy container when the modern one is absent", () => {
    setBody(legacyPost({ body: "레거시 본문", title: "레거시 제목" }));

    const capture = captureArticle();

    expect(capture?.selectorKind).toBe("legacy");
    expect(capture?.title).toBe("레거시 제목");
  });

  it("prefers the higher-confidence container when both exist", () => {
    setBody(`${legacyPost({ body: "레거시" })}${modernPost({ body: "모던" })}`);

    const capture = captureArticle();

    expect(capture?.selectorKind).toBe("modern");
    expect(capture?.body).toContain("모던");
  });

  it("prefers the longer body when confidence ties", () => {
    setBody(`
      <div class="se-main-container"><p>짧음</p></div>
      <div class="se-main-container"><p>훨씬 더 긴 합성 본문 문장입니다.</p></div>
    `);

    const capture = captureArticle();

    expect(capture?.body).toContain("훨씬 더 긴");
  });

  it("returns null when no known container is present", () => {
    setBody("<div><p>본문 없음</p></div>");

    expect(captureArticle()).toBeNull();
  });

  it("returns null for an image-only container", () => {
    setBody('<div class="se-main-container"><img alt="" src="about:blank" /></div>');

    expect(captureArticle()).toBeNull();
  });

  it("excludes comment, share, and navigation regions", () => {
    setBody(`
      <div class="se-main-container">
        <p>본문 문장</p>
        <div class="comment_area"><p>댓글 내용</p></div>
        <div class="sns_share"><p>공유</p></div>
        <nav><p>내비게이션</p></nav>
      </div>
    `);

    const capture = captureArticle();

    expect(capture?.body).toContain("본문 문장");
    expect(capture?.body).not.toContain("댓글 내용");
    expect(capture?.body).not.toContain("공유");
    expect(capture?.body).not.toContain("내비게이션");
  });

  it("skips containers nested inside an excluded region", () => {
    setBody(
      '<div class="comment_area"><div class="se-main-container"><p>댓글 속 본문</p></div></div>',
    );

    expect(captureArticle()).toBeNull();
  });

  it("keeps paragraph breaks and collapses inline whitespace", () => {
    setBody(`
      <div class="se-main-container">
        <p>첫   문단</p>
        <p>둘째\t문단</p>
      </div>
    `);

    const capture = captureArticle();

    expect(capture?.body).toBe("첫 문단\n둘째 문단");
  });

  it("normalizes non-breaking spaces", () => {
    setBody('<div class="se-main-container"><p>공백\u00a0정규화</p></div>');

    expect(captureArticle()?.body).toBe("공백 정규화");
  });

  it("preserves emoji and surrogate pairs", () => {
    setBody('<div class="se-main-container"><p>이모지 👨‍👩‍👧‍👦 유지</p></div>');

    expect(captureArticle()?.body).toContain("👨‍👩‍👧‍👦");
  });

  it("reports the original length while bounding the retained text", () => {
    const long = "가".repeat(MAX_BODY_CODE_POINTS + 25);
    setBody(`<div class="se-main-container"><p>${long}</p></div>`);

    const capture = captureArticle();

    expect(capture?.originalLength).toBe(MAX_BODY_CODE_POINTS + 25);
    expect(Array.from(capture?.body ?? "").length).toBe(MAX_BODY_CODE_POINTS);
  });

  it("falls back to the og:title meta tag when no title element exists", () => {
    document.head.innerHTML = '<meta property="og:title" content="메타 제목" />';
    setBody("<article><p>본문</p></article>");

    expect(captureArticle()?.title).toBe("메타 제목");
  });

  it("falls back to the document title when no metadata exists", () => {
    document.title = "문서 제목";
    setBody("<article><p>본문</p></article>");

    expect(captureArticle()?.title).toBe("문서 제목");
  });

  it("reads the canonical link when present", () => {
    document.head.innerHTML =
      '<link rel="canonical" href="https://blog.naver.com/example/223456789012" />';
    setBody(modernPost());

    expect(captureArticle()?.canonicalUrl).toBe("https://blog.naver.com/example/223456789012");
  });

  it("falls back to og:url and then to null", () => {
    document.head.innerHTML =
      '<meta property="og:url" content="https://blog.naver.com/example/1" />';
    setBody(modernPost());
    expect(captureArticle()?.canonicalUrl).toBe("https://blog.naver.com/example/1");

    document.head.innerHTML = "";
    setBody(modernPost());
    expect(captureArticle()?.canonicalUrl).toBeNull();
  });

  it("finds a title in a preceding sibling when the container has none", () => {
    setBody(`
      <div class="post_wrap">
        <div class="header"><h1>형제 제목</h1></div>
        <div class="se-main-container"><p>본문</p></div>
      </div>
    `);

    expect(captureArticle()?.title).toBe("형제 제목");
  });

  it("reports the document url so the caller can validate the host", () => {
    setBody(modernPost());

    expect(captureArticle()?.documentUrl).toContain("blog.naver.com");
  });

  it("uses the semantic fallback for unknown markup", () => {
    setBody('<div role="main"><p>시맨틱 본문</p></div>');

    const capture = captureArticle();

    expect(capture?.selectorKind).toBe("semantic");
    expect(capture?.selectorConfidence).toBe(220);
  });
});
