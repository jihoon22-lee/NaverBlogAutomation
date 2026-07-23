import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { CreateRecommendationRequest } from "../../src/api/types";

import {
  CanonicalPayloadError,
  canonicalRequestJson,
  normalizePythonWhitespace,
  requestDigest,
} from "../../src/idempotency/canonical";

describe("canonical request identity", () => {
  it("matches every shared Python preference-aware hash vector", async () => {
    const path = new URL(
      "../../../tests/contract/generation-request-hash-vectors.json",
      import.meta.url,
    );
    const vectors = JSON.parse(await readFile(path, "utf8")) as Array<{
      expected_hash: string;
      id: string;
      request: CreateRecommendationRequest;
    }>;

    for (const vector of vectors) {
      await expect(requestDigest(vector.request), vector.id).resolves.toBe(vector.expected_hash);
    }
  });

  it.each([
    {
      expected: "a8a3ad58c064d0df0a09600782f1839ed7f15312d42c0c68291255a186028513",
      payload: {
        body: "푸른\u00a0조각과 😀 작품을\n 자세히 소개한 합성 본문입니다.",
        source_url: " https://blog.naver.com/example/1 ",
        title: " 주말\n전시\t후기 ",
      },
    },
    {
      expected: "1e9ad5abbf0070df4ede9f00e0cbfc8f27f7939666151cb5ed87ad93e4c4de66",
      payload: {
        body: "\ufeff앞뒤 FEFF는 Python에서 유지되는 충분히 긴 합성 본문입니다.\ufeff",
        source_url: "https://m.blog.naver.com/example/2",
        title: "\ufeff제목\ufeff",
      },
    },
    {
      expected: "055b65bd208aa1bf36e88e4b191f11249dbf0825aa49875be4a834dd678a3bdb",
      payload: {
        body: "A\u001cB\u0085C\u2028D\u3000E 문자를 포함한 충분히 긴 합성 본문입니다.",
        source_url: "https://blog.naver.com/example/3",
        title: "Unicode 공백",
      },
    },
  ])("matches the Python 3.14 SHA-256 vector $expected", async ({ expected, payload }) => {
    expect(await requestDigest(payload)).toBe(expected);
  });

  it("serializes normalized keys in Python sort order", () => {
    expect(
      canonicalRequestJson({
        body: " 충분히 긴 합성 본문 내용을 작성합니다. ",
        source_url: " https://blog.naver.com/example/4 ",
        title: " 합성 제목 ",
      }),
    ).toBe(
      '{"body":"충분히 긴 합성 본문 내용을 작성합니다.","source_url":"https://blog.naver.com/example/4","title":"합성 제목"}',
    );
    expect(normalizePythonWhitespace("\ufeff 제목 \ufeff")).toBe("\ufeff 제목 \ufeff");
  });

  it("rejects lone surrogates and invalid normalized lengths", async () => {
    const base = {
      body: "충분히 긴 합성 본문 내용을 작성합니다.",
      source_url: "https://blog.naver.com/example/5",
      title: "합성 제목",
    };
    await expect(requestDigest({ ...base, body: `${base.body}\ud800` })).rejects.toBeInstanceOf(
      CanonicalPayloadError,
    );
    expect(() => canonicalRequestJson({ ...base, body: " 짧음 " })).toThrow(CanonicalPayloadError);
  });

  it("rejects banmal outside a close relationship before hashing", async () => {
    await expect(
      requestDigest({
        body: "충분한 길이의 합성 본문 내용을 여기에 작성했습니다.",
        relationship_level: "friendly",
        source_url: "https://blog.naver.com/example/6",
        speech_style: "banmal",
        title: "합성 제목",
      }),
    ).rejects.toBeInstanceOf(CanonicalPayloadError);
  });

  it.each([
    "comment_length",
    "comment_mood",
    "personalization_mode",
    "relationship_level",
    "speech_style",
  ] as const)("rejects explicit null for %s instead of applying a default", async (field) => {
    const payload = {
      body: "충분한 길이의 합성 본문 내용을 여기에 작성했습니다.",
      source_url: "https://blog.naver.com/example/7",
      title: "합성 제목",
      [field]: null,
    } as unknown as CreateRecommendationRequest;

    await expect(requestDigest(payload)).rejects.toBeInstanceOf(CanonicalPayloadError);
  });
});
