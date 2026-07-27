import { describe, expect, it } from "vitest";

import { parseSupportedNaverUrl, sameSupportedNaverPost } from "../../src/extraction/source-url";

describe("Naver source URL guard", () => {
  it.each([
    "https://blog.naver.com/synthetic/1001",
    "https://m.blog.naver.com/synthetic/1001?from=mobile",
    "https://blog.naver.com:443/synthetic/1001",
  ])("accepts an exact supported HTTPS origin: %s", (url) => {
    expect(parseSupportedNaverUrl(url)).toMatch(/^https:\/\/(?:m\.)?blog\.naver\.com\//u);
  });

  it.each([
    "http://blog.naver.com/synthetic/1001",
    "https://blog.naver.com.evil.example/synthetic/1001",
    "https://user@blog.naver.com/synthetic/1001",
    "https://blog.naver.com:444/synthetic/1001",
    "https://blog.naver.com/a b",
    "https://blog.naver.com/%zz",
    "https://blog.naver.com/%00",
    "https://blog.naver.com/%20",
  ])("rejects spoofed or unsafe URLs: %s", (url) => {
    expect(parseSupportedNaverUrl(url)).toBeNull();
  });

  it("rejects overlong URLs", () => {
    expect(parseSupportedNaverUrl(`https://blog.naver.com/${"a".repeat(2_100)}`)).toBeNull();
  });

  it("matches path and PostView URL shapes for the same post", () => {
    expect(
      sameSupportedNaverPost(
        "https://blog.naver.com/Candidate/123?trackingCode=feed",
        "https://m.blog.naver.com/PostView.naver?blogId=candidate&logNo=123&redirect=Dlog",
      ),
    ).toBe(true);
  });

  it.each([
    [
      "https://blog.naver.com/candidate/123",
      "https://blog.naver.com/PostView.naver?blogId=candidate&logNo=999",
    ],
    ["https://blog.naver.com/candidate", "https://blog.naver.com/other"],
    ["https://example.test/candidate/123", "https://blog.naver.com/candidate/123"],
  ])("does not match different or unsupported posts", (left, right) => {
    expect(sameSupportedNaverPost(left, right)).toBe(false);
  });
});
