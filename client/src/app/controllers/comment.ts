/**
 * Comment workspace controller.
 *
 * The service owns the idempotency key, so a timeout or an indeterminate result never triggers an
 * automatic retry here: it moves the view into an explicit replacement state.
 */

import { ApiError, LocalApiClient } from "../api/client";
import type {
  ArticleExtraction,
  DiscoverySource,
  GenerationOptions,
  LlmProviderName,
  Recommendation,
} from "../api/types";
import { RunController } from "./run";
import {
  type CommentState,
  appendClosingPhrase,
  canApprove,
  initialCommentState,
  startRefining,
  startGenerating,
  withClosingPhrase,
  withComparedRecommendation,
  withDraft,
  withExtraction,
  withFanout,
  withGeneration,
  withGenerationFailure,
  withGenerationRequest,
  withNeighborMessage,
  withOptions,
  withProviderAvailability,
  withReviewed,
  withRefinedDraft,
  withRefinementFailure,
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

type CommentApi = Pick<
  LocalApiClient,
  | "appSetting"
  | "generateComment"
  | "generateCommentFanout"
  | "llmProviders"
  | "recommendation"
  | "refineRecommendation"
  | "reviewRecommendation"
>;

export interface CommentControllerOptions {
  api?: CommentApi;
  copy?: (text: string) => Promise<void>;
  onBack?: () => void;
  onRecommendationReady?: (
    recommendationId: string,
    discoveryPostId: string | null,
    source: DiscoverySource | null,
  ) => void;
  run?: RunController;
}

export class CommentController {
  readonly #api: CommentApi;
  readonly #root: Element;
  readonly #copy: (text: string) => Promise<void>;
  readonly #onBack: () => void;
  readonly #onRecommendationReady: (
    recommendationId: string,
    discoveryPostId: string | null,
    source: DiscoverySource | null,
  ) => void;
  readonly #run: RunController;
  #state: CommentState = initialCommentState();
  #discoveryPostId: string | null = null;
  #provider: LlmProviderName = "openai";
  #providers: { provider: LlmProviderName; model: string }[] = [];
  #refinementKeys = new Map<string, string>();
  #busy = false;

  constructor(root: Element, options: CommentControllerOptions = {}) {
    this.#root = root;
    this.#api = options.api ?? new LocalApiClient();
    this.#copy = options.copy ?? (async () => undefined);
    this.#onBack = options.onBack ?? (() => undefined);
    this.#onRecommendationReady = options.onRecommendationReady ?? (() => undefined);
    this.#run = options.run ?? new RunController();
    this.#run.observe(() => this.render());
  }

  get state(): CommentState {
    return this.#state;
  }

  get run(): RunController {
    return this.#run;
  }

  /** Re-read an active external-action run after a backgrounded browser resumes. */
  async refresh(): Promise<void> {
    await this.#run.refresh();
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
    try {
      const record = await this.#api.appSetting("neighbor_message");
      const message = record.payload.message;
      this.#update(withNeighborMessage(this.#state, typeof message === "string" ? message : ""));
    } catch {
      this.#update(withNeighborMessage(this.#state, ""));
    }
    try {
      const providers = await this.#api.llmProviders();
      this.#provider = providers.find((provider) => provider.configured)?.provider ?? "openai";
      this.#providers = providers
        .filter((provider) => provider.configured)
        .map((provider) => ({ provider: provider.provider, model: provider.model }));
      this.#update(withProviderAvailability(this.#state, providers));
    } catch {
      // The existing comment workflow still works with its default provider when availability
      // cannot be refreshed; refinement will report a concrete service refusal if unavailable.
    }
  }

  /** Show one extracted post and wait for the user to request generation. */
  open(
    extraction: ArticleExtraction,
    discoveryPostId: string | null = null,
    source: DiscoverySource | null = null,
    options: { generate?: boolean } = {},
  ): void {
    this.#discoveryPostId = discoveryPostId;
    this.#run.reset();
    this.#update(withExtraction(this.#state, extraction, source));
    if (options.generate === true) void this.generate();
  }

  /** Generate directly from a discovery or pasted URL so the service extracts only once. */
  openUrl(url: string, discoveryPostId: string | null, source: DiscoverySource | null): void {
    this.#discoveryPostId = discoveryPostId;
    this.#run.reset();
    this.#update(withGenerationRequest(this.#state, url, source));
    void this.generate();
  }

  /** Restore a saved recommendation after a refresh without re-sending the article to a provider. */
  async openStored(
    recommendation: Recommendation,
    discoveryPostId: string | null,
    source: DiscoverySource | null,
  ): Promise<void> {
    const extraction = storedExtraction(recommendation);
    this.open(extraction, discoveryPostId, source);
    this.#update(
      withGeneration(this.#state, {
        attempt: 0,
        extraction,
        recommendation,
        replayed: false,
      }),
    );
  }

  /** Fetch and render a saved recommendation addressed by a shareable local hash route. */
  async restore(
    recommendationId: string,
    discoveryPostId: string | null,
    source: DiscoverySource | null,
  ): Promise<void> {
    try {
      await this.openStored(
        await this.#api.recommendation(recommendationId),
        discoveryPostId,
        source,
      );
    } catch (error) {
      this.#update(withGenerationFailure(this.#state, describe(error)));
    }
  }

  render(): void {
    renderComment(this.#root, this.#state, this.#handlers(), this.#run.state);
  }

  #handlers(): CommentHandlers {
    return {
      onApprove: () => void this.approve(),
      onBack: () => this.#onBack(),
      onCopy: () => void this.copyDraft(),
      onCompare: () => void this.compareProviders(),
      onDraftChange: (draft: string) => {
        this.#state = withDraft(this.#state, draft);
      },
      onExecute: () => void this.execute(),
      onGenerate: () => void this.generate(),
      onOptionChange: (option: string, value: string) => this.#setOption(option, value),
      onReplace: () => void this.generate({ replace: true }),
      onSelectCandidate: (candidateId: string) =>
        this.#update(withSelectedCandidate(this.#state, candidateId)),
      onRefine: (preset, request) => void this.refine(preset, request),
      onSelectComparisonRecommendation: (recommendationId) =>
        this.#update(withComparedRecommendation(this.#state, recommendationId)),
      run: {
        onManualComplete: () => void this.#run.completeManually(),
        onStart: () => void this.startRun(),
        onToggleManualStep: (name) => this.#run.toggleManualStep(name),
      },
    };
  }

  /** Execute the approved comment for the open post. */
  async startRun(): Promise<void> {
    const recommendation = this.#state.recommendation;
    if (recommendation === null || this.#discoveryPostId === null) return;
    await this.#run.start(this.#discoveryPostId, recommendation.id);
  }

  /** Approve the reviewed text and begin exactly the steps promised for this discovered post. */
  async execute(): Promise<void> {
    if (this.#discoveryPostId === null || this.#state.source === null || this.#busy) return;
    const recommendation =
      this.#state.recommendation?.reviewStatus === "drafted"
        ? await this.approve()
        : this.#state.recommendation;
    if (recommendation === null) return;
    await this.#run.start(this.#discoveryPostId, recommendation.id);
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
      this.#onRecommendationReady(
        generation.recommendation.id,
        this.#discoveryPostId,
        this.#state.source,
      );
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

  /** Compare every configured provider in one explicit, bounded fan-out request. */
  async compareProviders(): Promise<void> {
    const url = this.#state.url;
    if (url === null || this.#busy || this.#providers.length < 2) return;
    this.#busy = true;
    this.#update(startGenerating(this.#state));
    try {
      const fanout = await this.#api.generateCommentFanout(
        url,
        this.#providers,
        this.#state.options,
      );
      this.#update(withFanout(this.#state, fanout));
      const selected = this.#state.recommendation;
      if (selected !== null) {
        this.#onRecommendationReady(selected.id, this.#discoveryPostId, this.#state.source);
      }
    } catch (error) {
      this.#update(withGenerationFailure(this.#state, describe(error)));
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

  /** Ask the selected configured provider to rewrite only the visible comment and saved metadata. */
  async refine(
    preset: "shorter" | "natural" | "warmer" | "specific" | undefined,
    request: string,
  ): Promise<void> {
    const recommendation = this.#state.recommendation;
    if (recommendation === null || this.#state.draft.trim().length === 0 || this.#busy) return;
    if (preset === undefined && request.trim().length === 0) return;
    const requestText = request.trim();
    const requestKey = JSON.stringify({
      currentComment: this.#state.draft,
      preset: preset ?? null,
      provider: this.#provider,
      recommendationId: recommendation.id,
      request: requestText,
    });
    const idempotencyKey = this.#refinementKeys.get(requestKey) ?? randomIdempotencyKey();
    this.#refinementKeys.set(requestKey, idempotencyKey);
    this.#busy = true;
    this.#update(startRefining(this.#state));
    try {
      const refinement = await this.#api.refineRecommendation(recommendation.id, {
        currentComment: this.#state.draft,
        provider: this.#provider,
        ...(preset === undefined ? {} : { preset }),
        ...(requestText.length === 0 ? {} : { request: requestText }),
        idempotencyKey,
      });
      this.#update(withRefinedDraft(this.#state, refinement));
      this.#refinementKeys.delete(requestKey);
    } catch (error) {
      this.#update(withRefinementFailure(this.#state, describe(error)));
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

function randomIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random !== undefined) return random;
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function storedExtraction(recommendation: Recommendation): ArticleExtraction {
  return {
    sourceUrl: recommendation.sourceUrl,
    title: recommendation.title,
    selectorKind: "semantic",
    originalLength: recommendation.summary.length,
    transmittedLength: recommendation.summary.length,
    truncated: false,
    preview: recommendation.summary,
  };
}
