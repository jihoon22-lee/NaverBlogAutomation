/**
 * Writing workspace view.
 *
 * Renders the seed form, the generated body, the tag selection, and the staging progress. Every
 * control is a button, input, or textarea so the whole flow works from the keyboard, and the status
 * line is a live region.
 */

import type { LlmProviderName, PostDraft, PublishStep } from "../api/types";
import {
  type WritingState,
  activeRevision,
  canGenerate,
  canStage,
  revisionText,
} from "../state/writing";

export interface WritingHandlers {
  onAddTags(tags: string[]): void;
  onBodyChange(text: string): void;
  onCompose(): void;
  onCompleteWithAi(): void;
  onCreateDraft(): void;
  onDeleteDraft(): void;
  onDeleteImage(imageId: string): void;
  onGenerateTags(): void;
  onOptionChange(option: string, value: string): void;
  onOpenDraft(draftId: string): void;
  onRefine(): void;
  onSaveBody(text: string): void;
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
  root.textContent = "";

  const status = document.createElement("p");
  status.id = "writing-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = statusMessage(state);
  root.append(status);

  root.append(renderSeed(document, state, handlers));
  if (state.drafts.length > 0) root.append(renderDraftList(document, state, handlers));
  if (state.draft === null) return;
  root.append(renderImages(document, state, handlers));
  root.append(renderOptions(document, state, handlers));
  if (activeRevision(state) !== null) {
    root.append(renderBody(document, state, handlers));
    root.append(renderTags(document, state, handlers));
    root.append(renderStaging(document, state, handlers));
  }
}

function statusMessage(state: WritingState): string {
  if (state.error !== null) return state.error;
  if (state.notice !== null) return state.notice;
  switch (state.phase) {
    case "empty":
      return "초안과 이미지를 준비해 새 글을 시작하세요.";
    case "seed":
      return "초안 text를 입력하고 본문을 생성하세요.";
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
  section.append(heading(document, "새 글 초안"));

  section.append(
    labelledInput(document, "seed-title", "제목", state.seedTitle, (value) =>
      handlers.onSeedChange("title", value),
    ),
  );

  const label = document.createElement("label");
  label.htmlFor = "seed-text";
  label.textContent = "초안 내용";
  const editor = document.createElement("textarea");
  editor.id = "seed-text";
  editor.rows = 6;
  editor.value = state.seedText;
  editor.addEventListener("input", () => handlers.onSeedChange("text", editor.value));
  section.append(label, editor);

  section.append(renderCategories(document, state, handlers));

  const create = button(document, "create-draft-button", "초안만 저장", handlers.onCreateDraft);
  create.disabled = state.busy || state.seedTitle.trim().length === 0;
  const complete = button(
    document,
    "complete-draft-button",
    "AI로 초안 완성",
    handlers.onCompleteWithAi,
  );
  complete.disabled = create.disabled || !state.providers.some((provider) => provider.configured);
  section.append(create, complete);
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
  group.append(
    button(document, "sync-categories-button", "카테고리 새로 읽기", handlers.onSyncCategories),
  );
  return group;
}

function renderDraftList(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "draft-list-panel";
  section.append(heading(document, "최근 초안"));
  const list = document.createElement("ul");
  list.className = "draft-list";
  for (const draft of state.drafts) {
    const item = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "draft-item";
    open.dataset.draftId = draft.id;
    open.setAttribute("aria-pressed", String(state.draft?.id === draft.id));
    open.textContent = `${draft.title} · ${draft.status}`;
    open.addEventListener("click", () => handlers.onOpenDraft(draft.id));
    item.append(open);
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderImages(document: Document, state: WritingState, handlers: WritingHandlers): Element {
  const section = document.createElement("section");
  section.className = "images-panel";
  section.append(heading(document, "이미지"));

  const label = document.createElement("label");
  label.htmlFor = "image-input";
  label.textContent = "이미지 추가";
  const input = document.createElement("input");
  input.id = "image-input";
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/webp,image/gif";
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
    remove.addEventListener("click", () => handlers.onDeleteImage(image.id));
    item.append(name, remove);
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderOptions(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "writing-options-panel";
  section.append(heading(document, "생성 옵션"));
  section.append(renderProviders(document, state, handlers));
  section.append(
    optionGroup(document, "length", "길이", LENGTHS, state.options.length, handlers),
    optionGroup(document, "tone", "분위기", TONES, state.options.tone, handlers),
    optionGroup(document, "structure", "구성", STRUCTURES, state.options.structure, handlers),
  );

  const compose = button(document, "compose-button", "본문 생성", handlers.onCompose);
  compose.disabled = !canGenerate(state);
  section.append(compose);
  return section;
}

function renderProviders(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
): Element {
  const group = document.createElement("fieldset");
  group.className = "provider-group";
  const legend = document.createElement("legend");
  legend.textContent = "생성 provider";
  group.append(legend);
  for (const provider of state.providers) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "provider-choice";
    choice.dataset.provider = provider.provider;
    choice.disabled = !provider.configured;
    choice.setAttribute("aria-pressed", String(state.options.provider === provider.provider));
    choice.textContent = provider.configured
      ? `${PROVIDER_LABELS[provider.provider]} · ${provider.model}`
      : `${PROVIDER_LABELS[provider.provider]} (설정 필요)`;
    choice.addEventListener("click", () => handlers.onOptionChange("provider", provider.provider));
    group.append(choice);
  }
  return group;
}

function renderBody(document: Document, state: WritingState, handlers: WritingHandlers): Element {
  const section = document.createElement("section");
  section.className = "body-panel";
  section.append(heading(document, "본문"));

  const revision = activeRevision(state);
  const meta = document.createElement("p");
  meta.className = "revision-meta";
  meta.textContent =
    revision === null
      ? ""
      : `${revision.roundNo}회차 · ${revision.kind}${
          revision.provider === null ? "" : ` · ${revision.provider}`
        }`;
  section.append(meta);

  const label = document.createElement("label");
  const titleLabel = document.createElement("label");
  titleLabel.htmlFor = "draft-title";
  titleLabel.textContent = "제목";
  const title = document.createElement("input");
  title.id = "draft-title";
  title.type = "text";
  title.maxLength = 200;
  title.value = state.draft?.title ?? "";
  title.addEventListener("input", () => handlers.onTitleChange(title.value));
  section.append(titleLabel, title);

  label.htmlFor = "body-text";
  label.textContent = "본문 내용";
  const editor = document.createElement("textarea");
  editor.id = "body-text";
  editor.rows = 12;
  editor.value = state.bodyText;
  editor.addEventListener("input", () => handlers.onBodyChange(editor.value));
  section.append(label, editor);

  const actions = document.createElement("div");
  actions.className = "body-actions";
  const save = button(document, "save-body-button", "편집 저장", () =>
    handlers.onSaveBody(editor.value),
  );
  save.disabled = state.busy;
  const refine = button(document, "refine-button", "다듬기 요청", handlers.onRefine);
  refine.disabled = !canGenerate(state);
  actions.append(save, refine);
  section.append(actions);

  const autosave = document.createElement("p");
  autosave.className = "autosave-status";
  autosave.setAttribute("role", "status");
  autosave.textContent = {
    idle: "편집하면 자동 저장합니다.",
    saving: "자동 저장 중입니다.",
    saved: "자동 저장되었습니다.",
    failed: "자동 저장에 실패했습니다. 편집 저장을 다시 시도하세요.",
  }[state.autoSave];
  section.append(autosave);

  const label2 = document.createElement("label");
  label2.htmlFor = "refine-request";
  label2.textContent = "다듬기 요청 사항";
  const request = document.createElement("input");
  request.id = "refine-request";
  request.type = "text";
  request.value = state.options.request;
  request.addEventListener("input", () => handlers.onOptionChange("request", request.value));
  section.append(label2, request);

  section.append(renderRevisionHistory(document, state, handlers));
  section.append(renderRevisionDiff(document, state));
  return section;
}

function renderRevisionDiff(document: Document, state: WritingState): Element {
  const section = document.createElement("section");
  section.className = "revision-diff";
  const heading = document.createElement("h3");
  heading.textContent = "이전 revision과 비교";
  section.append(heading);
  const revisions = state.draft?.revisions ?? [];
  const active = activeRevision(state);
  const previous =
    active === null ? null : revisions.find((item) => item.roundNo === active.roundNo - 1);
  if (active === null || previous === undefined || previous === null) {
    const empty = document.createElement("p");
    empty.textContent = "비교할 이전 revision이 없습니다.";
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

function renderRevisionHistory(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
): Element {
  const list = document.createElement("ul");
  list.className = "revision-list";
  for (const revision of state.draft?.revisions ?? []) {
    const item = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "revision-item";
    open.dataset.revisionId = revision.id;
    open.setAttribute("aria-pressed", String(revision.isActive));
    open.textContent = `${revision.roundNo}회차 · ${revision.kind}`;
    open.addEventListener("click", () => handlers.onOptionChange("revision", revision.id));
    item.append(open);
    list.append(item);
  }
  return list;
}

function renderTags(document: Document, state: WritingState, handlers: WritingHandlers): Element {
  const section = document.createElement("section");
  section.className = "tags-panel";
  section.append(heading(document, "태그"));

  const generate = button(document, "generate-tags-button", "태그 생성", handlers.onGenerateTags);
  generate.disabled = !canGenerate(state);
  section.append(generate);

  const list = document.createElement("ul");
  list.className = "tag-list";
  for (const tag of state.draft?.tags ?? []) {
    const item = document.createElement("li");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tag-choice";
    toggle.dataset.tag = tag.tag;
    toggle.setAttribute("aria-pressed", String(tag.selected));
    toggle.textContent = `#${tag.tag}`;
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
  section.append(label, input);
  const add = button(document, "add-tags-button", "추가", () => {
    const values = input.value
      .split(/[\s,]+/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (values.length > 0) handlers.onAddTags(values);
  });
  add.disabled = state.busy;
  section.append(add);
  return section;
}

function renderStaging(
  document: Document,
  state: WritingState,
  handlers: WritingHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "staging-panel";
  section.append(heading(document, "임시저장"));

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
  stage.disabled = !canStage(state);
  section.append(stage);

  const remove = button(
    document,
    "delete-draft-button",
    state.deleteConfirmation ? "정말 이 초안을 삭제" : "초안 삭제",
    handlers.onDeleteDraft,
  );
  remove.disabled = state.busy;
  section.append(remove);

  if (state.run !== null) section.append(renderSteps(document, state.run.steps));
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

function optionGroup(
  document: Document,
  option: string,
  label: string,
  values: readonly [string, string][],
  current: string,
  handlers: WritingHandlers,
): Element {
  const group = document.createElement("fieldset");
  group.className = "option-group";
  group.dataset.option = option;
  const legend = document.createElement("legend");
  legend.textContent = label;
  group.append(legend);
  for (const [value, text] of values) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "option-choice";
    choice.dataset.option = option;
    choice.dataset.value = value;
    choice.setAttribute("aria-pressed", String(current === value));
    choice.textContent = text;
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
  const element = document.createElement("h2");
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
  element.id = id;
  element.textContent = label;
  element.addEventListener("click", handler);
  return element;
}

export function draftLabel(draft: PostDraft): string {
  return `${draft.title} · ${draft.status}`;
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
