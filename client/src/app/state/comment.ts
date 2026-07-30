/**
 * Comment workspace state.
 *
 * The service owns the idempotency key, so this state never persists a retry registry. It tracks the
 * preview, the generated candidates, the local draft, and whether a replacement attempt needs the
 * user's explicit confirmation.
 */

import type {
  ArticleExtraction,
  CommentCandidate,
  CommentGeneration,
  GenerationOptions,
  Recommendation,
} from "../api/types";

export type CommentPhase =
  | "empty"
  | "preview"
  | "generating"
  | "review"
  | "failed"
  | "needs_replacement";

export interface CommentState {
  attempt: number;
  closingPhrase: string;
  draft: string;
  error: string | null;
  extraction: ArticleExtraction | null;
  options: GenerationOptions;
  phase: CommentPhase;
  recommendation: Recommendation | null;
  replayed: boolean;
  selectedCandidateId: string | null;
  url: string | null;
}

export function initialCommentState(): CommentState {
  return {
    attempt: 0,
    closingPhrase: "",
    draft: "",
    error: null,
    extraction: null,
    options: {},
    phase: "empty",
    recommendation: null,
    replayed: false,
    selectedCandidateId: null,
    url: null,
  };
}

export function withExtraction(state: CommentState, extraction: ArticleExtraction): CommentState {
  return {
    ...state,
    attempt: 0,
    draft: "",
    error: null,
    extraction,
    phase: "preview",
    recommendation: null,
    replayed: false,
    selectedCandidateId: null,
    url: extraction.sourceUrl,
  };
}

export function withClosingPhrase(state: CommentState, phrase: string): CommentState {
  return { ...state, closingPhrase: phrase };
}

export function withOptions(state: CommentState, options: GenerationOptions): CommentState {
  return { ...state, options: { ...state.options, ...options } };
}

export function startGenerating(state: CommentState): CommentState {
  return { ...state, error: null, phase: "generating" };
}

export function withGeneration(state: CommentState, generation: CommentGeneration): CommentState {
  const first = generation.recommendation.candidates[0] ?? null;
  const selected = generation.recommendation.selectedCandidateId ?? first?.id ?? null;
  return {
    ...state,
    attempt: generation.attempt,
    error: null,
    extraction: generation.extraction,
    phase: "review",
    recommendation: generation.recommendation,
    replayed: generation.replayed,
    selectedCandidateId: selected,
    draft: draftFor(generation.recommendation, selected, state.closingPhrase),
    url: generation.extraction.sourceUrl,
  };
}

export function withGenerationFailure(
  state: CommentState,
  message: string,
  options: { needsReplacement?: boolean } = {},
): CommentState {
  return {
    ...state,
    error: message,
    phase: options.needsReplacement === true ? "needs_replacement" : "failed",
  };
}

export function withSelectedCandidate(state: CommentState, candidateId: string): CommentState {
  if (state.recommendation === null) return state;
  const candidate = findCandidate(state.recommendation, candidateId);
  if (candidate === null) return state;
  return {
    ...state,
    selectedCandidateId: candidateId,
    draft: appendClosingPhrase(candidate.comment, state.closingPhrase),
  };
}

export function withDraft(state: CommentState, draft: string): CommentState {
  return { ...state, draft };
}

export function withReviewed(state: CommentState, recommendation: Recommendation): CommentState {
  return { ...state, error: null, recommendation, phase: "review" };
}

export function selectedCandidate(state: CommentState): CommentCandidate | null {
  if (state.recommendation === null || state.selectedCandidateId === null) return null;
  return findCandidate(state.recommendation, state.selectedCandidateId);
}

/** Return true when the draft is a usable comment for the approval step. */
export function canApprove(state: CommentState): boolean {
  return (
    state.phase === "review" &&
    state.recommendation !== null &&
    state.selectedCandidateId !== null &&
    state.draft.trim().length > 0 &&
    state.draft.length <= MAX_COMMENT_CODE_POINTS
  );
}

export const MAX_COMMENT_CODE_POINTS = 500;

/** Append the closing phrase once, bounded to the stored comment limit. */
export function appendClosingPhrase(comment: string, phrase: string): string {
  const trimmed = comment.replace(/\s+$/u, "");
  if (phrase.length === 0) return trimmed;
  if (trimmed.endsWith(phrase)) return trimmed;
  return `${trimmed} ${phrase}`.trim().slice(0, MAX_COMMENT_CODE_POINTS);
}

function draftFor(
  recommendation: Recommendation,
  candidateId: string | null,
  phrase: string,
): string {
  if (recommendation.editedComment !== null && recommendation.editedComment.length > 0) {
    return recommendation.editedComment;
  }
  const candidate = candidateId === null ? null : findCandidate(recommendation, candidateId);
  return candidate === null ? "" : appendClosingPhrase(candidate.comment, phrase);
}

function findCandidate(recommendation: Recommendation, id: string): CommentCandidate | null {
  return recommendation.candidates.find((candidate) => candidate.id === id) ?? null;
}
