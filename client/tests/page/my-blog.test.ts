import { beforeEach, describe, expect, it } from "vitest";

import { probeCategoryPostList, probeMyBlogCategories } from "../../src/page/my-blog";
import { setBody } from "../fixtures/naver";

const CATEGORY_MENU = `
  <div id="category-list">
    <a href="https://blog.naver.com/PostList.naver?blogId=example&categoryNo=7">전시 후기 (12)</a>
    <a href="https://blog.naver.com/PostList.naver?blogId=example&categoryNo=8">일상 기록 (3,120)</a>
    <a href="https://blog.naver.com/PostList.naver?blogId=example&categoryNo=9">메모</a>
  </div>
`;

const POST_LIST = `
  <ul class="post-list">
    <li>
      <a href="https://blog.naver.com/PostView.naver?blogId=example&logNo=223456789012">
        첫 번째 전시 후기
      </a>
      <span class="date">2026. 7. 20.</span>
    </li>
    <li>
      <a href="https://blog.naver.com/example/223456789013">두 번째 기록</a>
      <span class="date">2026-06-05</span>
    </li>
  </ul>
`;

beforeEach(() => {
  setBody("");
});

describe("probeMyBlogCategories", () => {
  it("reports every category with its post count", () => {
    setBody(CATEGORY_MENU);

    const probe = probeMyBlogCategories();

    expect(probe.categories).toEqual([
      { categoryNo: 7, name: "전시 후기", postCount: 12 },
      { categoryNo: 8, name: "일상 기록", postCount: 3120 },
      { categoryNo: 9, name: "메모", postCount: null },
    ]);
    expect(probe.matchedKinds).toContain("category_link");
  });

  it("keeps the first name for a repeated category number", () => {
    setBody(`${CATEGORY_MENU}<a href="?categoryNo=7">전시 (99)</a>`);

    const names = probeMyBlogCategories().categories.map((category) => category.name);

    expect(names.filter((name) => name.startsWith("전시"))).toEqual(["전시 후기"]);
  });

  it("reports nothing for a page without categories", () => {
    setBody("<div><p>본문만 있는 문서</p></div>");

    const probe = probeMyBlogCategories();

    expect(probe.categories).toEqual([]);
    expect(probe.matchedKinds).toEqual([]);
  });

  it("skips a link without a usable label", () => {
    setBody(`<a href="?categoryNo=5">   </a>`);

    expect(probeMyBlogCategories().categories).toEqual([]);
  });

  it("skips a hidden category link", () => {
    setBody(`<a href="?categoryNo=5" hidden>숨은 카테고리</a>`);

    expect(probeMyBlogCategories().categories).toEqual([]);
  });

  it("ignores a non-numeric category value", () => {
    setBody(`<a href="?categoryNo=abc">잘못된 값</a>`);

    expect(probeMyBlogCategories().categories).toEqual([]);
  });
});

describe("probeCategoryPostList", () => {
  it("reports posts from both link shapes with their dates", () => {
    setBody(POST_LIST);

    const probe = probeCategoryPostList();

    expect(probe.posts).toEqual([
      {
        logNo: "223456789012",
        title: "첫 번째 전시 후기",
        publishedAt: "2026-07-20",
        url: "https://blog.naver.com/PostView.naver?blogId=example&logNo=223456789012",
      },
      {
        logNo: "223456789013",
        title: "두 번째 기록",
        publishedAt: "2026-06-05",
        url: "https://blog.naver.com/example/223456789013",
      },
    ]);
  });

  it("deduplicates one post that appears twice", () => {
    setBody(`${POST_LIST}<a href="?logNo=223456789012">같은 글 다시</a>`);

    expect(probeCategoryPostList().posts).toHaveLength(2);
  });

  it("reports no date when none is nearby", () => {
    setBody(`<a href="?logNo=223456789099">날짜 없는 글</a>`);

    expect(probeCategoryPostList().posts[0]?.publishedAt).toBeNull();
  });

  it("skips a link without a log number", () => {
    setBody(`<a href="https://blog.naver.com/example">블로그 홈</a>`);

    expect(probeCategoryPostList().posts).toEqual([]);
  });

  it("skips a link without a title", () => {
    setBody(`<a href="?logNo=223456789098">  </a>`);

    expect(probeCategoryPostList().posts).toEqual([]);
  });

  it("reports an empty list for a page without posts", () => {
    setBody("<div><p>글이 없습니다.</p></div>");

    const probe = probeCategoryPostList();

    expect(probe.posts).toEqual([]);
    expect(probe.categoryNo).toBeNull();
  });
});
