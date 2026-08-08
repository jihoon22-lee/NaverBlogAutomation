import { describe, expect, it } from "vitest";

import type { ArticleExtraction, CommentGeneration, Recommendation } from "../../src/app/api/types";
import {
  MAX_COMMENT_CODE_POINTS,
  appendClosingPhrase,
  canApprove,
  initialCommentState,
  selectedCandidate,
  startGenerating,
  withClosingPhrase,
  withDraft,
  withExtraction,
  withGeneration,
  withGenerationFailure,
  withOptions,
  withReviewed,
  withSelectedCandidate,
} from "../../src/app/state/comment";

const EXTRACTION: ArticleExtraction = {
  sourceUrl: "https://blog.naver.com/example/1",
  title: "합성 제목",
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
    createdAt: "2026-08-08T00:00:00Z",
    updatedAt: null,
    selectedCandidateId: null,
    editedComment: null,
    reviewStatus: "drafted",
    relationshipLevel: "friendly",
    speechStyle: "honorific",
    commentLength: "medium",
    commentMood: "warm",
    qualityWarnings: [],
    personalizationApplied: false,
    personalizationMode: "off",
    personalizationSampleCount: 0,
    personalizationEligible: true,
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

describe("initialCommentState", () => {
  it("starts empty", () => {
    const state = initialCommentState();

    expect(state.phase).toBe("empty");
    expect(state.url).toBeNull();
    expect(state.draft).toBe("");
  });
});

describe("withExtraction", () => {
  it("moves to preview and remembers the url", () => {
    const state = withExtraction(initialCommentState(), EXTRACTION);

    expect(state.phase).toBe("preview");
    expect(state.url).toBe(EXTRACTION.sourceUrl);
    expect(state.extraction?.truncated).toBe(true);
  });

  it("clears a previous recommendation and draft", () => {
    const reviewed = withGeneration(
      withExtraction(initialCommentState(), EXTRACTION),
      generation(),
    );

    const reopened = withExtraction(reviewed, { ...EXTRACTION, title: "다른 글" });

    expect(reopened.recommendation).toBeNull();
    expect(reopened.draft).toBe("");
    expect(reopened.attempt).toBe(0);
  });
});

describe("withOptions", () => {
  it("merges options without dropping earlier choices", () => {
    const state = withOptions(withOptions(initialCommentState(), { commentLength: "short" }), {
      commentMood: "calm",
    });

    expect(state.options).toEqual({ commentLength: "short", commentMood: "calm" });
  });
});

describe("withGeneration", () => {
  it("selects the first candidate and seeds the draft", () => {
    const state = withGeneration(withExtraction(initialCommentState(), EXTRACTION), generation());

    expect(state.phase).toBe("review");
    expect(state.selectedCandidateId).toBe("c1");
    expect(state.draft).toBe("따뜻한 후보");
    expect(state.attempt).toBe(1);
  });

  it("honors a stored selection and edited comment", () => {
    const state = withGeneration(
      withExtraction(initialCommentState(), EXTRACTION),
      generation({
        recommendation: recommendation({ selectedCandidateId: "c2", editedComment: "저장된 초안" }),
      }),
    );

    expect(state.selectedCandidateId).toBe("c2");
    expect(state.draft).toBe("저장된 초안");
  });

  it("appends the closing phrase to a fresh draft", () => {
    const withPhrase = withClosingPhrase(
      withExtraction(initialCommentState(), EXTRACTION),
      "감사합니다",
    );

    const state = withGeneration(withPhrase, generation());

    expect(state.draft).toBe("따뜻한 후보 감사합니다");
  });

  it("marks a replayed result", () => {
    const state = withGeneration(
      withExtraction(initialCommentState(), EXTRACTION),
      generation({ replayed: true }),
    );

    expect(state.replayed).toBe(true);
  });
});

describe("startGenerating and failures", () => {
  it("clears the error while generating", () => {
    const failed = withGenerationFailure(initialCommentState(), "실패");

    expect(startGenerating(failed).phase).toBe("generating");
    expect(startGenerating(failed).error).toBeNull();
  });

  it("uses a dedicated phase when a replacement is required", () => {
    const state = withGenerationFailure(initialCommentState(), "결과 불명", {
      needsReplacement: true,
    });

    expect(state.phase).toBe("needs_replacement");
    expect(state.error).toBe("결과 불명");
  });
});

describe("withSelectedCandidate", () => {
  it("replaces the draft with the chosen candidate", () => {
    const state = withGeneration(withExtraction(initialCommentState(), EXTRACTION), generation());

    const updated = withSelectedCandidate(state, "c3");

    expect(updated.selectedCandidateId).toBe("c3");
    expect(updated.draft).toBe("응원하는 후보");
  });

  it("ignores an unknown candidate", () => {
    const state = withGeneration(withExtraction(initialCommentState(), EXTRACTION), generation());

    expect(withSelectedCandidate(state, "missing").selectedCandidateId).toBe("c1");
  });

  it("does nothing without a recommendation", () => {
    const state = withExtraction(initialCommentState(), EXTRACTION);

    expect(withSelectedCandidate(state, "c1")).toBe(state);
  });
});

describe("selectedCandidate", () => {
  it("returns the chosen candidate", () => {
    const state = withGeneration(withExtraction(initialCommentState(), EXTRACTION), generation());

    expect(selectedCandidate(state)?.tone).toBe("warm");
  });

  it("returns null before generation", () => {
    expect(selectedCandidate(initialCommentState())).toBeNull();
  });
});

describe("canApprove", () => {
  it("allows approving a non-empty draft in review", () => {
    const state = withGeneration(withExtraction(initialCommentState(), EXTRACTION), generation());

    expect(canApprove(state)).toBe(true);
  });

  it("blocks approving an empty draft", () => {
    const state = withDraft(
      withGeneration(withExtraction(initialCommentState(), EXTRACTION), generation()),
      "   ",
    );

    expect(canApprove(state)).toBe(false);
  });

  it("blocks approving before generation", () => {
    expect(canApprove(withExtraction(initialCommentState(), EXTRACTION))).toBe(false);
  });

  it("blocks approving an overlong draft", () => {
    const state = withDraft(
      withGeneration(withExtraction(initialCommentState(), EXTRACTION), generation()),
      "가".repeat(MAX_COMMENT_CODE_POINTS + 1),
    );

    expect(canApprove(state)).toBe(false);
  });
});

describe("withReviewed", () => {
  it("stores the reviewed recommendation and stays in review", () => {
    const state = withGeneration(withExtraction(initialCommentState(), EXTRACTION), generation());

    const reviewed = withReviewed(state, recommendation({ reviewStatus: "approved" }));

    expect(reviewed.recommendation?.reviewStatus).toBe("approved");
    expect(reviewed.phase).toBe("review");
  });
});

describe("appendClosingPhrase", () => {
  it("trims trailing whitespace when the phrase is empty", () => {
    expect(appendClosingPhrase("좋은 글이네요.  ", "")).toBe("좋은 글이네요.");
  });

  it("appends the phrase once", () => {
    expect(appendClosingPhrase("좋은 글이네요.", "감사합니다")).toBe("좋은 글이네요. 감사합니다");
  });

  it("does not duplicate an existing phrase", () => {
    expect(appendClosingPhrase("좋은 글이네요. 감사합니다", "감사합니다")).toBe(
      "좋은 글이네요. 감사합니다",
    );
  });

  it("bounds the combined comment", () => {
    const comment = "가".repeat(MAX_COMMENT_CODE_POINTS);

    expect(appendClosingPhrase(comment, "감사합니다")).toHaveLength(MAX_COMMENT_CODE_POINTS);
  });
});
