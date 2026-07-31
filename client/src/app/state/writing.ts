/**
 * Writing workspace state.
 *
 * The service owns the draft, so this state mirrors it and tracks only what the screen needs: which
 * step the user is on, which provider to call, and what the last action reported.
 */

import type {
  BlogCategory,
  BodyBlock,
  DraftRevision,
  LlmProviderName,
  LlmProviderStatus,
  PostDraft,
  PublishRun,
} from "../api/types";

export type WritingPhase =
  | "empty"
  | "seed"
  | "composing"
  | "review"
  | "tagging"
  | "staging"
  | "failed";

export interface WritingOptions {
  provider: LlmProviderName;
  length: "short" | "medium" | "long";
  tone: "calm" | "warm" | "lively";
  structure: "plain" | "sectioned" | "story";
  request: string;
}

export interface WritingState {
  busy: boolean;
  categories: BlogCategory[];
  draft: PostDraft | null;
  drafts: PostDraft[];
  error: string | null;
  notice: string | null;
  options: WritingOptions;
  phase: WritingPhase;
  providers: LlmProviderStatus[];
  run: PublishRun | null;
  seedText: string;
  seedTitle: string;
  selectedCategoryNo: number | null;
}

export function initialWritingState(): WritingState {
  return {
    busy: false,
    categories: [],
    draft: null,
    drafts: [],
    error: null,
    notice: null,
    options: {
      provider: "openai",
      length: "medium",
      tone: "warm",
      structure: "sectioned",
      request: "",
    },
    phase: "empty",
    providers: [],
    run: null,
    seedText: "",
    seedTitle: "",
    selectedCategoryNo: null,
  };
}

export function withLoaded(
  state: WritingState,
  loaded: { categories: BlogCategory[]; drafts: PostDraft[]; providers: LlmProviderStatus[] },
): WritingState {
  const configured = loaded.providers.find((provider) => provider.configured);
  return {
    ...state,
    busy: false,
    categories: loaded.categories,
    drafts: loaded.drafts,
    error: null,
    phase: state.draft === null ? "seed" : state.phase,
    providers: loaded.providers,
    options:
      configured === undefined
        ? state.options
        : { ...state.options, provider: configured.provider },
  };
}

export function withDraft(state: WritingState, draft: PostDraft): WritingState {
  return {
    ...state,
    busy: false,
    draft,
    error: null,
    phase: phaseFor(draft),
    selectedCategoryNo: draft.categoryNo,
  };
}

export function withRun(state: WritingState, run: PublishRun): WritingState {
  return { ...state, busy: false, error: null, phase: "staging", run };
}

export function startWorking(state: WritingState, phase: WritingPhase): WritingState {
  return { ...state, busy: true, error: null, notice: null, phase };
}

export function withFailure(state: WritingState, message: string): WritingState {
  return { ...state, busy: false, error: message, phase: "failed" };
}

export function withNotice(state: WritingState, notice: string): WritingState {
  return { ...state, busy: false, notice };
}

export function withSeed(
  state: WritingState,
  seed: { title?: string; text?: string; categoryNo?: number | null },
): WritingState {
  return {
    ...state,
    seedTitle: seed.title ?? state.seedTitle,
    seedText: seed.text ?? state.seedText,
    selectedCategoryNo: seed.categoryNo === undefined ? state.selectedCategoryNo : seed.categoryNo,
  };
}

export function withOptions(state: WritingState, options: Partial<WritingOptions>): WritingState {
  return { ...state, options: { ...state.options, ...options } };
}

/** Return the revision the screen should show. */
export function activeRevision(state: WritingState): DraftRevision | null {
  const draft = state.draft;
  if (draft === null || draft.revisions.length === 0) return null;
  return draft.revisions.find((revision) => revision.isActive) ?? draft.revisions.at(-1) ?? null;
}

/** Return the plain text of one revision so the editor can show and edit it. */
export function revisionText(revision: DraftRevision | null): string {
  if (revision === null) return "";
  return revision.blocks
    .map((block) => (block.type === "image" ? (block.caption ?? "") : (block.text ?? "")))
    .filter((line) => line.length > 0)
    .join("\n\n");
}

/** Turn edited text back into paragraph blocks, keeping image blocks in place. */
export function blocksFromText(text: string, previous: DraftRevision | null): BodyBlock[] {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const images = (previous?.blocks ?? []).filter((block) => block.type === "image");
  const blocks: BodyBlock[] = paragraphs.map((line) => ({ type: "paragraph", text: line }));
  return blocks.length === 0 ? images : [...blocks, ...images];
}

/** Report whether the draft can be staged. */
export function canStage(state: WritingState): boolean {
  return !state.busy && activeRevision(state) !== null;
}

/** Report whether any provider is configured for generation. */
export function canGenerate(state: WritingState): boolean {
  return !state.busy && state.providers.some((provider) => provider.configured);
}

export function selectedTags(state: WritingState): string[] {
  return (state.draft?.tags ?? []).filter((tag) => tag.selected).map((tag) => tag.tag);
}

function phaseFor(draft: PostDraft): WritingPhase {
  switch (draft.status) {
    case "collecting":
      return draft.revisions.length === 0 ? "seed" : "review";
    case "tagged":
      return "tagging";
    case "staging":
    case "staged":
      return "staging";
    default:
      return "review";
  }
}
