import { describe, expect, it, vi } from "vitest";

import { ApiClientError, LocalApiClient } from "../../src/api/client";

const recommendation = {
  candidates: [
    {
      comment: "따뜻한 합성 댓글입니다.",
      id: "00000000-0000-4000-8000-000000000011",
      referenced_detail: "합성 본문의 전시 동선",
      tone: "warm",
    },
    {
      comment: "궁금한 점을 담은 합성 댓글입니다.",
      id: "00000000-0000-4000-8000-000000000012",
      referenced_detail: "합성 본문의 작품 설명",
      tone: "curious",
    },
    {
      comment: "응원하는 합성 댓글입니다.",
      id: "00000000-0000-4000-8000-000000000013",
      referenced_detail: "합성 본문의 다음 방문 계획",
      tone: "supportive",
    },
  ],
  created_at: "2026-07-17T00:00:00Z",
  edited_comment: null,
  id: "00000000-0000-4000-8000-000000000010",
  review_status: "drafted",
  selected_candidate_id: null,
  source_url: "https://blog.naver.com/synthetic/10",
  summary: "합성 전시와 관람 동선을 정리한 글",
  title: "합성 전시 후기",
  topics: ["전시", "동선"],
  updated_at: null,
};
const firstCandidate = recommendation.candidates[0];
if (firstCandidate === undefined) {
  throw new Error("Synthetic candidate fixture is missing");
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function problem(code: string, status: number, headers: Record<string, string> = {}): Response {
  return json(
    {
      code,
      detail: "Synthetic safe detail.",
      request_id: "00000000-0000-4000-8000-000000000099",
      status,
      title: "Synthetic problem",
      type: "about:blank",
    },
    { headers: { "Content-Type": "application/problem+json", ...headers }, status },
  );
}

describe("LocalApiClient", () => {
  it("invokes a browser-native fetch with the global receiver", async () => {
    const fetcher = vi.fn(function (this: unknown): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(json({ status: "ok" }));
    }) as unknown as typeof fetch;

    await expect(new LocalApiClient(fetcher).health()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("connects health, create, GET, and PATCH with typed payloads", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ status: "ok" }))
      .mockResolvedValueOnce(
        json(recommendation, { headers: { "Idempotency-Replayed": "false" }, status: 201 }),
      )
      .mockResolvedValueOnce(json(recommendation))
      .mockResolvedValueOnce(
        json({
          ...recommendation,
          edited_comment: "편집한 합성 댓글",
          review_status: "approved",
          selected_candidate_id: firstCandidate.id,
        }),
      );
    const client = new LocalApiClient(fetcher);

    await client.health();
    const created = await client.createRecommendation(
      {
        body: "전시 동선과 작품을 충분히 설명한 합성 본문입니다.",
        source_url: recommendation.source_url,
        title: recommendation.title,
      },
      "00000000-0000-4000-8000-000000000001",
    );
    await client.getRecommendation(recommendation.id);
    const approved = await client.reviewRecommendation(recommendation.id, {
      edited_comment: "편집한 합성 댓글",
      review_status: "approved",
      selected_candidate_id: firstCandidate.id,
    });

    expect(created.replayed).toBe(false);
    expect(created.value).toMatchObject({
      commentLength: "medium",
      commentMood: "warm",
      qualityWarnings: [],
      relationshipLevel: "friendly",
      speechStyle: "honorific",
    });
    expect(created.value.candidates[0]?.referencedDetail).toBe("합성 본문의 전시 동선");
    expect(approved.reviewStatus).toBe("approved");
    expect(fetcher.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        credentials: "omit",
        headers: expect.objectContaining({
          "Idempotency-Key": "00000000-0000-4000-8000-000000000001",
        }),
        method: "POST",
      }),
    );
    expect(fetcher.mock.calls[2]?.[0]).toContain(`/recommendations/${recommendation.id}`);
    expect(fetcher.mock.calls[3]?.[1]).toEqual(expect.objectContaining({ method: "PATCH" }));
  });

  it("treats a 200 replay like a successful create and reads the exposed header", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json(recommendation, { headers: { "Idempotency-Replayed": "true" }, status: 200 }),
      );
    const result = await new LocalApiClient(fetcher).createRecommendation(
      {
        body: "충분히 긴 합성 본문을 작성했습니다.",
        source_url: recommendation.source_url,
        title: recommendation.title,
      },
      "00000000-0000-4000-8000-000000000002",
    );
    expect(result).toMatchObject({ replayed: true, value: { id: recommendation.id } });
  });

  it("parses all preference fields when the new backend emits them", async () => {
    const withPreferences = {
      ...recommendation,
      comment_length: "long",
      comment_mood: "lively",
      quality_warnings: ["length_target_missed", "candidates_too_similar"],
      relationship_level: "close",
      speech_style: "banmal",
    };
    const client = new LocalApiClient(
      vi.fn<typeof fetch>().mockResolvedValue(json(withPreferences)),
    );

    await expect(client.getRecommendation(recommendation.id)).resolves.toMatchObject({
      commentLength: "long",
      commentMood: "lively",
      qualityWarnings: ["length_target_missed", "candidates_too_similar"],
      relationshipLevel: "close",
      speechStyle: "banmal",
    });
  });

  it("rejects partial, null, unknown, and invalid preference response fields", async () => {
    const invalidPreferences = [
      { comment_length: "long" },
      { comment_length: "long", relationship_level: "close" },
      { comment_length: null, relationship_level: "close", speech_style: "banmal" },
      { comment_length: "huge", relationship_level: "close", speech_style: "banmal" },
      { comment_length: "medium", relationship_level: "friendly", speech_style: "banmal" },
      {
        comment_length: "medium",
        comment_mood: null,
        relationship_level: "friendly",
        speech_style: "honorific",
      },
      {
        comment_length: "medium",
        comment_mood: "dramatic",
        relationship_level: "friendly",
        speech_style: "honorific",
      },
      { quality_warnings: ["unknown_warning"] },
      { quality_warnings: ["length_target_missed", "length_target_missed"] },
      { quality_warnings: null },
    ];
    for (const preferences of invalidPreferences) {
      const client = new LocalApiClient(
        vi.fn<typeof fetch>().mockResolvedValue(json({ ...recommendation, ...preferences })),
      );
      await expect(client.getRecommendation(recommendation.id)).rejects.toBeInstanceOf(
        ApiClientError,
      );
    }
  });

  it("parses problem+json, replay, and Retry-After headers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      problem("generation_rate_limited", 429, {
        "Idempotency-Replayed": "true",
        "Retry-After": "12",
      }),
    );
    const client = new LocalApiClient(fetcher);
    const caught = await client
      .createRecommendation(
        {
          body: "충분히 긴 합성 본문을 작성했습니다.",
          source_url: recommendation.source_url,
          title: recommendation.title,
        },
        "00000000-0000-4000-8000-000000000003",
      )
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ApiClientError);
    expect(caught).toMatchObject({
      problem: { code: "generation_rate_limited" },
      replayed: true,
      retryAfterSeconds: 12,
      status: 429,
    });
  });

  it("rejects schema drift, foreign selected candidates, and non-problem errors", async () => {
    const invalidResponses = [
      json({ ...recommendation, unexpected: true }),
      json({ ...recommendation, selected_candidate_id: "00000000-0000-4000-8000-000000000098" }),
      json(recommendation, { status: 202 }),
      new Response("failure", { status: 500, headers: { "Content-Type": "text/plain" } }),
    ];
    for (const response of invalidResponses) {
      const client = new LocalApiClient(vi.fn<typeof fetch>().mockResolvedValue(response));
      await expect(client.getRecommendation(recommendation.id)).rejects.toBeInstanceOf(
        ApiClientError,
      );
    }
  });

  it("wraps network failures without exposing raw error text", async () => {
    const client = new LocalApiClient(
      vi.fn<typeof fetch>().mockRejectedValue(new Error("private network detail")),
    );
    const error = await client.health().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as Error).message).not.toContain("private network detail");
  });
});
