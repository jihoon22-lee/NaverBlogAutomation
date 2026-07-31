/**
 * Writing workspace controller.
 *
 * One click performs one server action. Generation and staging never run twice at once, and staging
 * progress arrives over SSE with the same bounded reconnect policy as engagement runs.
 */

import { ApiError, type DraftGenerationOptions, LocalApiClient } from "../api/client";
import { TERMINAL_RUN_EVENTS, type RunStreamFactory, eventSourceStream } from "../api/run-stream";
import type { PostDraft, PublishRun } from "../api/types";
import {
  type WritingOptions,
  type WritingState,
  activeRevision,
  blocksFromText,
  initialWritingState,
  startWorking,
  withDraft,
  withFailure,
  withLoaded,
  withNotice,
  withOptions,
  withRun,
  withSeed,
} from "../state/writing";
import { type WritingHandlers, renderWriting } from "../views/writing";

const REFUSALS: Record<string, string> = {
  blog_id_missing: "설정에서 내 블로그 ID를 먼저 저장하세요.",
  draft_not_found: "초안을 찾을 수 없습니다.",
  duplicate_image_reference: "생성 결과가 같은 이미지를 두 번 사용했습니다.",
  generation_unavailable: "선택한 provider가 구성되지 않았습니다.",
  image_limit_reached: "이미지 개수 상한에 도달했습니다.",
  invalid_image: "허용되지 않는 이미지입니다.",
  login_required: "네이버에 다시 로그인해야 합니다.",
  no_active_revision: "먼저 본문을 생성하거나 저장하세요.",
  no_usable_tags: "사용할 수 있는 태그를 만들지 못했습니다.",
  seed_text_missing: "초안 text가 비어 있습니다.",
  unknown_image_reference: "본문이 없는 이미지를 참조했습니다.",
};

type WritingApi = Pick<
  LocalApiClient,
  | "blogCategories"
  | "composeDraft"
  | "createDraft"
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
  stream?: RunStreamFactory;
}

export class WritingController {
  readonly #api: WritingApi;
  readonly #root: Element;
  readonly #stream: RunStreamFactory;
  #state: WritingState = initialWritingState();
  #source: { close(): void } | null = null;

  constructor(root: Element, options: WritingControllerOptions = {}) {
    this.#root = root;
    this.#api = options.api ?? new LocalApiClient();
    this.#stream = options.stream ?? eventSourceStream;
  }

  get state(): WritingState {
    return this.#state;
  }

  render(): void {
    renderWriting(this.#root, this.#state, this.#handlers());
  }

  /** Load providers, categories, and recent drafts, then render once. */
  async load(): Promise<void> {
    this.#update(
      startWorking(this.#state, this.#state.phase === "empty" ? "seed" : this.#state.phase),
    );
    try {
      const [providers, categories, drafts] = await Promise.all([
        this.#api.llmProviders(),
        this.#api.blogCategories(),
        this.#api.drafts(),
      ]);
      this.#update(withLoaded(this.#state, { categories, drafts, providers }));
    } catch (error) {
      this.#update(withFailure(this.#state, describe(error)));
    }
  }

  async createDraft(): Promise<PostDraft | null> {
    if (this.#state.busy || this.#state.seedTitle.trim().length === 0) return null;
    this.#update(startWorking(this.#state, "seed"));
    return this.#guard(async () =>
      this.#api.createDraft({
        title: this.#state.seedTitle.trim(),
        seedText: this.#state.seedText,
        categoryNo: this.#state.selectedCategoryNo,
      }),
    );
  }

  async openDraft(draftId: string): Promise<PostDraft | null> {
    if (this.#state.busy) return null;
    this.#update(startWorking(this.#state, "review"));
    return this.#guard(async () => this.#api.draft(draftId));
  }

  async compose(): Promise<PostDraft | null> {
    return this.#generate("composing", (draftId, options) =>
      this.#api.composeDraft(draftId, options),
    );
  }

  async refine(): Promise<PostDraft | null> {
    return this.#generate("composing", (draftId, options) =>
      this.#api.refineDraft(draftId, options),
    );
  }

  async generateTags(): Promise<PostDraft | null> {
    return this.#generate("tagging", (draftId, options) =>
      this.#api.generateDraftTags(draftId, options),
    );
  }

  async saveBody(text: string): Promise<PostDraft | null> {
    const draft = this.#state.draft;
    if (draft === null || this.#state.busy) return null;
    const blocks = blocksFromText(text, activeRevision(this.#state));
    if (blocks.length === 0) {
      this.#update(withFailure(this.#state, "저장할 본문이 없습니다."));
      return null;
    }
    this.#update(startWorking(this.#state, "review"));
    return this.#guard(async () =>
      this.#api.saveDraftBody(draft.id, { title: draft.title, blocks }),
    );
  }

  async uploadImage(file: File): Promise<PostDraft | null> {
    const draft = this.#state.draft;
    if (draft === null || this.#state.busy) return null;
    this.#update(startWorking(this.#state, this.#state.phase));
    return this.#guard(async () => this.#api.uploadDraftImage(draft.id, file));
  }

  async deleteImage(imageId: string): Promise<PostDraft | null> {
    const draft = this.#state.draft;
    if (draft === null || this.#state.busy) return null;
    this.#update(startWorking(this.#state, this.#state.phase));
    return this.#guard(async () => this.#api.deleteDraftImage(draft.id, imageId));
  }

  async toggleTag(tag: string): Promise<PostDraft | null> {
    const draft = this.#state.draft;
    if (draft === null || this.#state.busy) return null;
    const selected = draft.tags
      .filter((entry) => (entry.tag === tag ? !entry.selected : entry.selected))
      .map((entry) => entry.tag);
    this.#update(startWorking(this.#state, "tagging"));
    return this.#guard(async () => this.#api.patchDraftTags(draft.id, { selected }));
  }

  async addTags(tags: string[]): Promise<PostDraft | null> {
    const draft = this.#state.draft;
    if (draft === null || this.#state.busy || tags.length === 0) return null;
    this.#update(startWorking(this.#state, "tagging"));
    return this.#guard(async () => this.#api.patchDraftTags(draft.id, { added: tags }));
  }

  async selectRevision(revisionId: string): Promise<PostDraft | null> {
    const draft = this.#state.draft;
    if (draft === null || this.#state.busy) return null;
    this.#update(startWorking(this.#state, "review"));
    return this.#guard(async () =>
      this.#api.patchDraft(draft.id, { activeRevisionId: revisionId }),
    );
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
    this.#update(startWorking(this.#state, "staging"));
    let run: PublishRun;
    try {
      run = await this.#api.stageDraft(draft.id);
    } catch (error) {
      this.#update(withFailure(this.#state, describe(error)));
      return null;
    }
    this.#update(withRun(this.#state, run));
    this.#subscribe(draft.id);
    return run;
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
      onCompose: () => void this.compose(),
      onCreateDraft: () => void this.createDraft(),
      onDeleteImage: (imageId) => void this.deleteImage(imageId),
      onGenerateTags: () => void this.generateTags(),
      onOpenDraft: (draftId) => void this.openDraft(draftId),
      onOptionChange: (option, value) => this.setOption(option, value),
      onRefine: () => void this.refine(),
      onSaveBody: (text) => void this.saveBody(text),
      onSeedChange: (field, value) => this.setSeed(field, value),
      onStage: () => void this.stage(),
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
      }),
    );
  }

  async #guard(call: () => Promise<PostDraft>): Promise<PostDraft | null> {
    try {
      const draft = await call();
      this.#update(withDraft(this.#state, draft));
      return draft;
    } catch (error) {
      this.#update(withFailure(this.#state, describe(error)));
      return null;
    }
  }

  #subscribe(draftId: string): void {
    this.#closeSource();
    this.#source = this.#stream(this.#api.stagingEventsUrl(draftId), {
      onError: () => this.#closeSource(),
      onEvent: (event) => {
        if (!TERMINAL_RUN_EVENTS.has(event.event)) return;
        this.#closeSource();
        void this.#refresh(draftId);
      },
    });
  }

  async #refresh(draftId: string): Promise<void> {
    try {
      this.#update(withDraft(this.#state, await this.#api.draft(draftId)));
    } catch (error) {
      this.#update(withFailure(this.#state, describe(error)));
    }
  }

  #closeSource(): void {
    this.#source?.close();
    this.#source = null;
  }

  #update(state: WritingState): void {
    this.#state = state;
    this.render();
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
