/**
 * Comment workspace controller.
 *
 * The service owns the idempotency key, so a timeout or an indeterminate result never triggers an
 * automatic retry here: it moves the view into an explicit replacement state.
 */

import { ApiError, LocalApiClient } from "../api/client";
import type { ArticleExtraction, GenerationOptions, Recommendation } from "../api/types";
import {
  type CommentState,
  appendClosingPhrase,
  canApprove,
  initialCommentState,
  startGenerating,
  withClosingPhrase,
  withDraft,
  withExtraction,
  withGeneration,
  withGenerationFailure,
  withOptions,
  withReviewed,
  withSelectedCandidate,
} from "../state/comment";
import { type CommentHandlers, renderComment } from "../views/comment";

const OPTION_KEYS: Record<string, keyof GenerationOptions> = {
  relationship_level: "relationshipLevel",
  speech_style: "speechStyle",
  comment_length: "commentLength",
  comment_mood: "commentMood",
  personalization_mode: "personalizationMode",
};

const REPLACEMENT_CODES = new Set([
  "generation_timeout",
  "generation_indeterminate",
  "generation_in_progress",
]);

type CommentApi = Pick<LocalApiClient, "appSetting" | "generateComment" | "reviewRecommendation">;

export interface CommentControllerOptions {
  api?: CommentApi;
  copy?: (text: string) => Promise<void>;
  onBack?: () => void;
}

export class CommentController {
  readonly #api: CommentApi;
  readonly #root: Element;
  readonly #copy: (text: string) => Promise<void>;
  readonly #onBack: () => void;
  #state: CommentState = initialCommentState();
  #busy = false;

  constructor(root: Element, options: CommentControllerOptions = {}) {
    this.#root = root;
    this.#api = options.api ?? new LocalApiClient();
    this.#copy = options.copy ?? (async () => undefined);
    this.#onBack = options.onBack ?? (() => undefined);
  }

  get state(): CommentState {
    return this.#state;
  }

  /** Load the saved closing phrase so candidate selection can append it locally. */
  async loadClosingPhrase(): Promise<void> {
    try {
      const record = await this.#api.appSetting("closing_phrase");
      const phrase = record.payload.phrase;
      this.#update(withClosingPhrase(this.#state, typeof phrase === "string" ? phrase : ""));
    } catch {
      this.#update(withClosingPhrase(this.#state, ""));
    }
  }

  /** Show one extracted post and wait for the user to request generation. */
  open(extraction: ArticleExtraction): void {
    this.#update(withExtraction(this.#state, extraction));
  }

  render(): void {
    renderComment(this.#root, this.#state, this.#handlers());
  }

  #handlers(): CommentHandlers {
    return {
      onApprove: () => void this.approve(),
      onBack: () => this.#onBack(),
      onCopy: () => void this.copyDraft(),
      onDraftChange: (draft: string) => {
        this.#state = withDraft(this.#state, draft);
      },
      onGenerate: () => void this.generate(),
      onOptionChange: (option: string, value: string) => this.#setOption(option, value),
      onReplace: () => void this.generate({ replace: true }),
      onSelectCandidate: (candidateId: string) =>
        this.#update(withSelectedCandidate(this.#state, candidateId)),
    };
  }

  #setOption(option: string, value: string): void {
    const key = OPTION_KEYS[option];
    if (key === undefined) return;
    this.#update(withOptions(this.#state, { [key]: value } as GenerationOptions));
  }

  /** Request candidates for the open post. */
  async generate(options: { replace?: boolean } = {}): Promise<Recommendation | null> {
    const url = this.#state.url;
    if (url === null || this.#busy) return null;
    this.#busy = true;
    this.#update(startGenerating(this.#state));
    try {
      const generation = await this.#api.generateComment(url, {
        ...this.#state.options,
        ...(options.replace === true ? { replace: true } : {}),
      });
      this.#update(withGeneration(this.#state, generation));
      return generation.recommendation;
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null;
      this.#update(
        withGenerationFailure(this.#state, describe(error), {
          needsReplacement: code !== null && REPLACEMENT_CODES.has(code),
        }),
      );
      return null;
    } finally {
      this.#busy = false;
    }
  }

  /** Store the selected candidate and the edited draft as approved. */
  async approve(): Promise<Recommendation | null> {
    const recommendation = this.#state.recommendation;
    const candidateId = this.#state.selectedCandidateId;
    if (recommendation === null || candidateId === null || !canApprove(this.#state)) return null;
    if (this.#busy) return null;
    this.#busy = true;
    try {
      const reviewed = await this.#api.reviewRecommendation(recommendation.id, {
        editedComment: this.#state.draft,
        reviewStatus: "approved",
        selectedCandidateId: candidateId,
      });
      this.#update(withReviewed(this.#state, reviewed));
      return reviewed;
    } catch (error) {
      this.#update(withGenerationFailure(this.#state, describe(error)));
      return null;
    } finally {
      this.#busy = false;
    }
  }

  /** Copy the current draft, leaving it selectable when the clipboard is unavailable. */
  async copyDraft(): Promise<boolean> {
    if (this.#state.draft.length === 0) return false;
    try {
      await this.#copy(this.#state.draft);
      return true;
    } catch {
      return false;
    }
  }

  /** Re-append the closing phrase to the current draft. */
  applyClosingPhrase(): void {
    this.#update(
      withDraft(this.#state, appendClosingPhrase(this.#state.draft, this.#state.closingPhrase)),
    );
  }

  #update(state: CommentState): void {
    this.#state = state;
    this.render();
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.problem?.detail ?? error.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}
