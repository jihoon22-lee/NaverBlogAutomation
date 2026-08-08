/**
 * Writing workspace view.
 *
 * Renders the seed form, the generated body, the tag selection, and the staging progress. Every
 * control is a button, input, or textarea so the whole flow works from the keyboard, and the status
 * line is a live region.
 */

import type { BodyBlock, LlmProviderName, PostDraft, PublishStep } from "../api/types";
import {
  type WritingState,
  activeRevision,
  canGenerate,
  canStage,
  revisionText,
} from "../state/writing";

export interface WritingHandlers {
  onAddTags(tags: string[]): void;
  onBlocksChange?(blocks: BodyBlock[]): void;
  /** Commit a structural block change and redraw the canvas without disrupting text input. */
  onBlocksStructureChange?(blocks: BodyBlock[]): void;
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
  onRefine(): void;
  onSaveBlocks?(blocks: BodyBlock[]): void;
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
  if (state.blocks.length > 0 || activeRevision(state) !== null) {
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
    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "image-insert";
    insert.textContent = "본문에 넣기";
    insert.addEventListener("click", () => handlers.onInsertImage?.(image.id, state.imageInsertAt));
    item.append(name, insert, remove);
    list.append(item);
  }
  section.append(list);
  const insertion = document.createElement("p");
  insertion.className = "image-insertion-note";
  insertion.textContent = `새 이미지는 ${state.imageInsertAt + 1}번째 block 위치에 넣습니다.`;
  section.append(insertion);
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

  section.append(renderEditorTools(document, state));
  section.append(renderBlockCanvas(document, state.blocks, state.imageInsertAt, handlers));

  const actions = document.createElement("div");
  actions.className = "body-actions";
  const save = button(document, "save-body-button", "지금 저장", () =>
    handlers.onSaveBlocks?.(state.blocks),
  );
  save.disabled = state.busy;
  const checkpoint = button(document, "checkpoint-body-button", "revision으로 남기기", () =>
    handlers.onCheckpoint?.(),
  );
  checkpoint.disabled = state.busy;
  const refine = button(document, "refine-button", "다듬기 요청", handlers.onRefine);
  refine.disabled = !canGenerate(state);
  actions.append(save, checkpoint, refine);
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

function renderEditorTools(document: Document, state: WritingState): Element {
  const panel = document.createElement("div");
  panel.className = "editor-assist-panel";
  const outline = document.createElement("nav");
  outline.className = "editor-outline";
  outline.setAttribute("aria-label", "글 outline");
  const outlineTitle = document.createElement("strong");
  outlineTitle.textContent = "Outline";
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
    empty.textContent = "소제목을 추가하면 outline이 생깁니다.";
    outline.append(empty);
  }
  const preview = document.createElement("details");
  preview.className = "editor-preview";
  const summary = document.createElement("summary");
  summary.textContent = "네이버 반영 전 미리보기";
  const content = document.createElement("div");
  content.append(renderBlockPreview(document, state.blocks));
  preview.append(summary, content);
  panel.append(outline, preview);
  const help = document.createElement("p");
  help.className = "editor-shortcut-hint";
  help.textContent =
    "Ctrl/⌘ + Alt + 1, 2, 3으로 현재 block을 소제목·문단·인용으로 바꿀 수 있습니다.";
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
): Element {
  const canvas = document.createElement("div");
  canvas.className = "block-canvas";
  canvas.setAttribute("aria-label", "본문 블록 편집기");
  const commit = (next: BodyBlock[]) => handlers.onBlocksChange?.(next);
  const commitStructure = (next: BodyBlock[]) =>
    (handlers.onBlocksStructureChange ?? handlers.onBlocksChange)?.(next);
  canvas.append(renderImageInsertionPoint(document, 0, imageInsertAt, handlers));
  blocks.forEach((block, index) => {
    const row = document.createElement("article");
    row.className = `editor-block editor-block-${block.type}`;
    row.dataset.blockIndex = String(index);
    row.draggable = true;
    row.addEventListener("dragstart", (event) =>
      event.dataTransfer?.setData("text/plain", String(index)),
    );
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = Number.parseInt(event.dataTransfer?.getData("text/plain") ?? "", 10);
      if (!Number.isNaN(from)) commitStructure(moveBlockTo(blocks, from, index));
    });
    const tools = document.createElement("div");
    tools.className = "block-tools";
    const type = document.createElement("select");
    type.setAttribute("aria-label", `${index + 1}번째 블록 형식`);
    for (const [value, label] of BLOCK_TYPES) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = block.type === value;
      type.append(option);
    }
    type.addEventListener("change", () =>
      commitStructure(replaceAt(blocks, index, retypeBlock(block, type.value))),
    );
    tools.append(type);
    tools.append(
      smallButton(
        document,
        "위로",
        () => commitStructure(moveBlock(blocks, index, -1)),
        index === 0,
      ),
      smallButton(
        document,
        "아래로",
        () => commitStructure(moveBlock(blocks, index, 1)),
        index === blocks.length - 1,
      ),
      smallButton(document, "복제", () =>
        commitStructure(insertAt(blocks, index + 1, copyBlock(block))),
      ),
      smallButton(document, "삭제", () =>
        commitStructure(blocks.filter((_, item) => item !== index)),
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
      caption.addEventListener("input", () =>
        commit(replaceAt(blocks, index, { ...block, caption: caption.value })),
      );
      const hint = document.createElement("p");
      hint.textContent = `이미지 ${block.image_id}`;
      row.append(hint, caption);
    } else if (block.type === "ordered_list" || block.type === "unordered_list") {
      const list = document.createElement("textarea");
      list.rows = Math.max(2, block.items.length);
      list.value = block.items.join("\n");
      list.placeholder = "항목마다 한 줄씩 입력";
      list.addEventListener("input", () =>
        commit(
          replaceAt(blocks, index, {
            ...block,
            items: list.value
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean),
          }),
        ),
      );
      row.append(list);
    } else if (block.type === "heading" || block.type === "paragraph" || block.type === "quote") {
      const text = document.createElement("textarea");
      text.rows = block.type === "heading" ? 2 : 4;
      text.value = block.text;
      text.placeholder = block.type === "heading" ? "소제목" : "내용을 입력하세요";
      text.addEventListener("input", () =>
        commit(replaceAt(blocks, index, { ...block, text: text.value })),
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
        commitStructure(replaceAt(blocks, index, retypeBlock(block, kind)));
      });
      row.append(text);
    }
    canvas.append(row);
    canvas.append(renderImageInsertionPoint(document, index + 1, imageInsertAt, handlers));
  });
  const insert = document.createElement("div");
  insert.className = "block-insert";
  for (const [kind, label] of BLOCK_TYPES.filter(([kind]) => kind !== "image")) {
    insert.append(
      smallButton(document, `+ ${label}`, () => commitStructure([...blocks, newBlock(kind)])),
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
): HTMLButtonElement {
  const point = button(
    document,
    `image-insert-at-${position}`,
    selected === position ? "이미지 위치" : "여기에 이미지 삽입",
    () => handlers.onImageInsertionPointChange?.(position),
  );
  point.className = "image-insertion-point";
  point.setAttribute("aria-pressed", String(selected === position));
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

function newBlock(kind: BodyBlock["type"]): BodyBlock {
  if (kind === "divider") return { type: "divider" };
  if (kind === "ordered_list" || kind === "unordered_list") return { type: kind, items: [""] };
  if (kind === "image") return { type: "image", image_id: "", caption: "" };
  return { type: kind, text: "" };
}

function retypeBlock(block: BodyBlock, kind: string): BodyBlock {
  if (!BLOCK_TYPES.some(([value]) => value === kind)) return block;
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

function copyBlock(block: BodyBlock): BodyBlock {
  return block.type === "ordered_list" || block.type === "unordered_list"
    ? { ...block, items: [...block.items] }
    : { ...block };
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
  result.disabled = disabled;
  return result;
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
  section.append(heading(document, "네이버에서 직접 확인"));

  const lead = document.createElement("p");
  lead.textContent = "자동화는 임시저장까지만 수행했습니다. 발행 전에 아래 항목을 확인하세요.";
  section.append(lead);

  const list = document.createElement("ol");
  const verification = state.stagingBodyVerification;
  const bodyStatus =
    verification === null
      ? "본문 단계가 완료되면 요청 범위와 검증된 prefix를 표시합니다."
      : `요청한 ${verification.requestedRange.start}~${verification.requestedRange.end}번 block 중 앞 ${verification.observedPrefixCount}개를 순서대로 검증했습니다.`;
  const imageCount = state.blocks.filter((block) => block.type === "image").length;
  const tagCount = state.draft?.tags.filter((tag) => tag.selected).length ?? 0;
  const checks = [
    `제목: 저장된 제목과 맞는지 확인합니다.`,
    `본문 block 순서와 종류: ${bodyStatus}`,
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
