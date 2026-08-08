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
  PublishStep,
  PublishStepName,
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

/** The non-content body evidence sent in a staging `step_completed` event. */
export interface StagingBodyVerification {
  observedPrefixCount: number;
  requestedRange: { end: number; start: number };
}

export interface WritingState {
  autoSave: "idle" | "saving" | "saved" | "failed";
  blocks: BodyBlock[];
  /** Legacy-derived read-only text used only for revision comparison helpers. */
  bodyText: string;
  busy: boolean;
  categories: BlogCategory[];
  draft: PostDraft | null;
  drafts: PostDraft[];
  deleteConfirmation: boolean;
  error: string | null;
  imageInsertAt: number;
  notice: string | null;
  options: WritingOptions;
  phase: WritingPhase;
  providers: LlmProviderStatus[];
  run: PublishRun | null;
  seedText: string;
  seedTitle: string;
  selectedCategoryNo: number | null;
  stagingBodyVerification: StagingBodyVerification | null;
  referenceLimit: number;
  useImageVision: boolean;
}

export function initialWritingState(): WritingState {
  return {
    autoSave: "idle",
    blocks: [],
    bodyText: "",
    busy: false,
    categories: [],
    draft: null,
    drafts: [],
    deleteConfirmation: false,
    error: null,
    imageInsertAt: 0,
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
    stagingBodyVerification: null,
    referenceLimit: 3,
    useImageVision: false,
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
  const blocks = copyBlocks(draft.workingCopy?.blocks ?? activeRevisionFor(draft)?.blocks ?? []);
  const sameDraft = state.draft?.id === draft.id;
  return {
    ...state,
    autoSave: "saved",
    blocks,
    bodyText: revisionText(activeRevisionFor(draft)),
    busy: false,
    deleteConfirmation: false,
    draft,
    error: null,
    imageInsertAt: blocks.length,
    phase: phaseFor(draft),
    run: sameDraft ? state.run : null,
    selectedCategoryNo: draft.categoryNo,
    stagingBodyVerification: sameDraft ? state.stagingBodyVerification : null,
  };
}

/**
 * Record an autosave acknowledgement without replacing edits made while that request was in flight.
 *
 * The returned draft carries the server's new optimistic version, while the canvas and title remain
 * the newer local values that the queued autosave still needs to send.
 */
export function withAutoSaveAcknowledged(state: WritingState, draft: PostDraft): WritingState {
  const current = state.draft;
  if (current === null || current.id !== draft.id) return state;
  const workingCopy = draft.workingCopy;
  const acknowledged: PostDraft = {
    ...draft,
    title: current.title,
    ...(workingCopy === undefined
      ? {}
      : {
          workingCopy: workingCopy === null ? null : { ...workingCopy, title: current.title },
        }),
  };
  return {
    ...state,
    autoSave: "saved",
    draft: acknowledged,
    drafts: state.drafts.map((item) => (item.id === acknowledged.id ? acknowledged : item)),
    error: null,
  };
}

export function withRun(state: WritingState, run: PublishRun): WritingState {
  return {
    ...state,
    busy: false,
    error: null,
    phase: "staging",
    run,
    stagingBodyVerification: state.run?.id === run.id ? state.stagingBodyVerification : null,
  };
}

/** Apply one trusted progress event without waiting for the terminal draft refresh. */
export function withStagingEvent(
  state: WritingState,
  payload: Record<string, unknown>,
): WritingState {
  const name = publishStepName(payload.step);
  if (name === null || state.run === null) return state;

  const stepState = publishStepState(payload.state);
  const resultCode = typeof payload.result_code === "string" ? payload.result_code : null;
  const run = {
    ...state.run,
    steps: state.run.steps.map((step) =>
      step.name === name
        ? {
            ...step,
            ...(stepState === null ? {} : { state: stepState }),
            ...(resultCode === null ? {} : { resultCode }),
          }
        : step,
    ),
  };
  return {
    ...state,
    run,
    stagingBodyVerification:
      name === "body"
        ? (bodyVerification(payload.detail) ?? state.stagingBodyVerification)
        : state.stagingBodyVerification,
  };
}

export function startWorking(state: WritingState, phase: WritingPhase): WritingState {
  return { ...state, busy: true, error: null, notice: null, phase };
}

export function withFailure(state: WritingState, message: string): WritingState {
  return { ...state, autoSave: "failed", busy: false, error: message, phase: "failed" };
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

export function withWritingProfile(
  state: WritingState,
  profile: {
    referenceLimit?: number;
    structure?: WritingOptions["structure"];
    tone?: WritingOptions["tone"];
    targetLength?: WritingOptions["length"];
    useImageVision?: boolean;
  },
): WritingState {
  return {
    ...state,
    options: {
      ...state.options,
      ...(profile.targetLength === undefined ? {} : { length: profile.targetLength }),
      ...(profile.tone === undefined ? {} : { tone: profile.tone }),
      ...(profile.structure === undefined ? {} : { structure: profile.structure }),
    },
    referenceLimit: profile.referenceLimit ?? state.referenceLimit,
    useImageVision: profile.useImageVision ?? state.useImageVision,
  };
}

export function withBlocks(state: WritingState, blocks: BodyBlock[]): WritingState {
  return {
    ...state,
    autoSave: "idle",
    blocks: copyBlocks(blocks),
    bodyText: blockText(blocks),
    imageInsertAt: Math.min(state.imageInsertAt, blocks.length),
  };
}

/** Remember the exact canvas gap where the next uploaded image should be inserted. */
export function withImageInsertionPoint(state: WritingState, imageInsertAt: number): WritingState {
  return { ...state, imageInsertAt: Math.max(0, Math.min(imageInsertAt, state.blocks.length)) };
}

export function withDraftTitle(state: WritingState, title: string): WritingState {
  if (state.draft === null) return state;
  return {
    ...state,
    autoSave: "idle",
    draft: {
      ...state.draft,
      title,
      workingCopy: state.draft.workingCopy == null ? null : { ...state.draft.workingCopy, title },
    },
  };
}

export function withAutoSave(
  state: WritingState,
  autoSave: WritingState["autoSave"],
): WritingState {
  return { ...state, autoSave };
}

export function withDeleteConfirmation(state: WritingState): WritingState {
  return { ...state, deleteConfirmation: !state.deleteConfirmation };
}

export function withoutDraft(state: WritingState, draftId: string): WritingState {
  return {
    ...state,
    autoSave: "idle",
    blocks: [],
    bodyText: "",
    deleteConfirmation: false,
    draft: null,
    drafts: state.drafts.filter((draft) => draft.id !== draftId),
    error: null,
    notice: "초안을 삭제했습니다.",
    phase: "seed",
    run: null,
    stagingBodyVerification: null,
  };
}

/** Return the revision the screen should show. */
export function activeRevision(state: WritingState): DraftRevision | null {
  return activeRevisionFor(state.draft);
}

function activeRevisionFor(draft: PostDraft | null): DraftRevision | null {
  if (draft === null || draft.revisions.length === 0) return null;
  return draft.revisions.find((revision) => revision.isActive) ?? draft.revisions.at(-1) ?? null;
}

function publishStepName(value: unknown): PublishStepName | null {
  return value === "title" ||
    value === "body" ||
    value === "images" ||
    value === "tags" ||
    value === "save"
    ? value
    : null;
}

function publishStepState(value: unknown): PublishStep["state"] | null {
  return value === "pending" ||
    value === "running" ||
    value === "succeeded" ||
    value === "skipped" ||
    value === "failed" ||
    value === "unconfirmed"
    ? value
    : null;
}

function bodyVerification(value: unknown): StagingBodyVerification | null {
  if (!isRecord(value)) return null;
  const start = positiveInteger(value.requested_range_start);
  const end = positiveInteger(value.requested_range_end);
  const observedPrefixCount = nonNegativeInteger(value.observed_prefix_count);
  if (start === null || end === null || observedPrefixCount === null || start > end) return null;
  return { observedPrefixCount, requestedRange: { start, end } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Return the plain text of one revision so the editor can show and edit it. */
export function revisionText(revision: DraftRevision | null): string {
  if (revision === null) return "";
  return blockText(revision.blocks);
}

/** @deprecated The block canvas no longer uses text-to-block conversion. Kept for old integrations. */
export function blocksFromText(text: string, previous: DraftRevision | null): BodyBlock[] {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ type: "paragraph" as const, text: line }));
  const images = (previous?.blocks ?? []).filter(
    (block): block is Extract<BodyBlock, { type: "image" }> => block.type === "image",
  );
  return paragraphs.length === 0 ? images : [...paragraphs, ...images];
}

/** Report whether the draft can be staged. */
export function canStage(state: WritingState): boolean {
  return !state.busy && state.blocks.length > 0;
}

function copyBlocks(blocks: readonly BodyBlock[]): BodyBlock[] {
  return blocks.map((block) => {
    if (block.type === "image") return { ...block };
    if (block.type === "ordered_list" || block.type === "unordered_list") {
      return { ...block, items: [...block.items] };
    }
    return { ...block };
  });
}

function blockText(blocks: readonly BodyBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "image") return block.caption ?? "";
      if (block.type === "divider") return "";
      if (block.type === "ordered_list" || block.type === "unordered_list") {
        return block.items.join("\n");
      }
      return "text" in block ? block.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
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
