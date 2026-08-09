/**
 * Writing workspace controller.
 *
 * One click performs one server action. Generation and staging never run twice at once, and staging
 * progress arrives over SSE with the same bounded reconnect policy as engagement runs.
 */

import { ApiError, type DraftGenerationOptions, LocalApiClient } from "../api/client";
import { TERMINAL_RUN_EVENTS, type RunStreamFactory, eventSourceStream } from "../api/run-stream";
import type { BodyBlock, PostDraft, PublishRun } from "../api/types";
import {
  canStage,
  type WritingOptions,
  type WritingState,
  activeRevision,
  blocksFromText,
  initialWritingState,
  startWorking,
  withAutoSaveAcknowledged,
  withAutoSave,
  withAutoSaveFailure,
  withBlocks,
  withDeleteConfirmation,
  withDraft,
  withDraftTitle,
  withFailure,
  withImageInsertionPoint,
  withLoaded,
  withNotice,
  withOptions,
  withRun,
  withSeed,
  withStagingEvent,
  withStagingTerminal,
  withWritingProfile,
  hasUncheckpointedChanges,
  needsCheckpoint,
  withoutActiveDraft,
  withoutDraft,
} from "../state/writing";
import {
  hasPersistableBody,
  hasValidTitle,
  type WritingHandlers,
  renderWriting,
} from "../views/writing";

const REFUSALS: Record<string, string> = {
  blog_id_missing: "설정에서 내 블로그 ID를 먼저 저장하세요.",
  draft_not_found: "초안을 찾을 수 없습니다.",
  duplicate_image_reference: "생성 결과가 같은 이미지를 두 번 사용했습니다.",
  generation_unavailable: "선택한 AI 연결이 구성되지 않았습니다.",
  image_limit_reached: "이미지 개수 상한에 도달했습니다.",
  invalid_image: "허용되지 않는 이미지입니다.",
  login_required: "네이버에 다시 로그인해야 합니다.",
  no_active_revision: "먼저 본문을 생성하거나 저장하세요.",
  no_usable_tags: "사용할 수 있는 태그를 만들지 못했습니다.",
  seed_text_missing: "초안 메모가 비어 있습니다.",
  unknown_image_reference: "본문이 없는 이미지를 참조했습니다.",
};

type WritingApi = Pick<
  LocalApiClient,
  | "blogCategories"
  | "appSetting"
  | "composeDraft"
  | "checkpointDraft"
  | "createDraft"
  | "deleteDraft"
  | "deleteDraftImage"
  | "draft"
  | "drafts"
  | "generateDraftTags"
  | "llmProviders"
  | "patchDraft"
  | "patchDraftTags"
  | "refineDraft"
  | "saveDraftBody"
  | "stageDraft"
  | "stagingEventsUrl"
  | "syncBlogCategories"
  | "uploadDraftImage"
>;

export interface WritingControllerOptions {
  api?: WritingApi;
  onDraftOpened?: (draftId: string) => void;
  /** Called after the current draft has been safely closed for a new seed. */
  onDraftClosed?: () => void;
  /** Return whether this controller currently owns the visible workspace. */
  isActive?: () => boolean;
  stream?: RunStreamFactory;
}

interface AutoSaveRequest {
  blocks: BodyBlock[];
  baseContentVersion: number | undefined;
  draftId: string;
  mode: "body" | "title";
  summary: string;
  title: string;
  version: number;
}

interface AutoSaveTimer {
  handle: ReturnType<typeof setTimeout>;
  request: AutoSaveRequest;
}

interface FocusRestoreTarget {
  id: string | null;
  key: string | null;
  blockIndex: string | null;
  option: string | null;
  value: string | null;
  panel: string | null;
  draftId: string | null;
  tagName: string;
  type: string | null;
  ariaLabel: string | null;
  selectionStart: number | null;
  selectionEnd: number | null;
}

interface DraftRefreshSnapshot {
  autoSaveInFlight: boolean;
  autoSaveTimer: boolean;
  bodyEditVersion: number;
  draftActionInFlight: boolean;
  draftId: string;
  hasLocalChanges: boolean;
  hasUncheckpointedChanges: boolean;
  pendingAutoSave: boolean;
}

export class WritingController {
  readonly #api: WritingApi;
  readonly #root: Element;
  readonly #stream: RunStreamFactory;
  readonly #onDraftOpened: (draftId: string) => void;
  readonly #onDraftClosed: () => void;
  readonly #isActive: () => boolean;
  #state: WritingState = initialWritingState();
  #source: { close(): void } | null = null;
  #autosaveTimer: AutoSaveTimer | null = null;
  #autoSaveInFlight = false;
  #draftActionInFlight = false;
  #bodyEditVersion = 0;
  #loadSequence = 0;
  #refreshSequence = 0;
  #pendingAutoSave: AutoSaveRequest | null = null;
  #focusRestoreTarget: FocusRestoreTarget | null = null;

  constructor(root: Element, options: WritingControllerOptions = {}) {
    this.#root = root;
    this.#api = options.api ?? new LocalApiClient();
    this.#onDraftOpened = options.onDraftOpened ?? (() => undefined);
    this.#onDraftClosed = options.onDraftClosed ?? (() => undefined);
    this.#isActive = options.isActive ?? (() => true);
    this.#stream = options.stream ?? eventSourceStream;
  }

  get state(): WritingState {
    return this.#state;
  }

  render(): void {
    if (!this.#isActive()) return;
    const active = this.#captureFocus();
    if (active !== null) this.#focusRestoreTarget = active;
    renderWriting(this.#root, this.#state, this.#handlers());
    this.#restoreFocus();
  }

  /** Re-read the selected draft after a backgrounded mobile browser resumes. */
  async refreshActive(): Promise<void> {
    const draft = this.#state.draft;
    if (draft !== null) await this.#refresh(draft.id);
  }

  /** Load providers, categories, and recent drafts, then render once. */
  async load(options: { draftId?: string } = {}): Promise<void> {
    const loadSequence = ++this.#loadSequence;
    this.#refreshSequence += 1;
    this.#update(
      startWorking(this.#state, this.#state.phase === "empty" ? "seed" : this.#state.phase),
    );
    try {
      const [providers, categories, drafts, writingProfile, selectedDraft] = await Promise.all([
        this.#api.llmProviders(),
        this.#api.blogCategories(),
        this.#api.drafts(),
        this.#writingProfile(),
        options.draftId === undefined ? Promise.resolve(null) : this.#api.draft(options.draftId),
      ]);
      if (loadSequence !== this.#loadSequence) return;
      const profiled = withWritingProfile(this.#state, writingProfile);
      const loaded = withLoaded(profiled, { categories, drafts, providers });
      if (selectedDraft !== null && this.#state.draft?.id !== selectedDraft.id) {
        this.#closeSource();
      }
      this.#update(selectedDraft === null ? loaded : withDraft(loaded, selectedDraft));
    } catch (error) {
      if (loadSequence !== this.#loadSequence) return;
      this.#update(withFailure(this.#state, describe(error)));
    }
  }

  async createDraft(): Promise<PostDraft | null> {
    if (
      this.#state.busy ||
      this.#state.seedTitle.trim().length === 0 ||
      this.#state.seedText.trim().length === 0
    ) {
      return null;
    }
    this.#update(startWorking(this.#state, "seed"));
    return this.#guard(async () =>
      this.#api.createDraft({
        title: this.#state.seedTitle.trim(),
        seedText: this.#state.seedText.trim(),
        categoryNo: this.#state.selectedCategoryNo,
        useImageVision: this.#state.useImageVision,
      }),
    );
  }

  /** Register the seed and immediately compose the first body from the selected provider. */
  async completeWithAi(): Promise<PostDraft | null> {
    const created = await this.createDraft();
    return created === null ? null : this.compose();
  }

  async openDraft(draftId: string): Promise<PostDraft | null> {
    if (this.#state.busy) return null;
    this.#loadSequence += 1;
    this.#refreshSequence += 1;
    if (!(await this.#prepareDraftSwitch(draftId))) return null;
    if (this.#state.draft?.id !== draftId) this.#closeSource();
    this.#update(startWorking(this.#state, "review"));
    return this.#guard(async () => this.#api.draft(draftId), {
      allowDraftSwitch: true,
      expectedDraftId: draftId,
    });
  }

  /**
   * Leave the current editor and return to the seed form without deleting the draft.
   *
   * A scheduled or in-flight autosave is kept intact and the transition is refused until it has
   * settled. This conservative guard makes the action safe even when the user presses the button
   * immediately after typing, while retaining the existing autosave concurrency invariants.
   */
  async startNew(): Promise<boolean> {
    if (this.#state.draft === null) return false;
    if (this.#state.autoSave === "failed") {
      this.#update(withNotice(this.#state, "자동 저장에 실패한 변경 내용을 먼저 저장하세요."));
      return false;
    }
    if (this.#autoSaveInFlight || this.#autosaveTimer !== null || this.#pendingAutoSave !== null) {
      this.#update(withNotice(this.#state, "자동 저장이 끝난 뒤 새 글을 시작할 수 있습니다."));
      return false;
    }
    if (this.#state.busy || this.#draftActionInFlight) {
      this.#update({
        ...this.#state,
        notice: "현재 작업이 끝난 뒤 새 글을 시작할 수 있습니다.",
      });
      return false;
    }
    if (this.#state.autoSave === "idle" && hasUncheckpointedChanges(this.#state)) {
      this.#update(
        withNotice(this.#state, "제목과 본문을 먼저 유효하게 저장한 뒤 새 글을 시작하세요."),
      );
      return false;
    }
    this.#loadSequence += 1;
    this.#refreshSequence += 1;
    this.#closeSource();
    this.#bodyEditVersion = 0;
    this.#clearAutosave();
    this.#update(withoutActiveDraft(this.#state));
    const seedTitle = this.#root.querySelector<HTMLElement>("#seed-title");
    seedTitle?.focus({ preventScroll: true });
    this.#onDraftClosed();
    return true;
  }

  async compose(): Promise<PostDraft | null> {
    if (this.#requiresCheckpoint()) return null;
    return this.#generate("composing", (draftId, options) =>
      this.#api.composeDraft(draftId, options),
    );
  }

  async refine(): Promise<PostDraft | null> {
    if (this.#requiresCheckpoint()) return null;
    return this.#generate("composing", (draftId, options) =>
      this.#api.refineDraft(draftId, options),
    );
  }

  async generateTags(): Promise<PostDraft | null> {
    if (this.#requiresCheckpoint()) return null;
    return this.#generate("tagging", (draftId, options) =>
      this.#api.generateDraftTags(draftId, options),
    );
  }

  async saveBlocks(blocks: BodyBlock[]): Promise<PostDraft | null> {
    if (this.#autoSaveInFlight || this.#pendingAutoSave !== null) {
      this.#update(withNotice(this.#state, "자동 저장이 끝난 뒤 본문을 저장할 수 있습니다."));
      return null;
    }
    if (this.#draftActionInFlight) {
      this.#update(withNotice(this.#state, "현재 작업이 끝난 뒤 본문을 저장할 수 있습니다."));
      return null;
    }
    this.#clearAutosave();
    return this.#saveBlocks(blocks, { automatic: false });
  }

  /** @deprecated Compatibility entrypoint for older integrations; the canvas calls saveBlocks. */
  async saveBody(text: string): Promise<PostDraft | null> {
    return this.saveBlocks(blocksFromText(text, this.#state.draft?.revisions.at(-1) ?? null));
  }

  /** @deprecated Compatibility entrypoint for older integrations; the canvas edits blocks directly. */
  onBodyChange(text: string): void {
    this.onBlocksChange(blocksFromText(text, this.#state.draft?.revisions.at(-1) ?? null));
  }

  async checkpoint(): Promise<PostDraft | null> {
    const draft = this.#state.draft;
    if (draft === null || this.#state.busy) return null;
    if (!this.#validateCurrentDraft()) return null;
    if (this.#draftActionInFlight) {
      this.#update(withNotice(this.#state, "현재 작업이 끝난 뒤 버전을 남길 수 있습니다."));
      return null;
    }
    this.#draftActionInFlight = true;
    try {
      if (!(await this.#ensureLatestBodySaved())) return null;
      const latest = this.#state.draft;
      if (latest === null) return null;
      this.#update(startWorking(this.#state, "review"));
      return await this.#guard(async () => this.#api.checkpointDraft(latest.id));
    } finally {
      this.#draftActionInFlight = false;
    }
  }

  async #saveBlocks(
    blocks: BodyBlock[],
    options: {
      automatic: boolean;
      baseContentVersion?: number | undefined;
      draftId?: string | undefined;
      summary?: string | undefined;
      title?: string | undefined;
      version?: number | undefined;
    },
  ): Promise<PostDraft | null> {
    const draft = this.#state.draft;
    const draftId = options.draftId ?? draft?.id;
    const isCurrentDraft = draft !== null && draft.id === draftId;
    const title = options.title ?? draft?.title ?? "";
    const summary =
      options.summary ?? draft?.workingCopy?.summary ?? this.#activeRevisionSummary() ?? "";
    if (!options.automatic && this.#autoSaveInFlight) {
      this.#update(withNotice(this.#state, "자동 저장이 끝난 뒤 본문을 저장할 수 있습니다."));
      return null;
    }
    if (draftId === undefined || (!options.automatic && !isCurrentDraft)) return null;
    if (!hasPersistableBody(blocks) || !hasValidTitle(title)) {
      if (isCurrentDraft && !options.automatic) {
        const message = !hasValidTitle(title)
          ? "제목을 입력한 뒤 저장하세요."
          : "저장할 본문을 입력하세요.";
        this.#update({
          ...withNotice(this.#state, message),
          error: !hasValidTitle(title) ? "제목을 입력하세요." : "저장할 본문이 없습니다.",
        });
      }
      return null;
    }
    if (options.automatic && isCurrentDraft) this.#update(withAutoSave(this.#state, "saving"));
    else if (!options.automatic) this.#update(startWorking(this.#state, "review"));
    try {
      const saved = await this.#api.saveDraftBody(draftId, {
        // withDraftTitle updates the visible draft immediately while retaining the old working
        // copy for its optimistic base version.  Sending that stale copy title would silently
        // discard a title-only autosave.
        title,
        blocks,
        summary,
        baseContentVersion: options.baseContentVersion ?? draft?.workingCopy?.contentVersion ?? 0,
      });
      if (this.#state.draft?.id !== draftId) return saved;
      const acknowledged =
        options.version === undefined || options.version === this.#bodyEditVersion
          ? withDraft(this.#state, saved)
          : withAutoSaveAcknowledged(this.#state, saved);
      this.#update(
        options.version !== undefined && options.version !== this.#bodyEditVersion
          ? withAutoSave(acknowledged, "idle")
          : acknowledged,
      );
      return saved;
    } catch (error) {
      if (error instanceof ApiError && error.code === "draft_content_conflict") {
        // Do not replay a queued snapshot against the fresh version automatically: that could
        // silently overwrite the other device's content. Keep the local canvas, refresh only the
        // optimistic base metadata, and let a new edit or explicit save retry it.
        this.#pendingAutoSave = null;
        if (this.#state.draft?.id !== draftId) return null;
        try {
          const refreshed = await this.#api.draft(draftId);
          if (this.#state.draft?.id !== draftId) return null;
          const recovered = withAutoSaveAcknowledged(this.#state, refreshed);
          this.#update(
            withAutoSaveFailure(
              {
                ...recovered,
                notice:
                  "다른 기기 저장과 충돌했습니다. 현재 편집 내용을 유지했습니다. 다시 저장하세요.",
              },
              "다른 기기의 최신 본문을 불러왔습니다. 변경 내용은 덮어쓰지 않았습니다.",
            ),
          );
        } catch (refreshError) {
          if (this.#state.draft?.id !== draftId) return null;
          this.#update(
            withAutoSaveFailure(
              {
                ...this.#state,
                notice:
                  "다른 기기 저장과 충돌했습니다. 현재 편집 내용을 유지했습니다. 다시 저장하세요.",
              },
              describe(refreshError),
            ),
          );
        }
      } else if (options.automatic) {
        if (this.#state.draft?.id !== draftId) return null;
        this.#update(withAutoSaveFailure(this.#state, describe(error)));
      } else {
        this.#update(withFailure(this.#state, describe(error)));
      }
      return null;
    }
  }

  onBlocksChange(blocks: BodyBlock[]): void {
    if (this.#state.busy || this.#draftActionInFlight) {
      this.#refuseEditWhileBusy();
      return;
    }
    const draftId = this.#state.draft?.id;
    if (draftId === undefined) return;
    this.#bodyEditVersion += 1;
    this.#clearAutosave();
    this.#state = withBlocks(this.#state, blocks);
    if (hasPersistableBody(blocks) && hasValidTitle(this.#state.draft?.title)) {
      this.#scheduleAutosave(this.#autoSaveRequest(draftId, this.#bodyEditVersion));
    }
  }

  onTitleChange(title: string): void {
    if (this.#state.draft === null) return;
    if (this.#state.busy || this.#draftActionInFlight) {
      this.#refuseEditWhileBusy();
      return;
    }
    const draftId = this.#state.draft.id;
    this.#bodyEditVersion += 1;
    this.#clearAutosave();
    this.#state = withDraftTitle(this.#state, title);
    if (
      (hasPersistableBody(this.#state.blocks) || this.#isTitleOnlyDraft()) &&
      hasValidTitle(title)
    ) {
      this.#scheduleAutosave(this.#autoSaveRequest(draftId, this.#bodyEditVersion));
    }
  }

  async deleteDraft(): Promise<void> {
    const draft = this.#state.draft;
    if (draft === null || this.#state.busy) return;
    if (this.#autoSaveInFlight) {
      this.#update(withNotice(this.#state, "자동 저장이 끝난 뒤 초안을 삭제할 수 있습니다."));
      return;
    }
    if (!this.#state.deleteConfirmation) {
      this.#update(withDeleteConfirmation(this.#state));
      return;
    }
    this.#clearAutosave();
    this.#update(startWorking(this.#state, "review"));
    try {
      await this.#api.deleteDraft(draft.id);
      this.#update(withoutDraft(this.#state, draft.id));
    } catch (error) {
      this.#update(withFailure(this.#state, describe(error)));
    }
  }

  async uploadImage(file: File): Promise<PostDraft | null> {
    if (!this.#beginProtectedDraftAction()) return null;
    const draft = this.#state.draft;
    if (draft === null) {
      this.#draftActionInFlight = false;
      return null;
    }
    this.#update(startWorking(this.#state, this.#state.phase));
    try {
      return await this.#guard(async () => this.#api.uploadDraftImage(draft.id, file));
    } finally {
      this.#draftActionInFlight = false;
    }
  }

  async deleteImage(imageId: string): Promise<PostDraft | null> {
    if (!this.#beginProtectedDraftAction()) return null;
    const draft = this.#state.draft;
    if (draft === null) {
      this.#draftActionInFlight = false;
      return null;
    }
    this.#update(startWorking(this.#state, this.#state.phase));
    try {
      return await this.#guard(async () => this.#api.deleteDraftImage(draft.id, imageId));
    } finally {
      this.#draftActionInFlight = false;
    }
  }

  insertImage(imageId: string, position = this.#state.imageInsertAt): void {
    if (this.#state.busy || this.#draftActionInFlight) {
      this.#refuseEditWhileBusy();
      return;
    }
    this.onBlocksStructureChange([
      ...this.#state.blocks.slice(0, position),
      { type: "image", image_id: imageId, caption: "" },
      ...this.#state.blocks.slice(position),
    ]);
  }

  setImageInsertionPoint(position: number): void {
    this.#state = withImageInsertionPoint(this.#state, position);
    this.render();
  }

  /** Redraw only after inserts, deletes, moves, and block-type changes. */
  onBlocksStructureChange(blocks: BodyBlock[]): void {
    if (this.#state.busy || this.#draftActionInFlight) {
      this.#refuseEditWhileBusy();
      return;
    }
    this.onBlocksChange(blocks);
    this.render();
  }

  async toggleTag(tag: string): Promise<PostDraft | null> {
    if (!this.#beginProtectedDraftAction()) return null;
    const draft = this.#state.draft;
    if (draft === null) {
      this.#draftActionInFlight = false;
      return null;
    }
    const selected = draft.tags
      .filter((entry) => (entry.tag === tag ? !entry.selected : entry.selected))
      .map((entry) => entry.tag);
    this.#update(startWorking(this.#state, "tagging"));
    try {
      return await this.#guard(async () => this.#api.patchDraftTags(draft.id, { selected }));
    } finally {
      this.#draftActionInFlight = false;
    }
  }

  async addTags(tags: string[]): Promise<PostDraft | null> {
    if (tags.length === 0 || !this.#beginProtectedDraftAction()) return null;
    const draft = this.#state.draft;
    if (draft === null) {
      this.#draftActionInFlight = false;
      return null;
    }
    this.#update(startWorking(this.#state, "tagging"));
    try {
      return await this.#guard(async () => this.#api.patchDraftTags(draft.id, { added: tags }));
    } finally {
      this.#draftActionInFlight = false;
    }
  }

  async selectRevision(revisionId: string): Promise<PostDraft | null> {
    if (!this.#beginProtectedDraftAction()) return null;
    const draft = this.#state.draft;
    if (draft === null) {
      this.#draftActionInFlight = false;
      return null;
    }
    this.#update(startWorking(this.#state, "review"));
    try {
      return await this.#guard(async () =>
        this.#api.patchDraft(draft.id, { activeRevisionId: revisionId }),
      );
    } finally {
      this.#draftActionInFlight = false;
    }
  }

  async syncCategories(): Promise<void> {
    if (this.#state.busy) return;
    this.#update(startWorking(this.#state, this.#state.phase));
    try {
      const categories = await this.#api.syncBlogCategories();
      this.#update(
        withLoaded(this.#state, {
          categories,
          drafts: this.#state.drafts,
          providers: this.#state.providers,
        }),
      );
      this.#update(withNotice(this.#state, "카테고리를 새로 읽었습니다."));
    } catch (error) {
      this.#update(withFailure(this.#state, describe(error)));
    }
  }

  /** Approve one staging run and follow its progress. */
  async stage(): Promise<PublishRun | null> {
    const draft = this.#state.draft;
    if (draft === null || this.#state.busy) return null;
    if (this.#state.run?.state === "running") {
      this.#update(withNotice(this.#state, "현재 임시저장이 진행 중입니다."));
      return null;
    }
    if (this.#draftActionInFlight) {
      this.#update(withNotice(this.#state, "현재 작업이 끝난 뒤 임시저장을 진행할 수 있습니다."));
      return null;
    }
    if (!this.#validateCurrentDraft()) return null;
    if (!canStage(this.#state)) {
      this.#update(withNotice(this.#state, "먼저 본문을 생성하거나 저장하세요."));
      return null;
    }
    this.#draftActionInFlight = true;
    try {
      if (!(await this.#ensureLatestBodySaved())) return null;
      const latest = this.#state.draft;
      if (latest === null) return null;
      this.#update(startWorking(this.#state, "staging"));
      let run: PublishRun;
      try {
        run = await this.#api.stageDraft(latest.id);
      } catch (error) {
        this.#update(withFailure(this.#state, describe(error)));
        return null;
      }
      this.#update(withRun(this.#state, run));
      this.#subscribe(latest.id);
      return run;
    } finally {
      this.#draftActionInFlight = false;
    }
  }

  setSeed(field: "title" | "text" | "category", value: string): void {
    if (field === "category") {
      const parsed = value === "" ? null : Number.parseInt(value, 10);
      this.#state = withSeed(this.#state, {
        categoryNo: parsed === null || Number.isNaN(parsed) ? null : parsed,
      });
      return;
    }
    this.#state = withSeed(this.#state, field === "title" ? { title: value } : { text: value });
  }

  setOption(option: string, value: string): void {
    if (option === "revision") {
      void this.selectRevision(value);
      return;
    }
    if (option === "request") {
      this.#state = withOptions(this.#state, { request: value });
      return;
    }
    const keys: Record<string, keyof WritingOptions> = {
      provider: "provider",
      length: "length",
      tone: "tone",
      structure: "structure",
    };
    const key = keys[option];
    if (key === undefined) return;
    this.#update(withOptions(this.#state, { [key]: value } as Partial<WritingOptions>));
  }

  #handlers(): WritingHandlers {
    return {
      onAddTags: (tags) => void this.addTags(tags),
      onBlocksChange: (blocks) => this.onBlocksChange(blocks),
      onBlocksChangeUpdate: (update) => this.onBlocksChange(update(this.#state.blocks)),
      onBlocksStructureChange: (blocks) => this.onBlocksStructureChange(blocks),
      onBlocksStructureChangeUpdate: (update) =>
        this.onBlocksStructureChange(update(this.#state.blocks)),
      onCompose: () => void this.compose(),
      onCompleteWithAi: () => void this.completeWithAi(),
      onCreateDraft: () => void this.createDraft(),
      onDeleteDraft: () => void this.deleteDraft(),
      onDeleteImage: (imageId) => void this.deleteImage(imageId),
      onGenerateTags: () => void this.generateTags(),
      onInsertImage: (imageId, position) => this.insertImage(imageId, position),
      onImageInsertionPointChange: (position) => this.setImageInsertionPoint(position),
      onOpenDraft: (draftId) => void this.openDraft(draftId),
      onOptionChange: (option, value) => this.setOption(option, value),
      onRefine: () => void this.refine(),
      onSaveBlocks: (blocks) => void this.saveBlocks(blocks),
      onSaveBlocksLatest: () => void this.saveBlocks(this.#state.blocks),
      onCheckpoint: () => void this.checkpoint(),
      onSeedChange: (field, value) => this.setSeed(field, value),
      onStage: () => void this.stage(),
      onStartNew: () => void this.startNew(),
      onTitleChange: (title) => this.onTitleChange(title),
      onSyncCategories: () => void this.syncCategories(),
      onToggleTag: (tag) => void this.toggleTag(tag),
      onUploadImage: (file) => void this.uploadImage(file),
    };
  }

  async #generate(
    phase: WritingState["phase"],
    call: (draftId: string, options: DraftGenerationOptions) => Promise<PostDraft>,
  ): Promise<PostDraft | null> {
    const draft = this.#state.draft;
    if (draft === null || this.#state.busy) return null;
    this.#update(startWorking(this.#state, phase));
    return this.#guard(async () =>
      call(draft.id, {
        provider: this.#state.options.provider,
        length: this.#state.options.length,
        tone: this.#state.options.tone,
        structure: this.#state.options.structure,
        request: this.#state.options.request,
        referenceLimit: this.#state.referenceLimit,
      }),
    );
  }

  async #guard(
    call: () => Promise<PostDraft>,
    options: { allowDraftSwitch?: boolean; expectedDraftId?: string } = {},
  ): Promise<PostDraft | null> {
    const startedDraftId = this.#state.draft?.id ?? null;
    try {
      const draft = await call();
      if (
        !options.allowDraftSwitch &&
        this.#state.draft !== null &&
        this.#state.draft.id !== draft.id
      ) {
        return null;
      }
      if (options.expectedDraftId !== undefined && draft.id !== options.expectedDraftId) {
        return null;
      }
      if (
        options.expectedDraftId !== undefined &&
        this.#state.draft !== null &&
        this.#state.draft.id !== options.expectedDraftId &&
        this.#state.draft.id !== startedDraftId
      ) {
        return null;
      }
      this.#update(withDraft(this.#state, draft));
      if (this.#isActive()) this.#onDraftOpened(draft.id);
      return draft;
    } catch (error) {
      if (
        this.#state.draft?.id !== startedDraftId &&
        (options.expectedDraftId === undefined || this.#state.draft?.id !== options.expectedDraftId)
      ) {
        return null;
      }
      this.#update(withFailure(this.#state, describe(error)));
      return null;
    }
  }

  #subscribe(draftId: string): void {
    this.#closeSource();
    let source: { close(): void } | null = null;
    source = this.#stream(this.#api.stagingEventsUrl(draftId), {
      onError: () => {
        if (source === null || this.#source !== source) return;
        if (this.#state.draft?.id !== draftId) return;
        if (this.#state.run?.state !== "running") {
          this.#closeSource();
          return;
        }
        this.#update(withStagingTerminal(this.#state, "stream_error"));
        this.#closeSource();
      },
      onEvent: (event) => {
        if (source === null || this.#source !== source) return;
        if (this.#state.draft?.id !== draftId) {
          return;
        }
        if (event.event === "step_completed") {
          this.#update(withStagingEvent(this.#state, event.payload));
          return;
        }
        if (!TERMINAL_RUN_EVENTS.has(event.event)) return;
        this.#update(withStagingTerminal(this.#state, event.event, event.payload));
        this.#closeSource();
        void this.#refresh(draftId);
      },
    });
    this.#source = source;
  }

  async #refresh(draftId: string): Promise<void> {
    const snapshot = this.#draftRefreshSnapshot(draftId);
    if (snapshot === null) return;
    const refreshSequence = ++this.#refreshSequence;
    try {
      const draft = await this.#api.draft(draftId);
      if (!this.#isCurrentRefresh(snapshot, refreshSequence)) return;
      this.#update(
        this.#refreshHasLocalActivity(snapshot)
          ? this.#mergeRefreshMetadata(draft)
          : withDraft(this.#state, draft),
      );
    } catch (error) {
      if (!this.#isCurrentRefresh(snapshot, refreshSequence)) return;
      this.#update(withFailure(this.#state, describe(error)));
    }
  }

  #draftRefreshSnapshot(draftId: string): DraftRefreshSnapshot | null {
    if (this.#state.draft?.id !== draftId) return null;
    return {
      autoSaveInFlight: this.#autoSaveInFlight,
      autoSaveTimer: this.#autosaveTimer !== null,
      bodyEditVersion: this.#bodyEditVersion,
      draftActionInFlight: this.#draftActionInFlight,
      draftId,
      // Invalid transient edits are intentionally not autosaved, but they still belong to the
      // user. Protect those values from a resume/terminal refresh just like a queued autosave.
      hasLocalChanges: this.#state.autoSave !== "saved",
      hasUncheckpointedChanges: hasUncheckpointedChanges(this.#state),
      pendingAutoSave: this.#pendingAutoSave !== null,
    };
  }

  #isCurrentRefresh(snapshot: DraftRefreshSnapshot, refreshSequence: number): boolean {
    return refreshSequence === this.#refreshSequence && this.#state.draft?.id === snapshot.draftId;
  }

  #refreshHasLocalActivity(snapshot: DraftRefreshSnapshot): boolean {
    return (
      snapshot.autoSaveInFlight ||
      snapshot.autoSaveTimer ||
      snapshot.draftActionInFlight ||
      snapshot.hasLocalChanges ||
      snapshot.hasUncheckpointedChanges ||
      snapshot.pendingAutoSave ||
      this.#autoSaveInFlight ||
      this.#autosaveTimer !== null ||
      this.#bodyEditVersion !== snapshot.bodyEditVersion ||
      this.#draftActionInFlight ||
      this.#pendingAutoSave !== null ||
      hasUncheckpointedChanges(this.#state)
    );
  }

  /** Apply fresh server metadata without replacing a canvas that may have changed locally. */
  #mergeRefreshMetadata(draft: PostDraft): WritingState {
    const autoSave = this.#state.autoSave;
    return { ...withAutoSaveAcknowledged(this.#state, draft), autoSave };
  }

  #closeSource(): void {
    this.#source?.close();
    this.#source = null;
  }

  #clearAutosave(): void {
    if (this.#autosaveTimer !== null) clearTimeout(this.#autosaveTimer.handle);
    this.#autosaveTimer = null;
    this.#pendingAutoSave = null;
  }

  #scheduleAutosave(request: AutoSaveRequest): void {
    this.#clearAutosave();
    const handle = setTimeout(() => {
      this.#autosaveTimer = null;
      void this.#queueAutoSave(request);
    }, 700);
    this.#autosaveTimer = { handle, request };
  }

  async #queueAutoSave(request: AutoSaveRequest): Promise<void> {
    if (this.#autoSaveInFlight) {
      this.#pendingAutoSave = request;
      return;
    }
    this.#autoSaveInFlight = true;
    try {
      await this.#flushAutoSaveRequest(request, true);
    } finally {
      this.#autoSaveInFlight = false;
    }
    const pending = this.#pendingAutoSave;
    this.#pendingAutoSave = null;
    if (pending !== null) {
      const current = this.#state.draft;
      const refreshed =
        current?.id === pending.draftId
          ? {
              ...pending,
              baseContentVersion: current.workingCopy?.contentVersion ?? pending.baseContentVersion,
              summary: current.workingCopy?.summary ?? pending.summary,
            }
          : pending;
      await this.#queueAutoSave(refreshed);
    }
  }

  async #writingProfile(): Promise<{
    referenceLimit?: number;
    structure?: WritingState["options"]["structure"];
    targetLength?: WritingState["options"]["length"];
    tone?: WritingState["options"]["tone"];
    useImageVision?: boolean;
  }> {
    try {
      const record = await this.#api.appSetting("writing_profile");
      const payload = record.payload;
      return {
        ...(typeof payload.reference_post_count === "number"
          ? { referenceLimit: payload.reference_post_count }
          : {}),
        ...(isStructure(payload.structure) ? { structure: payload.structure } : {}),
        ...(isLength(payload.target_length) ? { targetLength: payload.target_length } : {}),
        ...(isTone(payload.tone) ? { tone: payload.tone } : {}),
        ...(typeof payload.use_image_vision === "boolean"
          ? { useImageVision: payload.use_image_vision }
          : {}),
      };
    } catch {
      return {};
    }
  }

  #update(state: WritingState): void {
    this.#state = state;
    if (this.#isActive()) this.render();
  }

  async #prepareDraftSwitch(nextDraftId: string): Promise<boolean> {
    const current = this.#state.draft;
    if (current === null) return true;
    if (this.#autoSaveInFlight || this.#pendingAutoSave !== null) {
      this.#update(withNotice(this.#state, "자동 저장이 끝난 뒤 다른 초안을 열 수 있습니다."));
      return false;
    }
    const timer = this.#autosaveTimer;
    if (timer !== null) {
      const request = timer.request;
      this.#clearAutosave();
      const saved = await this.#flushAutoSaveRequest(request, request.draftId !== current.id);
      if (saved === null) return false;
    }
    if (this.#state.autoSave === "failed") {
      if (!this.#validateCurrentDraft()) return false;
      return (
        (await this.#saveBlocks(this.#state.blocks, {
          automatic: false,
          baseContentVersion: current.workingCopy?.contentVersion,
          draftId: current.id,
          summary: current.workingCopy?.summary ?? this.#activeRevisionSummary() ?? "",
          title: current.title,
          version: this.#bodyEditVersion,
        })) !== null
      );
    }
    if (this.#state.autoSave === "idle" && hasUncheckpointedChanges(this.#state)) {
      if (!this.#validateCurrentDraft()) return false;
      return (
        (await this.#saveBlocks(this.#state.blocks, {
          automatic: false,
          baseContentVersion: current.workingCopy?.contentVersion,
          draftId: current.id,
          summary: current.workingCopy?.summary ?? this.#activeRevisionSummary() ?? "",
          title: current.title,
          version: this.#bodyEditVersion,
        })) !== null
      );
    }
    if (current.id === nextDraftId) return true;
    return true;
  }

  #autoSaveRequest(draftId: string, version: number): AutoSaveRequest {
    const draft = this.#state.draft;
    return {
      blocks: copyBlocks(this.#state.blocks),
      baseContentVersion: draft?.workingCopy?.contentVersion,
      draftId,
      mode: this.#isTitleOnlyDraft() ? "title" : "body",
      summary: draft?.workingCopy?.summary ?? activeRevision(this.#state)?.summary ?? "",
      title: draft?.title ?? "",
      version,
    };
  }

  #isTitleOnlyDraft(): boolean {
    return this.#state.draft?.revisions.length === 0 && this.#state.blocks.length === 0;
  }

  async #flushAutoSaveRequest(
    request: AutoSaveRequest,
    automatic: boolean,
  ): Promise<PostDraft | null> {
    if (request.mode === "title") return this.#saveTitle(request, automatic);
    return this.#saveBlocks(request.blocks, {
      automatic,
      baseContentVersion: request.baseContentVersion,
      draftId: request.draftId,
      summary: request.summary,
      title: request.title,
      version: request.version,
    });
  }

  async #saveTitle(request: AutoSaveRequest, automatic: boolean): Promise<PostDraft | null> {
    const draft = this.#state.draft;
    const isCurrentDraft = draft !== null && draft.id === request.draftId;
    if (request.title.trim().length === 0) return null;
    if (!automatic && !isCurrentDraft) return null;
    if (automatic && isCurrentDraft) this.#update(withAutoSave(this.#state, "saving"));
    else if (!automatic) this.#update(startWorking(this.#state, "seed"));
    try {
      const saved = await this.#api.patchDraft(request.draftId, { title: request.title });
      if (this.#state.draft?.id !== request.draftId) return saved;
      const acknowledged = withAutoSaveAcknowledged(this.#state, saved);
      this.#update(
        request.version !== this.#bodyEditVersion
          ? withAutoSave(acknowledged, "idle")
          : acknowledged,
      );
      return saved;
    } catch (error) {
      if (this.#state.draft?.id !== request.draftId) return null;
      if (automatic) this.#update(withAutoSaveFailure(this.#state, describe(error)));
      else this.#update(withFailure(this.#state, describe(error)));
      return null;
    }
  }

  #activeRevisionSummary(): string | null {
    return activeRevision(this.#state)?.summary ?? null;
  }

  #requiresCheckpoint(): boolean {
    if (!needsCheckpoint(this.#state)) return false;
    this.#update(withNotice(this.#state, "먼저 현재 편집 내용을 버전으로 남겨 주세요."));
    return true;
  }

  /**
   * Start a server action that returns the whole draft only after local content is safe.
   *
   * These endpoints can replace the canvas and title as part of their response. Keep the guard
   * synchronous so two rapid clicks cannot both pass it before the first request marks the state
   * busy, and make the same rule enforceable for callers that bypass the rendered controls.
   */
  #beginProtectedDraftAction(): boolean {
    if (this.#state.draft === null || this.#state.busy) return false;
    if (this.#draftActionInFlight) {
      this.#update(withNotice(this.#state, "현재 작업이 끝난 뒤 이 작업을 실행할 수 있습니다."));
      return false;
    }
    if (this.#autoSaveInFlight || this.#autosaveTimer !== null || this.#pendingAutoSave !== null) {
      this.#update(
        withNotice(this.#state, "자동 저장이 끝난 뒤 현재 편집 내용을 버전으로 남겨 주세요."),
      );
      return false;
    }
    if (this.#state.autoSave === "failed") {
      this.#update(
        withNotice(
          this.#state,
          "자동 저장에 실패했습니다. 현재 편집 내용을 다시 저장한 뒤 버전으로 남겨 주세요.",
        ),
      );
      return false;
    }
    if (!hasValidTitle(this.#state.draft.title)) {
      this.#update(withNotice(this.#state, "제목을 입력한 뒤 저장하고 버전으로 남겨 주세요."));
      return false;
    }
    if (needsCheckpoint(this.#state)) {
      this.#update(withNotice(this.#state, "현재 편집 내용을 먼저 버전으로 남겨 주세요."));
      return false;
    }
    this.#draftActionInFlight = true;
    return true;
  }

  /** Save the current canvas before an action that promotes or stages its working copy. */
  async #ensureLatestBodySaved(): Promise<boolean> {
    if (this.#autoSaveInFlight || this.#pendingAutoSave !== null) {
      this.#update(withNotice(this.#state, "자동 저장이 끝난 뒤 이 작업을 실행할 수 있습니다."));
      return false;
    }
    if (!this.#validateCurrentDraft()) return false;
    const timer = this.#autosaveTimer;
    if (timer !== null) {
      this.#clearAutosave();
      return (
        (await this.#saveBlocks(timer.request.blocks, {
          automatic: false,
          baseContentVersion: timer.request.baseContentVersion,
          draftId: timer.request.draftId,
          summary: timer.request.summary,
          title: timer.request.title,
          version: timer.request.version,
        })) !== null
      );
    }
    if (this.#state.autoSave === "saved" && this.#state.draft?.workingCopy != null) return true;
    return (
      (await this.#saveBlocks(this.#state.blocks, {
        automatic: false,
        summary: this.#state.draft?.workingCopy?.summary ?? this.#activeRevisionSummary() ?? "",
        title: this.#state.draft?.title,
      })) !== null
    );
  }

  #validateCurrentDraft(): boolean {
    const title = this.#state.draft?.title ?? "";
    if (!hasValidTitle(title)) {
      this.#update({
        ...withNotice(this.#state, "제목을 입력한 뒤 저장하세요."),
        error: "제목을 입력하세요.",
      });
      return false;
    }
    if (!hasPersistableBody(this.#state.blocks)) {
      this.#update({
        ...withNotice(this.#state, "제목과 본문을 입력한 뒤 저장하세요."),
        error: "저장할 본문이 없습니다.",
      });
      return false;
    }
    return true;
  }

  #refuseEditWhileBusy(): void {
    this.#update({
      ...this.#state,
      notice: "현재 작업이 끝난 뒤 본문을 편집할 수 있습니다.",
    });
  }

  #captureFocus(): FocusRestoreTarget | null {
    const active = this.#root.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement) || !this.#root.contains(active)) return null;
    const block = active.closest<HTMLElement>("[data-block-index]");
    const selectionStart =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? active.selectionStart
        : null;
    const selectionEnd =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? active.selectionEnd
        : null;
    return {
      id: active.id.length === 0 ? null : active.id,
      key: active.dataset.focusKey ?? null,
      blockIndex: block?.dataset.blockIndex ?? null,
      option: active.dataset.option ?? null,
      value: active.dataset.value ?? null,
      panel: active.closest<HTMLElement>("[data-writing-panel]")?.dataset.writingPanel ?? null,
      draftId: active.dataset.draftId ?? null,
      tagName: active.tagName,
      type: active.getAttribute("type"),
      ariaLabel: active.getAttribute("aria-label"),
      selectionStart,
      selectionEnd,
    };
  }

  #restoreFocus(): void {
    const target = this.#focusRestoreTarget;
    if (target === null) return;
    const replacement = this.#findFocusTarget(target);
    if (replacement === null || replacement.matches(":disabled")) {
      if (!this.#state.busy) this.#focusRestoreTarget = null;
      return;
    }
    replacement.focus({ preventScroll: true });
    if (
      (replacement instanceof HTMLInputElement || replacement instanceof HTMLTextAreaElement) &&
      target.selectionStart !== null &&
      target.selectionEnd !== null
    ) {
      try {
        replacement.setSelectionRange(target.selectionStart, target.selectionEnd);
      } catch {
        // Some input types do not expose a selectable range; focus itself is still preserved.
      }
    }
    this.#focusRestoreTarget = null;
  }

  #findFocusTarget(target: FocusRestoreTarget): HTMLElement | null {
    if (target.id !== null) {
      const byId = this.#root.ownerDocument.getElementById(target.id);
      if (byId instanceof HTMLElement && this.#root.contains(byId)) return byId;
    }
    if (target.key !== null) {
      for (const candidate of this.#root.querySelectorAll<HTMLElement>("[data-focus-key]")) {
        if (candidate.dataset.focusKey === target.key) return candidate;
      }
    }
    if (target.option !== null && target.value !== null) {
      for (const candidate of this.#root.querySelectorAll<HTMLElement>("[data-option]")) {
        if (
          candidate.dataset.option === target.option &&
          candidate.dataset.value === target.value
        ) {
          return candidate;
        }
      }
    }
    if (target.draftId !== null) {
      for (const candidate of this.#root.querySelectorAll<HTMLElement>("[data-draft-id]")) {
        if (candidate.dataset.draftId === target.draftId) return candidate;
      }
    }
    if (target.panel !== null && target.tagName === "SUMMARY") {
      for (const panel of this.#root.querySelectorAll<HTMLElement>("[data-writing-panel]")) {
        if (panel.dataset.writingPanel !== target.panel) continue;
        const summary = panel.querySelector<HTMLElement>("summary");
        if (summary !== null) return summary;
      }
    }
    if (target.blockIndex === null) return null;
    const block = Array.from(this.#root.querySelectorAll<HTMLElement>("[data-block-index]")).find(
      (candidate) => candidate.dataset.blockIndex === target.blockIndex,
    );
    if (block === undefined) return null;
    const candidates = [
      block,
      ...block.querySelectorAll<HTMLElement>("input,textarea,select,button"),
    ];
    return (
      candidates.find(
        (candidate) =>
          candidate.tagName === target.tagName &&
          candidate.getAttribute("type") === target.type &&
          candidate.getAttribute("aria-label") === target.ariaLabel,
      ) ?? null
    );
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.code;
    if (code !== null && REFUSALS[code] !== undefined) return REFUSALS[code] as string;
    return error.problem?.detail ?? error.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}

function isLength(value: unknown): value is WritingState["options"]["length"] {
  return value === "short" || value === "medium" || value === "long";
}

function isTone(value: unknown): value is WritingState["options"]["tone"] {
  return value === "calm" || value === "warm" || value === "lively";
}

function isStructure(value: unknown): value is WritingState["options"]["structure"] {
  return value === "plain" || value === "sectioned" || value === "story";
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
