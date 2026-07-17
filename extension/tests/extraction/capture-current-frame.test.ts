import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

import { captureCurrentFrame } from "../../src/extraction/capture-current-frame";
import { MAX_BODY_CODE_POINTS } from "../../src/extraction/normalize";
import { chooseCapturedPost } from "../../src/extraction/rank-captures";
import type { RawFrameCapture } from "../../src/extraction/types";

const fixtures = resolve(fileURLToPath(new URL("../fixtures", import.meta.url)));

async function capture(name: string, url: string): Promise<RawFrameCapture | null> {
  const html = await readFile(resolve(fixtures, name), "utf8");
  return captureMarkup(html, url);
}

async function captureMarkup(html: string, url: string): Promise<RawFrameCapture | null> {
  const dom = new JSDOM(html, { runScripts: "outside-only", url });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  try {
    return captureCurrentFrame();
  } finally {
    vi.unstubAllGlobals();
    dom.window.close();
  }
}

describe("captureCurrentFrame", () => {
  it("serializes without module closures", async () => {
    const html = await readFile(resolve(fixtures, "naver-modern.html"), "utf8");
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: "https://blog.naver.com/synthetic/1001",
    });

    const result = dom.window.eval(
      `(${captureCurrentFrame.toString()})()`,
    ) as RawFrameCapture | null;

    expect(result?.selectorKind).toBe("modern");
    dom.window.close();
  });

  it("captures the modern editor", async () => {
    const result = await capture(
      "naver-modern.html",
      "https://blog.naver.com/synthetic/1001?from=frame",
    );

    expect(result).not.toBeNull();
    expect(result?.selectorKind).toBe("modern");
    expect(result?.title).toBe("합성 전시 후기");
    expect(result?.canonicalUrl).toBe("https://blog.naver.com/synthetic/1001");
    expect(result?.body).toContain("빛과 그림자를 활용한 첫 번째 작품");
    expect(result?.body).toContain("관람 동선과 예약 방법");
    expect(result?.body).not.toContain("내비게이션");
    expect(result?.body).not.toContain("숨겨진 본문 표식");
    expect(result?.body).not.toContain("CSS로 숨긴 본문 표식");
    expect(result?.body).not.toContain("댓글 표식");
    expect(result?.body).not.toContain("관련 글");
  });

  it("supports the legacy editor and excludes replies and controls", async () => {
    const result = await capture("naver-legacy.html", "https://blog.naver.com/synthetic/2002");

    expect(result?.selectorKind).toBe("legacy");
    expect(result?.title).toBe("합성 여행 후기");
    expect(result?.body).toContain("해변 산책로");
    expect(result?.body).toContain("지역 시장");
    expect(result?.body).not.toContain("답글 표식");
    expect(result?.body).not.toContain("공유하기");
  });

  it("uses the semantic fallback for the mobile host", async () => {
    const result = await capture("naver-mobile.html", "https://m.blog.naver.com/synthetic/3003");

    expect(result?.selectorKind).toBe("semantic");
    expect(result?.title).toBe("합성 모바일 독서 기록");
    expect(result?.body).toContain("주인공의 선택");
    expect(result?.body).not.toContain("작성자 메뉴");
  });

  it("returns null for unsupported origins and navigation-only shells", async () => {
    expect(await capture("naver-modern.html", "https://example.com/post")).toBeNull();
    expect(await capture("shell-decoy.html", "https://blog.naver.com/synthetic")).toBeNull();
  });

  it("classifies an image-only article deterministically as empty_article", async () => {
    const url = "https://blog.naver.com/synthetic/image-only";
    const captured = await captureMarkup(
      `<!doctype html><html><head>
        <meta property="og:title" content="이미지 전용 합성 글" />
      </head><body><article>
        <figure><img src="synthetic.jpg" alt="본문을 대신하지 않는 합성 이미지 설명" /></figure>
      </article></body></html>`,
      url,
    );

    expect(captured).toBeNull();
    expect(
      chooseCapturedPost({ id: 41, title: "이미지 전용 합성 글", url }, [
        { frameId: 0, result: captured },
      ]),
    ).toEqual({ failure: { code: "empty_article" }, ok: false });
  });

  it("bounds a huge DOM body during injected extraction and preserves its original length", async () => {
    const hugeBody = `${"가".repeat(MAX_BODY_CODE_POINTS - 1)}😀나`;
    const result = await captureMarkup(
      `<!doctype html><html><body>
        <h1 class="se-title-text">대용량 합성 글</h1>
        <main class="se-main-container"><p>${hugeBody}</p></main>
      </body></html>`,
      "https://blog.naver.com/synthetic/huge",
    );

    expect(result?.originalLength).toBe(MAX_BODY_CODE_POINTS + 1);
    expect(Array.from(result?.body ?? "")).toHaveLength(MAX_BODY_CODE_POINTS);
    expect(result?.body.endsWith("😀")).toBe(true);
  });

  it("excludes nested decoys and keeps the title local to the selected article", async () => {
    const result = await captureMarkup(
      `<!doctype html><html><body>
        <section class="comment-area">
          <h1 class="se-title-text">제외할 댓글 제목</h1>
          <main class="se-main-container"><p>제외할 고신뢰도 댓글 본문입니다.</p></main>
        </section>
        <article>
          <h1>선택하지 않을 첫 글</h1>
          <p>짧은 첫 글 본문입니다.</p>
        </article>
        <article>
          <div class="reply-list"><h1 class="se-title-text">제외할 답글 제목</h1></div>
          <h1>선택한 두 번째 글</h1>
          <p>두 번째 글의 구체적인 경험과 감상을 충분히 길게 기록한 합성 본문입니다.</p>
        </article>
      </body></html>`,
      "https://blog.naver.com/synthetic/multiple",
    );

    expect(result?.selectorKind).toBe("semantic");
    expect(result?.title).toBe("선택한 두 번째 글");
    expect(result?.body).toContain("두 번째 글의 구체적인 경험");
    expect(result?.body).not.toContain("제외할 고신뢰도 댓글 본문");
    expect(result?.body).not.toContain("제외할 답글 제목");
    expect(result?.body).not.toContain("선택하지 않을 첫 글");
  });
});
