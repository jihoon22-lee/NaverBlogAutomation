import { describe, expect, it, vi } from "vitest";

import { type ApiError, LocalApiClient } from "../../src/app/api/client";

const CANDIDATES = [
  { id: "c1", tone: "warm", comment: "따뜻한 후보", referenced_detail: "근거1" },
  { id: "c2", tone: "curious", comment: "궁금한 후보?", referenced_detail: "근거2" },
  { id: "c3", tone: "supportive", comment: "응원하는 후보", referenced_detail: "근거3" },
];

const RECOMMENDATION = {
  id: "11111111-1111-4111-8111-111111111111",
  source_url: "https://blog.naver.com/example/1",
  title: "합성 제목",
  summary: "합성 요약",
  topics: ["전시"],
  candidates: CANDIDATES,
  selected_candidate_id: null,
  edited_comment: null,
  review_status: "drafted",
  relationship_level: "friendly",
  speech_style: "honorific",
  comment_length: "medium",
  comment_mood: "warm",
  quality_warnings: [],
};

const EXTRACTION = {
  source_url: "https://blog.naver.com/example/1",
  title: "합성 제목",
  selector_kind: "modern",
  original_length: 120,
  transmitted_length: 120,
  truncated: false,
  preview: "합성 본문",
};

const GENERATION = {
  attempt: 1,
  extraction: EXTRACTION,
  recommendation: RECOMMENDATION,
  replayed: false,
};

const SETTING = {
  kind: "closing_phrase",
  schema_version: 1,
  payload: { phrase: "감사합니다" },
  updated_at: "2026-07-31T00:00:00Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(handler: unknown): LocalApiClient {
  return new LocalApiClient({ fetch: handler as typeof fetch });
}

function calls(handler: { mock: { calls: unknown[][] } }, index = 0): unknown[] {
  return handler.mock.calls[index] as unknown[];
}

describe("generateComment", () => {
  it("sends only the options that were set", async () => {
    const handler = vi.fn(async () => jsonResponse(GENERATION));
    const client = clientWith(handler);

    await client.generateComment("https://blog.naver.com/example/1", {
      commentLength: "long",
      replace: true,
    });

    expect(calls(handler)[0]).toBe("/api/v1/automation/comments");
    expect(calls(handler)[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        url: "https://blog.naver.com/example/1",
        comment_length: "long",
        replace: true,
      }),
    });
  });

  it("sends every provided option in the contract shape", async () => {
    const handler = vi.fn(async () => jsonResponse(GENERATION));
    const client = clientWith(handler);

    await client.generateComment("https://blog.naver.com/example/1", {
      relationshipLevel: "close",
      speechStyle: "banmal",
      commentLength: "short",
      commentMood: "calm",
      personalizationMode: "completed_examples",
    });

    const body = JSON.parse(String((calls(handler)[1] as { body: string }).body));
    expect(body).toEqual({
      url: "https://blog.naver.com/example/1",
      relationship_level: "close",
      speech_style: "banmal",
      comment_length: "short",
      comment_mood: "calm",
      personalization_mode: "completed_examples",
    });
  });

  it("omits replace when it is false", async () => {
    const handler = vi.fn(async () => jsonResponse(GENERATION));

    await clientWith(handler).generateComment("https://blog.naver.com/example/1", {
      replace: false,
    });

    const body = JSON.parse(String((calls(handler)[1] as { body: string }).body));
    expect(body).toEqual({ url: "https://blog.naver.com/example/1" });
  });

  it("maps the generation into camel case", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(GENERATION)));

    const generation = await client.generateComment("https://blog.naver.com/example/1");

    expect(generation.attempt).toBe(1);
    expect(generation.recommendation.candidates).toHaveLength(3);
    expect(generation.recommendation.candidates[0]?.referencedDetail).toBe("근거1");
    expect(generation.extraction.transmittedLength).toBe(120);
  });

  it("keeps a stored selection and edited comment", async () => {
    const client = clientWith(
      vi.fn(async () =>
        jsonResponse({
          ...GENERATION,
          recommendation: {
            ...RECOMMENDATION,
            selected_candidate_id: "c2",
            edited_comment: "저장된 초안",
            review_status: "approved",
          },
        }),
      ),
    );

    const generation = await client.generateComment("https://blog.naver.com/example/1");

    expect(generation.recommendation.selectedCandidateId).toBe("c2");
    expect(generation.recommendation.editedComment).toBe("저장된 초안");
    expect(generation.recommendation.reviewStatus).toBe("approved");
  });

  it("maps quality warnings", async () => {
    const client = clientWith(
      vi.fn(async () =>
        jsonResponse({
          ...GENERATION,
          recommendation: { ...RECOMMENDATION, quality_warnings: ["candidates_too_similar"] },
        }),
      ),
    );

    const generation = await client.generateComment("https://blog.naver.com/example/1");

    expect(generation.recommendation.qualityWarnings).toEqual(["candidates_too_similar"]);
  });

  it("rejects an unknown quality warning", async () => {
    const client = clientWith(
      vi.fn(async () =>
        jsonResponse({
          ...GENERATION,
          recommendation: { ...RECOMMENDATION, quality_warnings: ["too_spicy"] },
        }),
      ),
    );

    await expect(client.generateComment("https://blog.naver.com/example/1")).rejects.toThrow(
      /quality_warnings/u,
    );
  });

  it("rejects a candidate list that is not exactly three", async () => {
    const client = clientWith(
      vi.fn(async () =>
        jsonResponse({
          ...GENERATION,
          recommendation: { ...RECOMMENDATION, candidates: CANDIDATES.slice(0, 2) },
        }),
      ),
    );

    await expect(client.generateComment("https://blog.naver.com/example/1")).rejects.toThrow(
      /candidates/u,
    );
  });

  it("rejects an unknown tone", async () => {
    const client = clientWith(
      vi.fn(async () =>
        jsonResponse({
          ...GENERATION,
          recommendation: {
            ...RECOMMENDATION,
            candidates: [{ ...CANDIDATES[0], tone: "grumpy" }, CANDIDATES[1], CANDIDATES[2]],
          },
        }),
      ),
    );

    await expect(client.generateComment("https://blog.naver.com/example/1")).rejects.toThrow(
      /tone/u,
    );
  });

  it("rejects an unknown review status", async () => {
    const client = clientWith(
      vi.fn(async () =>
        jsonResponse({
          ...GENERATION,
          recommendation: { ...RECOMMENDATION, review_status: "archived" },
        }),
      ),
    );

    await expect(client.generateComment("https://blog.naver.com/example/1")).rejects.toThrow(
      /review_status/u,
    );
  });

  it("surfaces the problem code for a replacement-worthy failure", async () => {
    const client = clientWith(
      vi.fn(async () =>
        jsonResponse(
          {
            code: "generation_indeterminate",
            detail: "이전 결과를 확인할 수 없습니다.",
            status: 409,
            title: "Generation indeterminate",
          },
          409,
        ),
      ),
    );

    const error = await client
      .generateComment("https://blog.naver.com/example/1")
      .catch((caught: unknown) => caught);

    expect((error as ApiError).code).toBe("generation_indeterminate");
  });
});

describe("generateCommentFanout", () => {
  it("sends the selected providers once and preserves partial provider outcomes", async () => {
    const handler = vi.fn(async () =>
      jsonResponse({
        attempt: 1,
        extraction: EXTRACTION,
        items: [
          {
            provider: "openai",
            model: "gpt-test",
            status: "succeeded",
            result_code: null,
            replayed: false,
            retry_after: null,
            recommendation: RECOMMENDATION,
          },
          {
            provider: "gemini",
            model: "gemini-test",
            status: "failed",
            result_code: "generation_refused",
            replayed: false,
            retry_after: null,
            recommendation: null,
          },
        ],
      }),
    );
    const client = clientWith(handler);

    const result = await client.generateCommentFanout("https://blog.naver.com/example/1", [
      { provider: "openai", model: "gpt-test" },
      { provider: "gemini" },
    ]);

    expect(calls(handler)[0]).toBe("/api/v1/automation/comments/fanout");
    expect(JSON.parse(String((calls(handler)[1] as { body: string }).body))).toMatchObject({
      url: "https://blog.naver.com/example/1",
      providers: [{ provider: "openai", model: "gpt-test" }, { provider: "gemini" }],
    });
    expect(result.items[0]?.recommendation?.title).toBe("합성 제목");
    expect(result.items[1]?.resultCode).toBe("generation_refused");
  });
});

describe("refineRecommendation", () => {
  it("sends the visible comment, explicit provider, and idempotency key", async () => {
    const handler = vi.fn(async () =>
      jsonResponse({ text: "더 자연스러운 댓글입니다.", provider: "openai", model: "gpt-test" }),
    );
    const client = clientWith(handler);

    const result = await client.refineRecommendation(RECOMMENDATION.id, {
      currentComment: "기존 댓글",
      preset: "natural",
      provider: "openai",
      idempotencyKey: "00000000-0000-4000-8000-000000000050",
    });

    expect(result.text).toBe("더 자연스러운 댓글입니다.");
    expect(calls(handler)[0]).toBe(`/api/v1/recommendations/${RECOMMENDATION.id}/refine`);
    expect(calls(handler)[1]).toMatchObject({
      headers: expect.any(Headers),
      method: "POST",
    });
    expect((calls(handler)[1] as { headers: Headers }).headers.get("Idempotency-Key")).toBe(
      "00000000-0000-4000-8000-000000000050",
    );
  });
});

describe("reviewRecommendation", () => {
  it("patches only the provided fields", async () => {
    const handler = vi.fn(async () =>
      jsonResponse({ ...RECOMMENDATION, review_status: "approved" }),
    );
    const client = clientWith(handler);

    const reviewed = await client.reviewRecommendation(RECOMMENDATION.id, {
      editedComment: "다듬은 댓글",
      reviewStatus: "approved",
      selectedCandidateId: "c1",
    });

    expect(calls(handler)[0]).toBe(`/api/v1/recommendations/${RECOMMENDATION.id}`);
    expect(calls(handler)[1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String((calls(handler)[1] as { body: string }).body))).toEqual({
      selected_candidate_id: "c1",
      edited_comment: "다듬은 댓글",
      review_status: "approved",
    });
    expect(reviewed.reviewStatus).toBe("approved");
  });

  it("sends an empty patch body when nothing was provided", async () => {
    const handler = vi.fn(async () => jsonResponse(RECOMMENDATION));

    await clientWith(handler).reviewRecommendation(RECOMMENDATION.id, {});

    expect(JSON.parse(String((calls(handler)[1] as { body: string }).body))).toEqual({});
  });
});

describe("app settings", () => {
  it("reads one settings record", async () => {
    const handler = vi.fn(async () => jsonResponse(SETTING));

    const record = await clientWith(handler).appSetting("closing_phrase");

    expect(calls(handler)[0]).toBe("/api/v1/settings/closing_phrase");
    expect(record.payload.phrase).toBe("감사합니다");
    expect(record.updatedAt).toBe("2026-07-31T00:00:00Z");
  });

  it("accepts a never-saved record", async () => {
    const handler = vi.fn(async () => jsonResponse({ ...SETTING, updated_at: null }));

    const record = await clientWith(handler).appSetting("closing_phrase");

    expect(record.updatedAt).toBeNull();
  });

  it("saves one settings record", async () => {
    const handler = vi.fn(async () => jsonResponse(SETTING));

    await clientWith(handler).saveAppSetting("closing_phrase", { phrase: "감사합니다" });

    expect(calls(handler)[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ payload: { phrase: "감사합니다" } }),
    });
  });

  it("rejects a non-object payload", async () => {
    const handler = vi.fn(async () => jsonResponse({ ...SETTING, payload: "text" }));

    await expect(clientWith(handler).appSetting("closing_phrase")).rejects.toThrow(/payload/u);
  });

  it("rejects a negative schema version", async () => {
    const handler = vi.fn(async () => jsonResponse({ ...SETTING, schema_version: -1 }));

    await expect(clientWith(handler).appSetting("closing_phrase")).rejects.toThrow(
      /schema_version/u,
    );
  });
});
