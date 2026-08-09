/**
 * Writing workspace view.
 *
 * Renders the seed form, the generated body, the tag selection, and the staging progress. Every
 * control is a button, input, or textarea so the whole flow works from the keyboard, and the status
 * line is a live region.
 */

import type {
  BodyBlock,
  DraftRevision,
  LlmProviderName,
  PostDraft,
  PublishStep,
} from "../api/types";
import {
  type WritingState,
  activeRevision,
  canGenerate,
  canStage,
  needsCheckpoint,
  revisionText,
} from "../state/writing";

/** Apply a block edit against the controller's latest state, not a render snapshot. */
export type BodyBlocksUpdater = (current: BodyBlock[]) => BodyBlock[];

export interface WritingHandlers {
  onAddTags(tags: string[]): void;
  /** Legacy array contract; retain it until the controller adapter is migrated. */
  onBlocksChange?(blocks: BodyBlock[]): void;
  /** Preferred contract: the controller applies this updater to its latest blocks. */
  onBlocksChangeUpdate?(update: BodyBlocksUpdater): void;
  /** Commit a structural block change and redraw the canvas without disrupting text input. */
  onBlocksStructureChange?(blocks: BodyBlock[]): void;
  /** Preferred structural variant of onBlocksChangeUpdate. */
  onBlocksStructureChangeUpdate?(update: BodyBlocksUpdater): void;
  onBodyChange?(text: string): void;
  onCheckpoint?(): void;
  onCompose(): void;
  onCompleteWithAi(): void;
  onCreateDraft(): void;
  onDeleteDraft(): void;
  onDeleteImage(imageId: string): void;
  onGenerateTags(): void;
  onInsertImage?(imageId: string, position: number): void;
  onImageInsertionPointChange?(position: number): void;
  onOptionChange(option: string, value: string): void;
  onOpenDraft(draftId: string): void;
  onStartNew?(): void;
  onRefine(): void;
  /** Legacy save contract; the view passes its latest local canvas value as a fallback. */
  onSaveBlocks?(blocks: BodyBlock[]): void;
  /** Preferred contract: the controller reads its latest state.blocks itself. */
  onSaveBlocksLatest?(): void;
  onSaveBody?(text: string): void;
  onSeedChange(field: "title" | "text" | "category", value: string): void;
  onStage(): void;
  onSyncCategories(): void;
  onTitleChange(title: string): void;
  onToggleTag(tag: string): void;
  onUploadImage(file: File): void;
}

const LENGTHS: readonly [string, string][] = [
  ["short", "짧게"],
  ["medium", "보통"],
  ["long", "길게"],
];
const TONES: readonly [string, string][] = [
  ["calm", "담담하게"],
  ["warm", "따뜻하게"],
  ["lively", "활기차게"],
];
const STRUCTURES: readonly [string, string][] = [
  ["plain", "문단만"],
  ["sectioned", "구역 나누기"],
  ["story", "시간 순서"],
];
const PROVIDER_LABELS: Record<LlmProviderName, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  anthropic: "Claude",
};
const DRAFT_STATUS_LABELS: Record<PostDraft["status"], string> = {
  collecting: "작성 중",
  composed: "본문 준비",
  refining: "다듬는 중",
  tagged: "태그 확인",
  staging: "임시저장 중",
  staged: "임시저장 완료",
  abandoned: "중단됨",
};

interface BlocksReference {
  value: BodyBlock[];
}
const REVISION_KIND_LABELS: Record<DraftRevision["kind"], string> = {
  seed: "메모",
  composed: "AI 초안",
  refined: "AI 다듬기",
  user_edited: "직접 편집",
};
const STEP_LABELS: Record<string, string> = {
  title: "제목 입력",
  body: "본문 입력",
  images: "이미지 첨부",
  tags: "태그 입력",
  save: "임시저장",
};
const STEP_STATE_LABELS: Record<string, string> = {
  pending: "대기",
  running: "진행 중",
  succeeded: "성공",
  skipped: "건너뜀",
  failed: "실패",
  unconfirmed: "확인 불가",
};

/** Render the writing workspace into `root`. */
export function renderWriting(root: Element, state: WritingState, handlers: WritingHandlers): void {
  const document = root.ownerDocument;
  const openPanels = captureOpenPanels(root);
  root.textContent = "";

  const shell = document.createElement("div");
  shell.className = "writing-shell";
  shell.dataset.mode = state.draft === null ? "start" : "editor";
  shell.setAttribute("aria-labelledby", "writing-title");
  shell.append(renderPageHeader(document, state, handlers));

  if (state.draft === null) {
    const layout = document.createElement("div");
    layout.className = "writing-start-layout";
    const recent = document.createElement("aside");
    recent.className = "writing-recent-drafts-sidebar";
    recent.setAttribute("aria-label", "최근 초안");
    recent.append(renderDraftList(document, state, handlers));
    layout.append(renderSeed(document, state, handlers), recent);
    shell.append(layout);
  } else {
    const layout = document.createElement("div");
    layout.className = "writing-editor-layout";
    const main = document.createElement("section");
    main.className = "writing-editor-main";
    main.append(renderBody(document, state, handlers, openPanels));

    const sidebar = document.createElement("aside");
    sidebar.className = "writing-editor-sidebar";
    sidebar.setAttribute("aria-label", "글쓰기 보조 도구");
    sidebar.append(
      renderWritingPanel(
        document,
        "drafts",
        "최근 초안",
        renderDraftList(document, state, handlers, false),
        openPanels,
        false,
      ),
      renderWritingPanel(
        document,
        "ai",
        "AI 도구",
        renderOptions(document, state, handlers, false),
        openPanels,
        defaultPanelOpen(state, "ai"),
      ),
      renderWritingPanel(
        document,
        "images",
        "이미지",
        renderImages(document, state, handlers, false),
        openPanels,
        false,
      ),
      renderWritingPanel(
        document,
        "tags",
        "태그",
        renderTags(document, state, handlers, false),
        openPanels,
        defaultPanelOpen(state, "tags"),
      ),
      renderWritingPanel(
        document,
        "revisions",
        "변경 기록",
        renderRevisionPanel(document, state, handlers, false),
        openPanels,
        defaultPanelOpen(state, "revisions"),
      ),
      renderWritingPanel(
        document,
        "staging",
        "임시저장",
        renderStaging(document, state, handlers, false),
        openPanels,
        defaultPanelOpen(state, "staging"),
      ),
    );
    layout.append(main, sidebar);
    shell.append(layout);
  }
  root.append(shell);
}

type PanelOpenState = Map<string, boolean>;

function captureOpenPanels(root: Element): PanelOpenState {
  const openPanels: PanelOpenState = new Map();
  for (const panel of root.querySelectorAll<HTMLDetailsElement>("details[data-writing-panel]")) {
    const key = panel.dataset.writingPanel;
    if (key !== undefined) openPanels.set(key, panel.open);
  }
  return openPanels;
}

function renderPageHeader(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
): HTMLElement {
  const header = document.createElement("header");
  header.className = "writing-page-header";
  const title = document.createElement("h2");
  title.id = "writing-title";
  title.textContent = "글쓰기";
  const headingGroup = document.createElement("div");
  headingGroup.className = "writing-page-heading";
  headingGroup.append(title);
  const description = document.createElement("p");
  description.className = "writing-page-description";
  description.textContent =
    state.draft === null
      ? "짧은 메모에서 시작해 나만의 초안을 만들어 보세요."
      : "제목과 본문을 먼저 다듬고, 필요한 도구만 펼쳐 보세요.";
  headingGroup.append(description);

  const actions = document.createElement("div");
  actions.className = "writing-page-actions";
  const status = document.createElement("p");
  status.id = "writing-status";
  status.className = "writing-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.dataset.state = state.error !== null ? "error" : state.busy ? "busy" : "default";
  status.textContent = statusMessage(state);
  actions.append(status);
  if (state.draft !== null) {
    const newDraft = button(document, "start-new-draft-button", "새 글 시작", () =>
      handlers.onStartNew?.(),
    );
    newDraft.className = "writing-start-new-action";
    newDraft.disabled = state.busy;
    actions.append(newDraft);
  }
  header.append(headingGroup, actions);
  return header;
}

function renderWritingPanel(
  document: Document,
  key: string,
  label: string,
  content: Element,
  openPanels: PanelOpenState,
  defaultOpen: boolean,
): HTMLDetailsElement {
  const panel = document.createElement("details");
  panel.className = "writing-tool-panel";
  panel.dataset.writingPanel = key;
  panel.open = openPanels.get(key) ?? defaultOpen;
  const summary = document.createElement("summary");
  summary.id = `writing-panel-${key}-summary`;
  summary.textContent = label;
  content.id = content.id || `writing-panel-${key}-content`;
  summary.setAttribute("aria-controls", content.id);
  panel.append(summary, content);
  return panel;
}

function defaultPanelOpen(state: WritingState, key: string): boolean {
  if (key === "ai") {
    return (
      state.phase === "composing" ||
      (state.draft !== null && state.blocks.length === 0 && activeRevision(state) === null)
    );
  }
  if (key === "tags") return state.phase === "tagging";
  if (key === "staging") return state.phase === "staging";
  return false;
}

function statusMessage(state: WritingState): string {
  if (state.error !== null) return state.error;
  if (state.notice !== null) return state.notice;
  switch (state.phase) {
    case "empty":
      return "초안과 이미지를 준비해 새 글을 시작하세요.";
    case "seed":
      return "제목과 짧은 메모를 확인하고 본문을 생성하세요.";
    case "composing":
      return "본문을 생성하는 중입니다.";
    case "review":
      return "본문을 확인하고 필요한 만큼 다듬으세요.";
    case "tagging":
      return "태그를 고르고 임시저장하세요.";
    case "staging":
      return "임시저장을 진행합니다. 발행은 에디터에서 직접 확인하세요.";
    default:
      return "요청을 처리하지 못했습니다.";
  }
}

function renderSeed(document: Document, state: WritingState, handlers: WritingHandlers): Element {
  const section = document.createElement("section");
  section.className = "seed-panel";
  section.setAttribute("aria-labelledby", "seed-panel-title");
  const title = heading(document, "새 글 초안");
  title.id = "seed-panel-title";
  section.append(title);

  const intro = document.createElement("p");
  intro.className = "seed-panel-intro";
  intro.textContent = "제목과 짧은 메모만 입력하면 AI가 글의 첫 초안을 정리합니다.";
  section.append(intro);

  let syncSeedActions = (): void => undefined;
  const titleField = labelledInput(document, "seed-title", "제목", state.seedTitle, (value) => {
    handlers.onSeedChange("title", value);
    syncSeedActions();
  });
  const titleInput = titleField.querySelector<HTMLInputElement>("input");
  if (titleInput !== null) {
    titleInput.maxLength = 300;
    titleInput.required = true;
  }
  section.append(titleField);

  const label = document.createElement("label");
  label.htmlFor = "seed-text";
  label.textContent = "짧은 메모";
  const editor = document.createElement("textarea");
  editor.id = "seed-text";
  editor.rows = 6;
  editor.maxLength = 20_000;
  editor.required = true;
  editor.value = state.seedText;
  editor.addEventListener("input", () => {
    handlers.onSeedChange("text", editor.value);
    syncSeedActions();
  });
  section.append(label, editor);

  section.append(renderCategories(document, state, handlers));

  const create = button(document, "create-draft-button", "초안만 저장", handlers.onCreateDraft);
  const complete = button(
    document,
    "complete-draft-button",
    "AI로 초안 완성",
    handlers.onCompleteWithAi,
  );
  const providerConfigured = state.providers.some((provider) => provider.configured);
  syncSeedActions = () => {
    const titleValid = titleInput !== null && titleInput.value.trim().length !== 0;
    const textValid = editor.value.trim().length !== 0;
    create.disabled = state.busy || !titleValid || !textValid;
    complete.disabled = create.disabled || !providerConfigured;
  };
  syncSeedActions();
  section.append(complete, create);
  if (!providerConfigured) {
    const providerHint = document.createElement("p");
    providerHint.className = "provider-missing-hint";
    providerHint.textContent =
      "AI 연결이 설정되지 않아 AI 초안을 완성할 수 없습니다. 초안만 저장한 뒤 연결 설정을 확인하세요.";
    section.append(providerHint);
  }
  return section;
}

function renderCategories(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
): Element {
  const group = document.createElement("div");
  group.className = "category-panel";
  const label = document.createElement("label");
  label.htmlFor = "seed-category";
  label.textContent = "카테고리";
  const select = document.createElement("select");
  select.id = "seed-category";
  select.disabled = state.busy;
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "선택하지 않음";
  select.append(empty);
  for (const category of state.categories) {
    const option = document.createElement("option");
    option.value = String(category.categoryNo);
    option.textContent = category.name;
    option.selected = state.selectedCategoryNo === category.categoryNo;
    select.append(option);
  }
  select.addEventListener("change", () => handlers.onSeedChange("category", select.value));
  group.append(label, select);
  const sync = button(
    document,
    "sync-categories-button",
    "카테고리 새로 읽기",
    handlers.onSyncCategories,
  );
  sync.disabled = state.busy;
  group.append(sync);
  return group;
}

function renderDraftList(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
  showHeading = true,
): Element {
  const section = document.createElement("section");
  section.className = "draft-list-panel writing-recent-drafts";
  if (showHeading) {
    const title = heading(document, "최근 초안");
    title.id = "recent-drafts-title";
    section.setAttribute("aria-labelledby", title.id);
    section.append(title);
  }
  const list = document.createElement("ul");
  list.className = "draft-list";
  for (const draft of state.drafts) {
    const item = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "draft-item";
    open.dataset.draftId = draft.id;
    open.disabled = state.busy;
    open.setAttribute("aria-pressed", String(state.draft?.id === draft.id));
    open.textContent = draftLabel(draft);
    open.addEventListener("click", () => handlers.onOpenDraft(draft.id));
    item.append(open);
    list.append(item);
  }
  if (state.drafts.length === 0) {
    const empty = document.createElement("li");
    empty.className = "draft-list-empty";
    empty.textContent = "저장된 초안이 없습니다.";
    list.append(empty);
  }
  section.append(list);
  return section;
}

function renderImages(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
  showHeading = true,
): Element {
  const section = document.createElement("section");
  section.className = "images-panel";
  if (showHeading) section.append(heading(document, "이미지"));

  const checkpointNeeded =
    needsCheckpoint(state) || state.autoSave === "saving" || state.autoSave === "failed";
  if (checkpointNeeded) {
    const hint = document.createElement("p");
    hint.className = "checkpoint-required-hint";
    hint.setAttribute("role", "status");
    hint.textContent =
      state.autoSave === "saving"
        ? "자동 저장이 끝난 뒤 이미지를 관리할 수 있습니다."
        : state.autoSave === "failed"
          ? "자동 저장에 실패했습니다. 현재 편집 내용을 다시 저장한 뒤 이미지를 관리하세요."
          : "이미지를 추가하거나 삭제하기 전에 현재 편집 내용을 먼저 버전으로 남겨 주세요.";
    section.append(hint);
  }

  const label = document.createElement("label");
  label.htmlFor = "image-input";
  label.textContent = "이미지 추가";
  const input = document.createElement("input");
  input.id = "image-input";
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/webp,image/gif";
  input.disabled = state.busy || checkpointNeeded;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file !== undefined) handlers.onUploadImage(file);
  });
  section.append(label, input);

  const list = document.createElement("ul");
  list.className = "image-list";
  for (const image of state.draft?.images ?? []) {
    const item = document.createElement("li");
    item.dataset.imageId = image.id;
    const name = document.createElement("span");
    name.textContent = `${image.originalFilename} · ${Math.ceil(image.byteSize / 1024)}KB`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "image-remove";
    remove.dataset.imageId = image.id;
    remove.textContent = "삭제";
    remove.disabled = state.busy || checkpointNeeded;
    remove.addEventListener("click", () => handlers.onDeleteImage(image.id));
    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "image-insert";
    insert.textContent = "본문에 넣기";
    insert.disabled = state.busy;
    insert.addEventListener("click", () => handlers.onInsertImage?.(image.id, state.imageInsertAt));
    item.append(name, insert, remove);
    list.append(item);
  }
  section.append(list);
  const insertion = document.createElement("p");
  insertion.className = "image-insertion-note";
  insertion.textContent = `새 이미지는 ${state.imageInsertAt + 1}번째 블록 위치에 넣습니다.`;
  section.append(insertion);
  return section;
}

function renderOptions(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
  showHeading = true,
): Element {
  const section = document.createElement("section");
  section.className = "writing-options-panel";
  if (showHeading) section.append(heading(document, "생성 옵션"));
  section.append(renderProviders(document, state, handlers));
  if (!state.providers.some((provider) => provider.configured)) {
    const providerHint = document.createElement("p");
    providerHint.className = "provider-missing-hint";
    providerHint.textContent =
      "AI 연결이 설정되지 않았습니다. 연결 설정을 완료하면 생성·다듬기 도구를 사용할 수 있습니다.";
    section.append(providerHint);
  }
  section.append(
    optionGroup(document, "length", "길이", LENGTHS, state.options.length, handlers, state.busy),
    optionGroup(document, "tone", "분위기", TONES, state.options.tone, handlers, state.busy),
    optionGroup(
      document,
      "structure",
      "구성",
      STRUCTURES,
      state.options.structure,
      handlers,
      state.busy,
    ),
  );

  const checkpointNeeded = needsCheckpoint(state);
  const compose = button(document, "compose-button", "본문 생성", handlers.onCompose);
  compose.disabled = !canGenerate(state) || checkpointNeeded;
  if (checkpointNeeded) {
    const checkpointHint = document.createElement("p");
    checkpointHint.className = "checkpoint-required-hint";
    checkpointHint.textContent =
      "현재 편집 내용을 먼저 버전으로 남기면 AI 도구를 사용할 수 있습니다.";
    section.append(checkpointHint);
  }
  const requestLabel = document.createElement("label");
  requestLabel.htmlFor = "refine-request";
  requestLabel.textContent = "다듬기 요청 사항";
  const request = document.createElement("input");
  request.id = "refine-request";
  request.type = "text";
  request.value = state.options.request;
  request.disabled = state.busy;
  request.addEventListener("input", () => handlers.onOptionChange("request", request.value));
  const refine = button(document, "refine-button", "다듬기 요청", handlers.onRefine);
  refine.disabled =
    !canGenerate(state) ||
    !hasPersistableBody(state.blocks) ||
    !hasValidTitle(state.draft?.title) ||
    checkpointNeeded;
  section.append(compose, requestLabel, request, refine);
  return section;
}

function renderProviders(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
): Element {
  const group = document.createElement("fieldset");
  group.className = "provider-group";
  group.setAttribute("role", "radiogroup");
  const legend = document.createElement("legend");
  legend.id = "provider-group-label";
  legend.textContent = "생성 모델";
  group.setAttribute("aria-labelledby", legend.id);
  group.append(legend);
  for (const provider of state.providers) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "provider-choice";
    choice.dataset.provider = provider.provider;
    choice.dataset.focusKey = `provider:${provider.provider}`;
    choice.disabled = state.busy || !provider.configured;
    const checked = state.options.provider === provider.provider;
    choice.setAttribute("role", "radio");
    choice.setAttribute("aria-checked", String(checked));
    // Keep aria-pressed for existing keyboard styling and integrations while migrating to radio semantics.
    choice.setAttribute("aria-pressed", String(checked));
    choice.textContent = provider.configured
      ? `${PROVIDER_LABELS[provider.provider]} · ${provider.model}`
      : `${PROVIDER_LABELS[provider.provider]} (설정 필요)`;
    choice.addEventListener("click", () => handlers.onOptionChange("provider", provider.provider));
    group.append(choice);
  }
  return group;
}

function renderBody(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
  openPanels: PanelOpenState,
): Element {
  const section = document.createElement("section");
  section.className = "body-panel";
  section.setAttribute("aria-labelledby", "body-panel-title");
  const bodyTitle = heading(document, "본문 편집");
  bodyTitle.id = "body-panel-title";
  section.append(bodyTitle);

  const revision = activeRevision(state);
  const hasEditorContent = state.blocks.length > 0 || revision !== null;
  const revisionMeta = document.createElement("p");
  revisionMeta.className = "revision-meta";
  revisionMeta.textContent =
    revision === null
      ? ""
      : `${revision.roundNo}번째 버전 · ${REVISION_KIND_LABELS[revision.kind]}${
          revision.provider === null ? "" : ` · ${revision.provider}`
        }`;

  const titleLabel = document.createElement("label");
  titleLabel.htmlFor = "draft-title";
  titleLabel.textContent = "제목";
  titleLabel.className = "editor-title-label";
  const title = document.createElement("input");
  title.id = "draft-title";
  title.type = "text";
  title.maxLength = 300;
  title.className = "editor-title-input";
  title.required = true;
  title.value = state.draft?.title ?? "";
  title.disabled = state.busy;
  const blocksRef: BlocksReference = { value: copyBlocks(state.blocks) };
  let syncBlockActions = (_next: BodyBlock[]): void => undefined;
  title.addEventListener("input", () => {
    handlers.onTitleChange(title.value);
    syncBlockActions(blocksRef.value);
  });

  const documentMeta = document.createElement("p");
  documentMeta.className = "writing-document-meta";
  documentMeta.textContent = `${Array.from(state.bodyText).length}자 · 블록 ${state.blocks.length}개`;
  const autosave = document.createElement("p");
  autosave.className = "autosave-status";
  autosave.setAttribute("aria-live", "polite");
  autosave.textContent = {
    idle: "편집하면 자동 저장합니다.",
    saving: "자동 저장 중입니다.",
    saved: "자동 저장되었습니다.",
    failed: "자동 저장에 실패했습니다. 편집 저장을 다시 시도하세요.",
  }[state.autoSave];
  const metaBar = document.createElement("div");
  metaBar.className = "editor-meta-bar";
  metaBar.append(revisionMeta, documentMeta, autosave);
  section.append(titleLabel, title, metaBar);

  if (!hasEditorContent) {
    const empty = document.createElement("p");
    empty.className = "editor-empty-state";
    empty.textContent = "아직 본문이 없습니다. AI로 첫 초안을 만든 뒤 여기서 바로 다듬어 보세요.";
    const compose = button(
      document,
      "empty-editor-compose-button",
      "본문 초안 만들기",
      handlers.onCompose,
    );
    compose.disabled = !canGenerate(state);
    section.append(empty, compose);
  }

  section.append(renderEditorTools(document, state, openPanels));

  const actions = document.createElement("div");
  actions.className = "body-actions";
  const save = button(document, "save-body-button", "지금 저장", () => {
    if (handlers.onSaveBlocksLatest !== undefined) handlers.onSaveBlocksLatest();
    else handlers.onSaveBlocks?.(blocksRef.value);
  });
  const checkpoint = button(document, "checkpoint-body-button", "버전으로 남기기", () =>
    handlers.onCheckpoint?.(),
  );
  let validationHint: HTMLParagraphElement | null = null;
  let checkpointHint: HTMLParagraphElement | null = null;
  syncBlockActions = (next: BodyBlock[]): void => {
    const valid = hasPersistableBody(next);
    const titleValid = hasValidTitle(title.value);
    const checkpointNeeded =
      needsCheckpoint(state) || hasLocalCheckpointChanges(state, next, title.value);
    const protectedActionBlocked =
      state.busy ||
      state.autoSave === "saving" ||
      state.autoSave === "failed" ||
      checkpointNeeded ||
      !titleValid;
    save.disabled = state.busy || !hasEditorContent || !valid || !titleValid;
    checkpoint.disabled =
      state.busy || !hasEditorContent || !valid || !titleValid || !checkpointNeeded;
    const compose = document.querySelector<HTMLButtonElement>("#compose-button");
    if (compose !== null) compose.disabled = !canGenerate(state) || checkpointNeeded;
    const refine = document.querySelector<HTMLButtonElement>("#refine-button");
    if (refine !== null)
      refine.disabled = !canGenerate(state) || !valid || !titleValid || checkpointNeeded;
    const generateTags = document.querySelector<HTMLButtonElement>("#generate-tags-button");
    if (generateTags !== null) {
      generateTags.disabled = !canGenerate(state) || !valid || !titleValid || checkpointNeeded;
    }
    const stage = document.querySelector<HTMLButtonElement>("#stage-button");
    if (stage !== null) stage.disabled = !canStage(state) || !valid || !titleValid;
    for (const control of document.querySelectorAll<HTMLElement>(
      "#image-input, .image-remove, .tag-choice, #tag-input, #add-tags-button, .revision-item",
    )) {
      if ("disabled" in control)
        (control as HTMLButtonElement | HTMLInputElement).disabled = protectedActionBlocked;
    }
    if (
      protectedActionBlocked &&
      (checkpointNeeded ||
        state.autoSave === "saving" ||
        state.autoSave === "failed" ||
        !titleValid)
    ) {
      if (checkpointHint === null) {
        checkpointHint = document.createElement("p");
        checkpointHint.className = "checkpoint-required-hint";
        checkpointHint.setAttribute("role", "status");
        actions.append(checkpointHint);
      }
      checkpointHint.textContent = !titleValid
        ? "제목을 입력하고 저장한 뒤 버전으로 남기면 이미지·태그·변경 기록을 사용할 수 있습니다."
        : state.autoSave === "saving"
          ? "자동 저장이 끝난 뒤 이미지·태그·변경 기록을 사용할 수 있습니다."
          : state.autoSave === "failed"
            ? "자동 저장에 실패했습니다. 현재 편집 내용을 다시 저장한 뒤 이미지·태그·변경 기록을 사용하세요."
            : "현재 편집 내용을 먼저 버전으로 남기면 이미지·태그·변경 기록을 사용할 수 있습니다.";
    } else if (checkpointHint !== null) {
      checkpointHint.remove();
      checkpointHint = null;
    }
    if ((!valid || !titleValid) && hasEditorContent && validationHint === null) {
      validationHint = document.createElement("p");
      validationHint.className = "body-validation-hint";
      validationHint.setAttribute("role", "status");
      actions.append(validationHint);
    }
    if (validationHint !== null) {
      validationHint.textContent = !titleValid
        ? "제목을 입력한 뒤 저장하세요."
        : "본문을 저장하려면 빈 문단·목록 항목을 먼저 입력하세요.";
    }
    if (valid && titleValid && validationHint !== null) {
      validationHint.remove();
      validationHint = null;
    }
  };
  actions.append(save, checkpoint);
  section.append(
    renderBlockCanvas(
      document,
      state.blocks,
      state.imageInsertAt,
      handlers,
      state.busy,
      blocksRef,
      syncBlockActions,
    ),
  );
  section.append(actions);
  syncBlockActions(blocksRef.value);
  return section;
}

function renderEditorTools(
  document: Document,
  state: WritingState,
  openPanels: PanelOpenState,
): Element {
  const panel = document.createElement("div");
  panel.className = "editor-assist-panel";
  const outline = document.createElement("nav");
  outline.className = "editor-outline";
  outline.setAttribute("aria-label", "글 구성");
  const outlineTitle = document.createElement("strong");
  outlineTitle.textContent = "글 구성";
  outline.append(outlineTitle);
  state.blocks.forEach((block, index) => {
    if (block.type !== "heading") return;
    const item = button(document, `outline-${index}`, block.text || `소제목 ${index + 1}`, () => {
      document.querySelector<HTMLElement>(`[data-block-index="${index}"] textarea`)?.focus();
    });
    item.className = "outline-item";
    outline.append(item);
  });
  if (outline.querySelectorAll("button").length === 0) {
    const empty = document.createElement("span");
    empty.textContent = "소제목을 추가하면 글 구성이 표시됩니다.";
    outline.append(empty);
  }
  const preview = document.createElement("details");
  preview.className = "editor-preview";
  preview.dataset.writingPanel = "preview";
  preview.open = openPanels.get("preview") ?? false;
  const summary = document.createElement("summary");
  summary.textContent = "네이버 반영 전 미리보기";
  const content = document.createElement("div");
  content.id = "writing-panel-preview-content";
  summary.setAttribute("aria-controls", content.id);
  content.append(renderBlockPreview(document, state.blocks));
  preview.append(summary, content);
  panel.append(outline, preview);
  const help = document.createElement("p");
  help.className = "editor-shortcut-hint";
  help.textContent =
    "Ctrl/⌘ + Alt + 1, 2, 3으로 현재 블록을 소제목·문단·인용으로 바꿀 수 있습니다.";
  panel.append(help);
  return panel;
}

function renderBlockPreview(document: Document, blocks: BodyBlock[]): Element {
  const fragment = document.createElement("div");
  fragment.className = "block-preview-content";
  for (const block of blocks) {
    if (block.type === "heading") {
      const value = document.createElement("h3");
      value.textContent = block.text;
      fragment.append(value);
    } else if (block.type === "paragraph") {
      const value = document.createElement("p");
      value.textContent = block.text;
      fragment.append(value);
    } else if (block.type === "quote") {
      const value = document.createElement("blockquote");
      value.textContent = block.text;
      fragment.append(value);
    } else if (block.type === "ordered_list" || block.type === "unordered_list") {
      const list = document.createElement(block.type === "ordered_list" ? "ol" : "ul");
      for (const item of block.items) {
        const value = document.createElement("li");
        value.textContent = item;
        list.append(value);
      }
      fragment.append(list);
    } else if (block.type === "divider") {
      fragment.append(document.createElement("hr"));
    } else if (block.type === "image") {
      const figure = document.createElement("figure");
      const placeholder = document.createElement("div");
      placeholder.className = "image-preview-placeholder";
      placeholder.textContent = "이미지";
      const caption = document.createElement("figcaption");
      caption.textContent = block.caption ?? "";
      figure.append(placeholder, caption);
      fragment.append(figure);
    }
  }
  return fragment;
}

/** Render a Naver-style block canvas: controls change one block, never flatten the whole body. */
function renderBlockCanvas(
  document: Document,
  blocks: BodyBlock[],
  imageInsertAt: number,
  handlers: WritingHandlers,
  disabled: boolean,
  blocksRef: BlocksReference,
  onBlocksUpdated: (blocks: BodyBlock[]) => void,
): Element {
  const canvas = document.createElement("div");
  canvas.className = "block-canvas";
  canvas.setAttribute("aria-label", "본문 블록 편집기");
  canvas.setAttribute("aria-disabled", String(disabled));
  const commit = (update: BodyBlocksUpdater): void => {
    const next = copyBlocks(update(blocksRef.value));
    blocksRef.value = next;
    dispatchBlockUpdate(handlers, update, next, false);
    onBlocksUpdated(next);
  };
  const commitStructure = (update: BodyBlocksUpdater): void => {
    const next = copyBlocks(update(blocksRef.value));
    blocksRef.value = next;
    dispatchBlockUpdate(handlers, update, next, true);
    onBlocksUpdated(next);
  };
  canvas.append(renderImageInsertionPoint(document, 0, imageInsertAt, handlers, disabled));
  blocks.forEach((block, index) => {
    const row = document.createElement("article");
    row.className = `editor-block editor-block-${block.type}`;
    row.dataset.blockIndex = String(index);
    row.draggable = !disabled;
    row.addEventListener("dragstart", (event) =>
      event.dataTransfer?.setData("text/plain", String(index)),
    );
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = Number.parseInt(event.dataTransfer?.getData("text/plain") ?? "", 10);
      if (!Number.isNaN(from)) commitStructure((current) => moveBlockTo(current, from, index));
    });
    const tools = document.createElement("div");
    tools.className = "block-tools";
    tools.setAttribute("role", "group");
    tools.setAttribute("aria-label", `${index + 1}번째 블록 도구`);
    const blockLabel = BLOCK_TYPES.find(([kind]) => kind === block.type)?.[1] ?? "블록";
    const type = document.createElement("select");
    type.setAttribute("aria-label", `${index + 1}번째 블록 형식`);
    type.title = `${index + 1}번째 블록 형식`;
    type.disabled = disabled;
    const retypableTypes =
      block.type === "image" ? BLOCK_TYPES.filter(([value]) => value === "image") : RETYPABLE_TYPES;
    for (const [value, label] of retypableTypes) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = block.type === value;
      type.append(option);
    }
    if (block.type === "image") type.disabled = true;
    type.addEventListener("change", () =>
      commitStructure((current) => {
        const currentBlock = current[index];
        return currentBlock === undefined
          ? current
          : replaceAt(current, index, retypeBlock(currentBlock, type.value));
      }),
    );
    tools.append(type);
    tools.append(
      smallButton(
        document,
        "위로",
        () => commitStructure((current) => moveBlock(current, index, -1)),
        disabled || index === 0,
      ),
      smallButton(
        document,
        "아래로",
        () => commitStructure((current) => moveBlock(current, index, 1)),
        disabled || index === blocks.length - 1,
      ),
      smallButton(
        document,
        "복제",
        () =>
          commitStructure((current) => {
            const currentBlock = current[index];
            return currentBlock === undefined
              ? current
              : insertAt(current, index + 1, copyBlock(currentBlock));
          }),
        disabled,
      ),
      smallButton(
        document,
        "삭제",
        () => commitStructure((current) => current.filter((_, item) => item !== index)),
        disabled,
      ),
    );
    row.append(tools);
    if (block.type === "divider") {
      const divider = document.createElement("hr");
      divider.setAttribute("aria-label", "구분선 블록");
      row.append(divider);
    } else if (block.type === "image") {
      const caption = document.createElement("input");
      caption.type = "text";
      caption.value = block.caption ?? "";
      caption.placeholder = "이미지 설명";
      caption.setAttribute("aria-label", `${index + 1}번째 이미지 설명`);
      caption.maxLength = 4_000;
      caption.disabled = disabled;
      caption.addEventListener("input", () =>
        commit((current) => {
          const currentBlock = current[index];
          return currentBlock?.type !== "image"
            ? current
            : replaceAt(current, index, { ...currentBlock, caption: caption.value });
        }),
      );
      const hint = document.createElement("p");
      hint.textContent = `이미지 ${block.image_id}`;
      row.append(hint, caption);
    } else if (block.type === "ordered_list" || block.type === "unordered_list") {
      const list = document.createElement("textarea");
      list.rows = Math.max(2, block.items.length);
      list.value = block.items.join("\n");
      list.placeholder = "항목마다 한 줄씩 입력";
      list.setAttribute("aria-label", `${index + 1}번째 ${blockLabel} 내용`);
      list.maxLength = 4_000;
      list.disabled = disabled;
      list.addEventListener("input", () =>
        commit((current) => {
          const currentBlock = current[index];
          return currentBlock?.type !== "ordered_list" && currentBlock?.type !== "unordered_list"
            ? current
            : replaceAt(current, index, {
                ...currentBlock,
                items: list.value
                  .split("\n")
                  .map((item) => item.trim())
                  .filter(Boolean),
              });
        }),
      );
      row.append(list);
    } else if (block.type === "heading" || block.type === "paragraph" || block.type === "quote") {
      const text = document.createElement("textarea");
      text.rows = block.type === "heading" ? 2 : 4;
      text.value = block.text;
      text.placeholder = block.type === "heading" ? "소제목" : "내용을 입력하세요";
      text.setAttribute("aria-label", `${index + 1}번째 ${blockLabel} 내용`);
      text.maxLength = 4_000;
      text.disabled = disabled;
      text.addEventListener("input", () =>
        commit((current) => {
          const currentBlock = current[index];
          return currentBlock === undefined || !isTextBlock(currentBlock)
            ? current
            : replaceAt(current, index, { ...currentBlock, text: text.value });
        }),
      );
      text.addEventListener("keydown", (event) => {
        if (!(event.altKey && (event.ctrlKey || event.metaKey))) return;
        const kind =
          event.key === "1"
            ? "heading"
            : event.key === "2"
              ? "paragraph"
              : event.key === "3"
                ? "quote"
                : null;
        if (kind === null) return;
        event.preventDefault();
        commitStructure((current) => {
          const currentBlock = current[index];
          return currentBlock === undefined
            ? current
            : replaceAt(current, index, retypeBlock(currentBlock, kind));
        });
      });
      row.append(text);
    }
    canvas.append(row);
    canvas.append(
      renderImageInsertionPoint(document, index + 1, imageInsertAt, handlers, disabled),
    );
  });
  const insert = document.createElement("div");
  insert.className = "block-insert";
  for (const [kind, label] of BLOCK_TYPES.filter(([kind]) => kind !== "image")) {
    insert.append(
      smallButton(
        document,
        `+ ${label}`,
        () => commitStructure((current) => [...current, newBlock(kind)]),
        disabled,
      ),
    );
  }
  canvas.append(insert);
  return canvas;
}

function renderImageInsertionPoint(
  document: Document,
  position: number,
  selected: number,
  handlers: WritingHandlers,
  disabled: boolean,
): HTMLButtonElement {
  const point = button(
    document,
    `image-insert-at-${position}`,
    selected === position ? "이미지 위치" : "여기에 이미지 삽입",
    () => handlers.onImageInsertionPointChange?.(position),
  );
  point.className = "image-insertion-point";
  point.setAttribute("aria-pressed", String(selected === position));
  point.title = point.textContent ?? "이미지 삽입 위치";
  point.disabled = disabled;
  return point;
}

const BLOCK_TYPES: readonly [BodyBlock["type"], string][] = [
  ["paragraph", "문단"],
  ["heading", "소제목"],
  ["quote", "인용"],
  ["ordered_list", "순서 목록"],
  ["unordered_list", "목록"],
  ["divider", "구분선"],
  ["image", "이미지"],
];
const RETYPABLE_TYPES = BLOCK_TYPES.filter(([kind]) => kind !== "image");

/** Return whether every block can be accepted by the draft body API. */
export function hasPersistableBody(blocks: readonly BodyBlock[]): boolean {
  return (
    blocks.length > 0 &&
    blocks.every((block) => {
      if (block.type === "divider") return true;
      if (block.type === "image") return block.image_id.trim().length > 0;
      if (block.type === "ordered_list" || block.type === "unordered_list") {
        return block.items.length > 0 && block.items.every((item) => item.trim().length > 0);
      }
      return isTextBlock(block) && block.text.trim().length > 0;
    })
  );
}

/** Return whether a draft title satisfies the body endpoint's required title contract. */
export function hasValidTitle(title: string | null | undefined): boolean {
  return title !== null && title !== undefined && title.trim().length > 0;
}

function hasLocalCheckpointChanges(
  state: WritingState,
  blocks: readonly BodyBlock[],
  title: string,
): boolean {
  const revision = activeRevision(state);
  if (revision === null) {
    return blocks.length > 0 || title.trim() !== (state.draft?.title ?? "").trim();
  }
  return title.trim() !== revision.title.trim() || !sameBodyBlocks(blocks, revision.blocks);
}

function sameBodyBlocks(left: readonly BodyBlock[], right: readonly BodyBlock[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((block, index) => {
    const other = right[index];
    if (other === undefined || block.type !== other.type) return false;
    if (block.type === "divider") return true;
    if (block.type === "image" && other.type === "image") {
      return block.image_id === other.image_id && (block.caption ?? "") === (other.caption ?? "");
    }
    if (
      (block.type === "ordered_list" || block.type === "unordered_list") &&
      (other.type === "ordered_list" || other.type === "unordered_list")
    ) {
      return (
        block.items.length === other.items.length &&
        block.items.every((item, itemIndex) => item === other.items[itemIndex])
      );
    }
    return isTextBlock(block) && isTextBlock(other) && block.text === other.text;
  });
}

function newBlock(kind: BodyBlock["type"]): BodyBlock {
  if (kind === "divider") return { type: "divider" };
  if (kind === "ordered_list" || kind === "unordered_list") return { type: kind, items: [""] };
  if (kind === "image") return { type: "image", image_id: "", caption: "" };
  return { type: kind, text: "" };
}

function retypeBlock(block: BodyBlock, kind: string): BodyBlock {
  if (!RETYPABLE_TYPES.some(([value]) => value === kind)) return block;
  const text = blockText(block);
  const next = newBlock(kind as BodyBlock["type"]);
  if (next.type === "image") return { ...next, caption: text };
  if (next.type === "ordered_list" || next.type === "unordered_list") {
    return { ...next, items: text ? text.split("\n").filter(Boolean) : [""] };
  }
  if (next.type === "divider") return next;
  return { type: next.type, text };
}

function blockText(block: BodyBlock): string {
  if (block.type === "image") return block.caption ?? "";
  if (block.type === "divider") return "";
  if (block.type === "ordered_list" || block.type === "unordered_list") {
    return block.items.join("\n");
  }
  return "text" in block ? block.text : "";
}

function isTextBlock(
  block: BodyBlock,
): block is Extract<BodyBlock, { type: "heading" | "paragraph" | "quote" }> {
  return block.type === "heading" || block.type === "paragraph" || block.type === "quote";
}

function copyBlocks(blocks: readonly BodyBlock[]): BodyBlock[] {
  return blocks.map(copyBlock);
}

function copyBlock(block: BodyBlock): BodyBlock {
  return block.type === "ordered_list" || block.type === "unordered_list"
    ? { ...block, items: [...block.items] }
    : { ...block };
}

function dispatchBlockUpdate(
  handlers: WritingHandlers,
  update: BodyBlocksUpdater,
  next: BodyBlock[],
  structural: boolean,
): void {
  const functional = structural
    ? (handlers.onBlocksStructureChangeUpdate ?? handlers.onBlocksChangeUpdate)
    : handlers.onBlocksChangeUpdate;
  if (functional !== undefined) {
    functional(update);
    return;
  }
  if (structural) {
    (handlers.onBlocksStructureChange ?? handlers.onBlocksChange)?.(next);
  } else {
    handlers.onBlocksChange?.(next);
  }
}

function replaceAt(blocks: BodyBlock[], index: number, block: BodyBlock): BodyBlock[] {
  return blocks.map((item, position) => (position === index ? block : item));
}

function insertAt(blocks: BodyBlock[], index: number, block: BodyBlock): BodyBlock[] {
  return [...blocks.slice(0, index), block, ...blocks.slice(index)];
}

function moveBlock(blocks: BodyBlock[], index: number, offset: number): BodyBlock[] {
  const target = index + offset;
  if (target < 0 || target >= blocks.length) return blocks;
  const next = [...blocks];
  const current = next[index];
  const other = next[target];
  if (current === undefined || other === undefined) return blocks;
  next[index] = other;
  next[target] = current;
  return next;
}

function moveBlockTo(blocks: BodyBlock[], from: number, to: number): BodyBlock[] {
  if (from < 0 || from >= blocks.length || to < 0 || to >= blocks.length || from === to)
    return blocks;
  const next = [...blocks];
  const [moving] = next.splice(from, 1);
  if (moving === undefined) return blocks;
  next.splice(to, 0, moving);
  return next;
}

function smallButton(
  document: Document,
  label: string,
  action: () => void,
  disabled = false,
): HTMLButtonElement {
  const result = button(document, "", label, action);
  result.className = "block-button";
  result.setAttribute("aria-label", label);
  result.title = label;
  result.disabled = disabled;
  return result;
}

function renderRevisionDiff(document: Document, state: WritingState): Element {
  const section = document.createElement("section");
  section.className = "revision-diff";
  const heading = document.createElement("h4");
  heading.textContent = "이전 버전과 비교";
  section.append(heading);
  const revisions = state.draft?.revisions ?? [];
  const active = activeRevision(state);
  const previous =
    active === null ? null : revisions.find((item) => item.roundNo === active.roundNo - 1);
  if (active === null || previous === undefined || previous === null) {
    const empty = document.createElement("p");
    empty.textContent = "비교할 이전 버전이 없습니다.";
    section.append(empty);
    return section;
  }
  const diff = document.createElement("p");
  for (const item of wordDiff(revisionText(previous), revisionText(active))) {
    const span = document.createElement("span");
    span.className = `diff-${item.kind}`;
    span.textContent = item.text;
    diff.append(span);
  }
  section.append(diff);
  return section;
}

function renderRevisionPanel(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
  showHeading = true,
): Element {
  const section = document.createElement("section");
  section.className = "revision-panel";
  if (showHeading) section.append(heading(document, "변경 기록"));
  const checkpointNeeded =
    needsCheckpoint(state) || state.autoSave === "saving" || state.autoSave === "failed";
  if (checkpointNeeded) {
    const hint = document.createElement("p");
    hint.className = "checkpoint-required-hint";
    hint.setAttribute("role", "status");
    hint.textContent =
      state.autoSave === "saving"
        ? "자동 저장이 끝난 뒤 다른 버전을 선택할 수 있습니다."
        : state.autoSave === "failed"
          ? "자동 저장에 실패했습니다. 현재 편집 내용을 다시 저장한 뒤 다른 버전을 선택하세요."
          : "다른 버전을 선택하기 전에 현재 편집 내용을 먼저 버전으로 남겨 주세요.";
    section.append(hint);
  }
  section.append(renderRevisionHistory(document, state, handlers));
  section.append(renderRevisionDiff(document, state));
  return section;
}

function renderRevisionHistory(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
): Element {
  const list = document.createElement("ul");
  list.className = "revision-list";
  const checkpointNeeded =
    needsCheckpoint(state) || state.autoSave === "saving" || state.autoSave === "failed";
  for (const revision of state.draft?.revisions ?? []) {
    const item = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "revision-item";
    open.dataset.revisionId = revision.id;
    open.dataset.focusKey = `revision:${revision.id}`;
    open.setAttribute("aria-pressed", String(revision.isActive));
    open.disabled = state.busy || checkpointNeeded;
    open.textContent = `${revision.roundNo}번째 · ${REVISION_KIND_LABELS[revision.kind]}`;
    open.addEventListener("click", () => handlers.onOptionChange("revision", revision.id));
    item.append(open);
    list.append(item);
  }
  return list;
}

function renderTags(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
  showHeading = true,
): Element {
  const section = document.createElement("section");
  section.className = "tags-panel";
  if (showHeading) section.append(heading(document, "태그"));

  const checkpointNeeded = needsCheckpoint(state);
  const contentActionBlocked =
    checkpointNeeded || state.autoSave === "saving" || state.autoSave === "failed";
  const generate = button(document, "generate-tags-button", "태그 생성", handlers.onGenerateTags);
  generate.disabled =
    !canGenerate(state) ||
    !hasPersistableBody(state.blocks) ||
    !hasValidTitle(state.draft?.title) ||
    checkpointNeeded;
  section.append(generate);
  if (checkpointNeeded) {
    const hint = document.createElement("p");
    hint.className = "checkpoint-required-hint";
    hint.textContent = "태그를 만들기 전에 현재 편집 내용을 먼저 버전으로 남기세요.";
    section.append(hint);
  } else if (state.autoSave === "saving") {
    const hint = document.createElement("p");
    hint.className = "checkpoint-required-hint";
    hint.setAttribute("role", "status");
    hint.textContent = "자동 저장이 끝난 뒤 태그를 관리할 수 있습니다.";
    section.append(hint);
  } else if (state.autoSave === "failed") {
    const hint = document.createElement("p");
    hint.className = "checkpoint-required-hint";
    hint.setAttribute("role", "status");
    hint.textContent =
      "자동 저장에 실패했습니다. 현재 편집 내용을 다시 저장한 뒤 태그를 관리하세요.";
    section.append(hint);
  }

  const list = document.createElement("ul");
  list.className = "tag-list";
  for (const tag of state.draft?.tags ?? []) {
    const item = document.createElement("li");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tag-choice";
    toggle.dataset.tag = tag.tag;
    toggle.dataset.focusKey = `tag:${tag.tag}`;
    toggle.setAttribute("aria-pressed", String(tag.selected));
    toggle.textContent = `#${tag.tag}`;
    toggle.disabled = state.busy || contentActionBlocked;
    toggle.addEventListener("click", () => handlers.onToggleTag(tag.tag));
    item.append(toggle);
    list.append(item);
  }
  section.append(list);

  const label = document.createElement("label");
  label.htmlFor = "tag-input";
  label.textContent = "태그 직접 추가";
  const input = document.createElement("input");
  input.id = "tag-input";
  input.type = "text";
  input.disabled = state.busy || contentActionBlocked;
  section.append(label, input);
  let syncAddAvailability = (): void => undefined;
  const add = button(document, "add-tags-button", "추가", () => {
    const values = input.value
      .split(/[\s,]+/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (values.length > 0) handlers.onAddTags(values);
  });
  syncAddAvailability = () => {
    add.disabled = state.busy || contentActionBlocked || input.value.trim().length === 0;
  };
  input.addEventListener("input", syncAddAvailability);
  syncAddAvailability();
  section.append(add);
  return section;
}

function renderStaging(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
  showHeading = true,
): Element {
  const section = document.createElement("section");
  section.className = "staging-panel";
  if (showHeading) section.append(heading(document, "임시저장"));

  const hint = document.createElement("p");
  hint.className = "staging-hint";
  hint.textContent = "임시저장까지만 자동으로 진행합니다. 발행은 에디터에서 직접 확인하세요.";
  section.append(hint);

  const summary = document.createElement("p");
  summary.className = "staging-summary";
  summary.textContent = `제목 ${state.draft?.title.length ?? 0}자 · 본문 ${
    Array.from(state.bodyText).length
  }자 · 이미지 ${state.draft?.images.length ?? 0}장 · 선택 태그 ${
    state.draft?.tags.filter((tag) => tag.selected).length ?? 0
  }개`;
  section.append(summary);

  const stage = button(document, "stage-button", "임시저장 실행", handlers.onStage);
  stage.disabled =
    !canStage(state) || !hasPersistableBody(state.blocks) || !hasValidTitle(state.draft?.title);
  section.append(stage);
  if (state.blocks.length > 0 && !hasPersistableBody(state.blocks)) {
    const validation = document.createElement("p");
    validation.className = "staging-validation-hint";
    validation.textContent = "빈 문단·목록 항목을 입력한 뒤 임시저장을 실행하세요.";
    section.append(validation);
  }

  const remove = button(
    document,
    "delete-draft-button",
    state.deleteConfirmation ? "정말 이 초안을 삭제" : "초안 삭제",
    handlers.onDeleteDraft,
  );
  remove.disabled = state.busy;
  section.append(remove);

  if (state.run !== null) {
    section.append(renderSteps(document, state.run.steps));
    section.append(renderVerificationChecklist(document, state));
  }
  return section;
}

function renderSteps(document: Document, steps: PublishStep[]): Element {
  const list = document.createElement("ol");
  list.className = "staging-steps";
  for (const step of steps) {
    const item = document.createElement("li");
    item.dataset.step = step.name;
    item.dataset.state = step.state;
    const label = document.createElement("span");
    label.textContent = STEP_LABELS[step.name] ?? step.name;
    const value = document.createElement("span");
    value.textContent = STEP_STATE_LABELS[step.state] ?? step.state;
    item.append(label, value);
    if (step.resultCode !== null) {
      const code = document.createElement("span");
      code.className = "staging-step-result";
      code.textContent = step.resultCode;
      item.append(code);
    }
    list.append(item);
  }
  return list;
}

/** Keep the final Naver review explicit; the stream deliberately contains no draft text. */
function renderVerificationChecklist(document: Document, state: WritingState): Element {
  const section = document.createElement("section");
  section.className = "staging-verification";
  section.dataset.testid = "staging-verification-checklist";
  const title = document.createElement("h4");
  title.textContent = "네이버에서 직접 확인";
  section.append(title);

  const lead = document.createElement("p");
  lead.textContent = "자동화는 임시저장까지만 수행했습니다. 발행 전에 아래 항목을 확인하세요.";
  section.append(lead);

  const list = document.createElement("ol");
  const verification = state.stagingBodyVerification;
  const bodyStatus =
    verification === null
      ? "본문 단계가 완료되면 요청 범위와 검증된 앞부분을 표시합니다."
      : `요청한 ${verification.requestedRange.start}~${verification.requestedRange.end}번 블록 중 앞 ${verification.observedPrefixCount}개를 순서대로 검증했습니다.`;
  const imageCount = state.blocks.filter((block) => block.type === "image").length;
  const tagCount = state.draft?.tags.filter((tag) => tag.selected).length ?? 0;
  const checks = [
    `제목: 저장된 제목과 맞는지 확인합니다.`,
    `본문 블록 순서와 종류: ${bodyStatus}`,
    `이미지와 캡션: ${imageCount}개 이미지의 위치와 캡션을 확인합니다.`,
    `태그: 선택한 ${tagCount}개 태그가 반영됐는지 확인합니다.`,
    "임시저장 완료 표지: 저장 상태를 확인한 뒤, 발행 여부는 네이버에서 직접 결정합니다.",
  ];
  for (const check of checks) {
    const item = document.createElement("li");
    item.textContent = check;
    list.append(item);
  }
  section.append(list);
  return section;
}

function optionGroup(
  document: Document,
  option: string,
  label: string,
  values: readonly [string, string][],
  current: string,
  handlers: WritingHandlers,
  disabled: boolean,
): Element {
  const group = document.createElement("fieldset");
  group.className = "option-group";
  group.dataset.option = option;
  group.setAttribute("role", "radiogroup");
  const legend = document.createElement("legend");
  legend.id = `option-group-${option}-label`;
  legend.textContent = label;
  group.setAttribute("aria-labelledby", legend.id);
  group.append(legend);
  for (const [value, text] of values) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "option-choice";
    choice.dataset.option = option;
    choice.dataset.value = value;
    choice.dataset.focusKey = `option:${option}:${value}`;
    const checked = current === value;
    choice.setAttribute("role", "radio");
    choice.setAttribute("aria-checked", String(checked));
    // Keep aria-pressed for existing keyboard styling and integrations while migrating to radio semantics.
    choice.setAttribute("aria-pressed", String(checked));
    choice.textContent = text;
    choice.disabled = disabled;
    choice.addEventListener("click", () => handlers.onOptionChange(option, value));
    group.append(choice);
  }
  return group;
}

function labelledInput(
  document: Document,
  id: string,
  label: string,
  value: string,
  onChange: (value: string) => void,
): Element {
  const wrapper = document.createElement("div");
  wrapper.className = "field";
  const element = document.createElement("label");
  element.htmlFor = id;
  element.textContent = label;
  const input = document.createElement("input");
  input.id = id;
  input.type = "text";
  input.value = value;
  input.addEventListener("input", () => onChange(input.value));
  wrapper.append(element, input);
  return wrapper;
}

function heading(document: Document, text: string): Element {
  const element = document.createElement("h3");
  element.textContent = text;
  return element;
}

function button(
  document: Document,
  id: string,
  label: string,
  handler: () => void,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  if (id.length > 0) element.id = id;
  element.textContent = label;
  element.addEventListener("click", handler);
  return element;
}

export function draftLabel(draft: PostDraft): string {
  const active = draft.revisions.find((revision) => revision.isActive) ?? draft.revisions.at(-1);
  const title =
    (draft.workingCopy?.title ?? "").trim() ||
    (active?.title ?? "").trim() ||
    draft.title.trim() ||
    "제목 없음";
  return `${title} · ${DRAFT_STATUS_LABELS[draft.status]}`;
}

interface DiffPart {
  kind: "added" | "removed" | "same";
  text: string;
}

/** A compact word-level diff for revision review; it does not mutate either revision. */
export function wordDiff(previous: string, current: string): DiffPart[] {
  const before = previous.split(/(\s+)/u).filter(Boolean);
  const after = current.split(/(\s+)/u).filter(Boolean);
  const parts: DiffPart[] = [];
  let index = 0;
  for (const token of after) {
    const found = before.indexOf(token, index);
    if (found === index) {
      parts.push({ kind: "same", text: token });
      index += 1;
    } else {
      if (found > index) {
        parts.push({ kind: "removed", text: before.slice(index, found).join("") });
        index = found;
        parts.push({ kind: "same", text: token });
        index += 1;
      } else {
        parts.push({ kind: "added", text: token });
      }
    }
  }
  if (index < before.length) parts.push({ kind: "removed", text: before.slice(index).join("") });
  return parts;
}
