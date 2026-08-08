import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../src/app/api/client";
import type {
  AppSettingRecord,
  ArticleExtraction,
  CommentGeneration,
  Recommendation,
} from "../../src/app/api/types";
import { CommentController } from "../../src/app/controllers/comment";

const EXTRACTION: ArticleExtraction = {
  sourceUrl: "https://blog.naver.com/example/1",
  title: "합성 전시 후기",
  selectorKind: "modern",
  originalLength: 200,
  transmittedLength: 180,
  truncated: true,
  preview: "합성 본문 preview",
};

function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    sourceUrl: EXTRACTION.sourceUrl,
    title: EXTRACTION.title,
    summary: "합성 요약",
    topics: ["전시"],
    candidates: [
      { id: "c1", tone: "warm", comment: "따뜻한 후보", referencedDetail: "근거1" },
      { id: "c2", tone: "curious", comment: "궁금한 후보?", referencedDetail: "근거2" },
      { id: "c3", tone: "supportive", comment: "응원하는 후보", referencedDetail: "근거3" },
    ],
    selectedCandidateId: null,
    editedComment: null,
    reviewStatus: "drafted",
    relationshipLevel: "friendly",
    speechStyle: "honorific",
    commentLength: "medium",
    commentMood: "warm",
    qualityWarnings: [],
    ...overrides,
  };
}

function generation(overrides: Partial<CommentGeneration> = {}): CommentGeneration {
  return {
    attempt: 1,
    extraction: EXTRACTION,
    recommendation: recommendation(),
    replayed: false,
    ...overrides,
  };
}

function setting(phrase: string): AppSettingRecord {
  return { kind: "closing_phrase", schemaVersion: 1, payload: { phrase }, updatedAt: null };
}

function api(overrides: Record<string, unknown> = {}) {
  return {
    appSetting: vi.fn(async () => setting("")),
    generateComment: vi.fn(async () => generation()),
    generateCommentFanout: vi.fn(async () => ({
      attempt: 1,
      extraction: EXTRACTION,
      items: [
        {
          provider: "openai" as const,
          model: "gpt-test",
          status: "succeeded" as const,
          resultCode: null,
          replayed: false,
          retryAfter: null,
          recommendation: recommendation(),
        },
        {
          provider: "gemini" as const,
          model: "gemini-test",
          status: "failed" as const,
          resultCode: "generation_refused",
          replayed: false,
          retryAfter: null,
          recommendation: null,
        },
      ],
    })),
    llmProviders: vi.fn(async () => [
      { provider: "openai" as const, configured: true, model: "gpt-test" },
    ]),
    recommendation: vi.fn(async () => recommendation()),
    reviewRecommendation: vi.fn(async () => recommendation({ reviewStatus: "approved" })),
    refineRecommendation: vi.fn(async () => ({
      text: "더 자연스러운 댓글",
      provider: "openai" as const,
      model: "gpt-test",
    })),
    ...overrides,
  };
}

function root(): Element {
  document.body.innerHTML = '<main id="workspace"></main>';
  return document.getElementById("workspace") as Element;
}

function text(selector: string): string {
  return document.querySelector(selector)?.textContent ?? "";
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("preview", () => {
  it("shows the capture metadata before generating", () => {
    const controller = new CommentController(root(), { api: api() as never });

    controller.open(EXTRACTION);

    expect(text("#preview-title")).toBe("합성 전시 후기");
    expect(text(".preview-body")).toContain("합성 본문");
    expect(text("#comment-status")).toContain("본문을 확인");
    expect(document.querySelector(".candidates-panel")).toBeNull();
  });

  it("renders nothing beyond the status without an extraction", () => {
    const controller = new CommentController(root(), { api: api() as never });

    controller.render();

    expect(document.querySelector(".preview-panel")).toBeNull();
    expect(text("#comment-status")).toContain("선택하세요");
  });

  it("loads the saved closing phrase", async () => {
    const client = api({ appSetting: vi.fn(async () => setting("감사합니다")) });
    const controller = new CommentController(root(), { api: client as never });
    controller.open(EXTRACTION);

    await controller.loadClosingPhrase();

    expect(controller.state.closingPhrase).toBe("감사합니다");
  });

  it("shows the saved mutual-neighbour message before the search-result final action", async () => {
    const controller = new CommentController(root(), {
      api: api({
        appSetting: vi.fn(async (kind: string) =>
          kind === "neighbor_message"
            ? {
                kind,
                schemaVersion: 1,
                payload: { message: "좋은 이웃이 되고 싶어요." },
                updatedAt: null,
              }
            : setting(""),
        ),
      }) as never,
    });
    controller.open(EXTRACTION, "post-1", "search");
    await controller.loadClosingPhrase();
    await controller.generate();

    expect(text(".mutual-neighbor-message")).toContain("좋은 이웃이 되고 싶어요.");
    expect(document.getElementById("execute-comment-button")?.textContent).toContain(
      "서로이웃 신청",
    );
  });

  it("falls back to an empty phrase when settings cannot be read", async () => {
    const controller = new CommentController(root(), {
      api: api({
        appSetting: vi.fn(async () => {
          throw new ApiError("nope");
        }),
      }) as never,
    });

    await controller.loadClosingPhrase();

    expect(controller.state.closingPhrase).toBe("");
  });
});

describe("generation", () => {
  it("renders three candidates and seeds the draft", async () => {
    const controller = new CommentController(root(), { api: api() as never });
    controller.open(EXTRACTION);

    await controller.generate();

    expect(document.querySelectorAll(".candidate-item")).toHaveLength(3);
    expect((document.getElementById("comment-draft") as HTMLTextAreaElement).value).toBe(
      "따뜻한 후보",
    );
    expect(text(".draft-count")).toContain("/ 500자");
  });

  it("updates the local route owner after generation and restores a saved recommendation", async () => {
    const onRecommendationReady = vi.fn();
    const controller = new CommentController(root(), {
      api: api() as never,
      onRecommendationReady,
    });
    controller.open(EXTRACTION, "post-1", "neighbor");

    await controller.generate();

    expect(onRecommendationReady).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "post-1",
      "neighbor",
    );

    await controller.restore("11111111-1111-4111-8111-111111111111", "post-1", "neighbor");

    expect(controller.state.phase).toBe("review");
    expect(controller.state.extraction?.preview).toBe("합성 요약");
    expect(document.getElementById("execute-comment-button")).not.toBeNull();
  });

  it("compares configured providers only after the user requests the extra calls", async () => {
    const client = api({
      llmProviders: vi.fn(async () => [
        { provider: "openai" as const, configured: true, model: "gpt-test" },
        { provider: "gemini" as const, configured: true, model: "gemini-test" },
      ]),
    });
    const controller = new CommentController(root(), { api: client as never });
    controller.open(EXTRACTION);
    await controller.loadClosingPhrase();

    (document.getElementById("compare-providers-button") as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(client.generateCommentFanout).toHaveBeenCalledWith(
      EXTRACTION.sourceUrl,
      [
        { provider: "openai", model: "gpt-test" },
        { provider: "gemini", model: "gemini-test" },
      ],
      {},
    );
    expect(text(".provider-comparison")).toContain("generation_refused");
  });

  it("sends only the options the user chose", async () => {
    const client = api();
    const controller = new CommentController(root(), { api: client as never });
    controller.open(EXTRACTION);

    document
      .querySelector('.option-choice[data-option="comment_length"][data-value="long"]')
      ?.dispatchEvent(new MouseEvent("click"));
    await controller.generate();

    expect(client.generateComment).toHaveBeenCalledWith(EXTRACTION.sourceUrl, {
      commentLength: "long",
    });
  });

  it("marks the chosen option as pressed", () => {
    const controller = new CommentController(root(), { api: api() as never });
    controller.open(EXTRACTION);

    document
      .querySelector('.option-choice[data-option="comment_mood"][data-value="calm"]')
      ?.dispatchEvent(new MouseEvent("click"));

    const choice = document.querySelector(
      '.option-choice[data-option="comment_mood"][data-value="calm"]',
    );
    expect(choice?.getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores an unknown option name", () => {
    const controller = new CommentController(root(), { api: api() as never });
    controller.open(EXTRACTION);
    const before = controller.state.options;

    controller.render();

    expect(controller.state.options).toBe(before);
  });

  it("reports a replayed result", async () => {
    const controller = new CommentController(root(), {
      api: api({ generateComment: vi.fn(async () => generation({ replayed: true })) }) as never,
    });
    controller.open(EXTRACTION);

    await controller.generate();

    expect(text("#comment-status")).toContain("이미 생성한 결과");
  });

  it("renders quality warnings", async () => {
    const controller = new CommentController(root(), {
      api: api({
        generateComment: vi.fn(async () =>
          generation({
            recommendation: recommendation({ qualityWarnings: ["candidates_too_similar"] }),
          }),
        ),
      }) as never,
    });
    controller.open(EXTRACTION);

    await controller.generate();

    expect(text(".quality-warnings")).toContain("서로 비슷");
  });

  it("shows a problem detail for a rejected generation", async () => {
    const controller = new CommentController(root(), {
      api: api({
        generateComment: vi.fn(async () => {
          throw new ApiError("rejected", {
            problem: {
              code: "short_article",
              detail: "본문이 너무 짧아 댓글을 생성할 수 없습니다.",
              status: 422,
              title: "Article extraction failed",
            },
            status: 422,
          });
        }),
      }) as never,
    });
    controller.open(EXTRACTION);

    await controller.generate();

    expect(text("#comment-status")).toContain("너무 짧아");
    expect(document.getElementById("replace-button")).toBeNull();
  });

  it.each(["generation_timeout", "generation_indeterminate", "generation_in_progress"])(
    "requires an explicit replacement after %s",
    async (code) => {
      const controller = new CommentController(root(), {
        api: api({
          generateComment: vi.fn(async () => {
            throw new ApiError("unknown", {
              problem: { code, detail: "이전 결과를 확인할 수 없습니다.", status: 409, title: "t" },
              status: 409,
            });
          }),
        }) as never,
      });
      controller.open(EXTRACTION);

      await controller.generate();

      expect(controller.state.phase).toBe("needs_replacement");
      expect(document.getElementById("replace-button")).not.toBeNull();
      expect(text(".replacement-panel")).toContain("중복 생성");
    },
  );

  it("sends replace only when the user approves it", async () => {
    const client = api();
    const controller = new CommentController(root(), { api: client as never });
    controller.open(EXTRACTION);

    await controller.generate({ replace: true });

    expect(client.generateComment).toHaveBeenCalledWith(EXTRACTION.sourceUrl, { replace: true });
  });

  it("ignores a concurrent generation", async () => {
    const client = api();
    const controller = new CommentController(root(), { api: client as never });
    controller.open(EXTRACTION);

    await Promise.all([controller.generate(), controller.generate()]);

    expect(client.generateComment).toHaveBeenCalledTimes(1);
  });

  it("does nothing without an open post", async () => {
    const client = api();
    const controller = new CommentController(root(), { api: client as never });

    const result = await controller.generate();

    expect(result).toBeNull();
    expect(client.generateComment).not.toHaveBeenCalled();
  });
});

describe("candidate selection and editing", () => {
  it("replaces the draft when another candidate is chosen", async () => {
    const controller = new CommentController(root(), { api: api() as never });
    controller.open(EXTRACTION);
    await controller.generate();

    const [, , third] = Array.from(document.querySelectorAll(".candidate-item"));
    (third as HTMLButtonElement).click();

    expect((document.getElementById("comment-draft") as HTMLTextAreaElement).value).toBe(
      "응원하는 후보",
    );
    expect(text(".candidate-reference")).toContain("근거3");
  });

  it("appends the closing phrase on selection", async () => {
    const controller = new CommentController(root(), {
      api: api({ appSetting: vi.fn(async () => setting("감사합니다")) }) as never,
    });
    controller.open(EXTRACTION);
    await controller.loadClosingPhrase();
    await controller.generate();

    (document.querySelectorAll(".candidate-item")[1] as HTMLButtonElement).click();

    expect(controller.state.draft).toBe("궁금한 후보? 감사합니다");
    expect(text(".closing-phrase")).toContain("감사합니다");
  });

  it("keeps manual edits in state", async () => {
    const controller = new CommentController(root(), { api: api() as never });
    controller.open(EXTRACTION);
    await controller.generate();

    const editor = document.getElementById("comment-draft") as HTMLTextAreaElement;
    editor.value = "직접 다듬은 댓글";
    editor.dispatchEvent(new Event("input"));

    expect(controller.state.draft).toBe("직접 다듬은 댓글");
  });
});

describe("AI comment refinement", () => {
  it("replaces the visible draft with one explicit quick refinement", async () => {
    const client = api();
    const controller = new CommentController(root(), { api: client as never });
    controller.open(EXTRACTION, "post-1", "neighbor");
    await controller.generate();

    await controller.refine("natural", "");

    expect(controller.state.draft).toBe("더 자연스러운 댓글");
    expect(client.refineRecommendation).toHaveBeenCalledWith(
      recommendation().id,
      expect.objectContaining({ currentComment: "따뜻한 후보", preset: "natural" }),
    );
    expect(text(".refinement-status")).toContain("다듬었습니다");
  });

  it("reuses the same refinement key after a timeout so the service can replay it", async () => {
    const client = api({
      refineRecommendation: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError("timeout", {
            problem: {
              code: "generation_timeout",
              detail: "제한 시간 초과",
              status: 504,
              title: "Timeout",
            },
            status: 504,
          }),
        )
        .mockResolvedValueOnce({ text: "재사용 결과", provider: "openai", model: "gpt-test" }),
    });
    const controller = new CommentController(root(), { api: client as never });
    controller.open(EXTRACTION);
    await controller.generate();

    await controller.refine("natural", "");
    await controller.refine("natural", "");

    const calls = (client.refineRecommendation as { mock: { calls: unknown[][] } }).mock.calls;
    const [first, second] = calls;
    if (first === undefined || second === undefined) throw new Error("missing refinement calls");
    expect((first[1] as { idempotencyKey: string }).idempotencyKey).toBe(
      (second[1] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(controller.state.draft).toBe("재사용 결과");
  });
});

describe("approval", () => {
  it("stores the selected candidate and the draft", async () => {
    const client = api();
    const controller = new CommentController(root(), { api: client as never });
    controller.open(EXTRACTION);
    await controller.generate();

    const reviewed = await controller.approve();

    expect(client.reviewRecommendation).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { editedComment: "따뜻한 후보", reviewStatus: "approved", selectedCandidateId: "c1" },
    );
    expect(reviewed?.reviewStatus).toBe("approved");
  });

  it("disables approval for an empty draft", async () => {
    const controller = new CommentController(root(), { api: api() as never });
    controller.open(EXTRACTION);
    await controller.generate();

    const editor = document.getElementById("comment-draft") as HTMLTextAreaElement;
    editor.value = "   ";
    editor.dispatchEvent(new Event("input"));
    controller.render();

    expect((document.getElementById("approve-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses to approve before generation", async () => {
    const client = api();
    const controller = new CommentController(root(), { api: client as never });
    controller.open(EXTRACTION);

    expect(await controller.approve()).toBeNull();
    expect(client.reviewRecommendation).not.toHaveBeenCalled();
  });

  it("reports a review conflict", async () => {
    const controller = new CommentController(root(), {
      api: api({
        reviewRecommendation: vi.fn(async () => {
          throw new ApiError("conflict", {
            problem: {
              code: "review_conflict",
              detail: "저장된 상태와 충돌합니다.",
              status: 409,
              title: "Conflict",
            },
            status: 409,
          });
        }),
      }) as never,
    });
    controller.open(EXTRACTION);
    await controller.generate();

    expect(await controller.approve()).toBeNull();
    expect(text("#comment-status")).toContain("충돌");
  });
});

describe("copying", () => {
  it("copies the current draft", async () => {
    const copied: string[] = [];
    const controller = new CommentController(root(), {
      api: api() as never,
      copy: async (value) => {
        copied.push(value);
      },
    });
    controller.open(EXTRACTION);
    await controller.generate();

    expect(await controller.copyDraft()).toBe(true);
    expect(copied).toEqual(["따뜻한 후보"]);
  });

  it("reports a clipboard failure without losing the draft", async () => {
    const controller = new CommentController(root(), {
      api: api() as never,
      copy: async () => {
        throw new Error("denied");
      },
    });
    controller.open(EXTRACTION);
    await controller.generate();

    expect(await controller.copyDraft()).toBe(false);
    expect(controller.state.draft).toBe("따뜻한 후보");
  });

  it("does nothing for an empty draft", async () => {
    const controller = new CommentController(root(), { api: api() as never });

    expect(await controller.copyDraft()).toBe(false);
  });
});

describe("accessibility", () => {
  it("labels the editor and keeps a live status region", async () => {
    const controller = new CommentController(root(), { api: api() as never });
    controller.open(EXTRACTION);
    await controller.generate();

    expect(document.querySelector("#comment-status")?.getAttribute("role")).toBe("status");
    expect(document.querySelector('label[for="comment-draft"]')).not.toBeNull();
    for (const button of Array.from(document.querySelectorAll("button"))) {
      expect(button.getAttribute("type")).toBe("button");
    }
  });
});
