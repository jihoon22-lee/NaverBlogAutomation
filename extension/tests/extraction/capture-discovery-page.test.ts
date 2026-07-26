import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureDiscoveryPage } from "../../src/extraction/capture-discovery-page";

afterEach(() => vi.unstubAllGlobals());

describe("captureDiscoveryPage", () => {
  it("collects bounded public blog profiles and post links from the user-opened page", () => {
    const dom = new JSDOM(
      `
      <a href="https://blog.naver.com/friend">친한 이웃</a>
      <a href="https://blog.naver.com/friend/123">여행 후기</a>
      <a href="https://blog.naver.com/PostView.naver?blogId=other&logNo=456">다른 글</a>
      <a href="https://example.com/nope">제외</a>
    `,
      { url: "https://search.naver.com/search.naver" },
    );
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);

    expect(captureDiscoveryPage()).toEqual({
      blogs: [{ blogId: "friend", blogUrl: "https://blog.naver.com/friend", name: "친한 이웃" }],
      posts: [
        { publisherName: null, sourceUrl: "https://blog.naver.com/friend/123", title: "여행 후기" },
        {
          publisherName: null,
          sourceUrl: "https://blog.naver.com/PostView.naver?blogId=other&logNo=456",
          title: "다른 글",
        },
      ],
    });
  });

  it("fails closed for malformed, non-Naver, and empty anchors", () => {
    const dom = new JSDOM(
      `<a href="https://example.com/a">외부</a><a href="https://blog.naver.com/only-id"></a>`,
      { url: "https://search.naver.com/search.naver" },
    );
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);

    expect(captureDiscoveryPage()).toEqual({ blogs: [], posts: [] });
  });

  it("extracts a nearby Gregorian publication date when the opened result exposes one", () => {
    const dom = new JSDOM(
      `<article><a href="https://blog.naver.com/friend/123">여행 후기</a><time>2026. 07. 25.</time></article>`,
      { url: "https://search.naver.com/search.naver" },
    );
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);

    expect(captureDiscoveryPage().posts).toEqual([
      {
        publisherName: null,
        sourceUrl: "https://blog.naver.com/friend/123",
        title: "여행 후기",
        publishedAt: "2026-07-25T00:00:00.000Z",
      },
    ]);
  });
});
