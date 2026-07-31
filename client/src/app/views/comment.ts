/**
 * Comment workspace view.
 *
 * Renders the preview, the generation options, the three candidates, and the local draft editor.
 * A failed generation whose provider result is unknown renders an explicit replacement control
 * instead of retrying on its own.
 */

import type { CommentLength, CommentMood, RelationshipLevel, SpeechStyle } from "../api/types";
import {
  type CommentState,
  MAX_COMMENT_CODE_POINTS,
  canApprove,
  selectedCandidate,
} from "../state/comment";
import type { RunState } from "../state/run";
import { type RunHandlers, renderRun } from "./run";

export interface CommentHandlers {
  onApprove(): void;
  onBack(): void;
  onCopy(): void;
  onDraftChange(draft: string): void;
  onGenerate(): void;
  onOptionChange(option: string, value: string): void;
  onReplace(): void;
  onSelectCandidate(candidateId: string): void;
  run?: RunHandlers;
}

const RELATIONSHIPS: readonly [RelationshipLevel, string][] = [
  ["new", "신규"],
  ["polite", "정중"],
  ["friendly", "친근"],
  ["close", "친밀"],
];

const SPEECH_STYLES: readonly [SpeechStyle, string][] = [
  ["honorific", "존댓말"],
  ["banmal", "반말"],
];

const LENGTHS: readonly [CommentLength, string][] = [
  ["short", "짧게"],
  ["medium", "보통"],
  ["long", "길게"],
];

const MOODS: readonly [CommentMood, string][] = [
  ["calm", "담담하게"],
  ["warm", "따뜻하게"],
  ["lively", "활기차게"],
];

const TONE_LABELS: Record<string, string> = {
  warm: "따뜻한",
  curious: "궁금한",
  supportive: "응원하는",
};

const WARNING_LABELS: Record<string, string> = {
  length_target_missed: "길이 목표를 벗어난 후보가 있습니다.",
  candidate_roles_blurred: "후보의 역할 구분이 약합니다.",
  candidates_too_similar: "후보가 서로 비슷합니다.",
};

/** Render the comment workspace into `root`. */
export function renderComment(
  root: Element,
  state: CommentState,
  handlers: CommentHandlers,
  run: RunState | null = null,
): void {
  const document = root.ownerDocument;
  root.textContent = "";

  const status = document.createElement("p");
  status.id = "comment-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = statusMessage(state);
  root.append(status);

  root.append(button(document, "comment-back-button", "오늘의 작업으로", handlers.onBack));

  if (state.extraction === null) return;
  root.append(renderPreview(document, state));
  root.append(renderOptions(document, state, handlers));
  if (state.phase === "needs_replacement") {
    root.append(renderReplacement(document, handlers));
  }
  if (state.recommendation !== null) {
    root.append(renderCandidates(document, state, handlers));
    root.append(renderEditor(document, state, handlers));
  }
  if (
    run !== null &&
    handlers.run !== undefined &&
    state.recommendation !== null &&
    state.recommendation.reviewStatus !== "drafted"
  ) {
    root.append(renderRun(document, run, handlers.run));
  }
}

function statusMessage(state: CommentState): string {
  switch (state.phase) {
    case "empty":
      return "오늘의 작업에서 처리할 글을 선택하세요.";
    case "preview":
      return "본문을 확인하고 댓글 후보를 생성하세요.";
    case "generating":
      return "댓글 후보를 생성하는 중입니다.";
    case "review":
      return state.replayed
        ? "이미 생성한 결과를 그대로 불러왔습니다."
        : "후보를 고르고 필요한 만큼 다듬으세요.";
    case "needs_replacement":
      return state.error ?? "이전 결과를 확인할 수 없습니다.";
    default:
      return state.error ?? "댓글 후보를 생성하지 못했습니다.";
  }
}

function renderPreview(document: Document, state: CommentState): Element {
  const extraction = state.extraction;
  const section = document.createElement("section");
  section.className = "preview-panel";
  const heading = document.createElement("h2");
  heading.id = "preview-title";
  heading.textContent = extraction === null ? "" : extraction.title;
  section.append(heading);

  if (extraction !== null) {
    const list = document.createElement("dl");
    appendTerm(document, list, "본문 글자수", String(extraction.transmittedLength));
    appendTerm(document, list, "잘림", extraction.truncated ? "예" : "아니오");
    appendTerm(document, list, "추출 방식", extraction.selectorKind);
    section.append(list);

    const preview = document.createElement("p");
    preview.className = "preview-body";
    preview.textContent = extraction.preview;
    section.append(preview);
  }
  return section;
}

function renderOptions(
  document: Document,
  state: CommentState,
  handlers: CommentHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "options-panel";
  const heading = document.createElement("h2");
  heading.textContent = "생성 옵션";
  section.append(heading);

  section.append(
    optionGroup(
      document,
      "relationship_level",
      "관계",
      RELATIONSHIPS,
      state.options.relationshipLevel,
      handlers,
    ),
    optionGroup(
      document,
      "speech_style",
      "말투",
      SPEECH_STYLES,
      state.options.speechStyle,
      handlers,
    ),
    optionGroup(document, "comment_length", "길이", LENGTHS, state.options.commentLength, handlers),
    optionGroup(document, "comment_mood", "분위기", MOODS, state.options.commentMood, handlers),
  );

  const generate = button(
    document,
    "generate-button",
    state.recommendation === null ? "댓글 후보 생성" : "다시 생성",
    handlers.onGenerate,
  );
  generate.disabled = state.phase === "generating";
  section.append(generate);

  const hint = document.createElement("p");
  hint.className = "options-hint";
  hint.textContent = "선택하지 않은 항목은 저장한 기본 설정을 사용합니다.";
  section.append(hint);
  return section;
}

function renderReplacement(document: Document, handlers: CommentHandlers): Element {
  const section = document.createElement("section");
  section.className = "replacement-panel";
  const warning = document.createElement("p");
  warning.textContent =
    "이전 요청의 결과를 확인할 수 없습니다. 교체 생성은 중복 생성이 될 수 있습니다.";
  section.append(warning);
  section.append(button(document, "replace-button", "교체 생성 승인", handlers.onReplace));
  return section;
}

function renderCandidates(
  document: Document,
  state: CommentState,
  handlers: CommentHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "candidates-panel";
  const heading = document.createElement("h2");
  heading.textContent = "댓글 후보";
  section.append(heading);

  const recommendation = state.recommendation;
  if (recommendation === null) return section;

  if (recommendation.qualityWarnings.length > 0) {
    const warnings = document.createElement("ul");
    warnings.className = "quality-warnings";
    for (const warning of recommendation.qualityWarnings) {
      const item = document.createElement("li");
      item.textContent = WARNING_LABELS[warning] ?? warning;
      warnings.append(item);
    }
    section.append(warnings);
  }

  const list = document.createElement("ul");
  list.className = "candidate-list";
  for (const candidate of recommendation.candidates) {
    const item = document.createElement("li");
    const select = document.createElement("button");
    select.type = "button";
    select.className = "candidate-item";
    select.dataset.candidateId = candidate.id;
    select.setAttribute("aria-pressed", String(candidate.id === state.selectedCandidateId));
    select.textContent = `${TONE_LABELS[candidate.tone] ?? candidate.tone} · ${candidate.comment}`;
    select.addEventListener("click", () => handlers.onSelectCandidate(candidate.id));
    item.append(select);
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderEditor(document: Document, state: CommentState, handlers: CommentHandlers): Element {
  const section = document.createElement("section");
  section.className = "editor-panel";
  const heading = document.createElement("h2");
  heading.textContent = "댓글 다듬기";
  section.append(heading);

  const label = document.createElement("label");
  label.htmlFor = "comment-draft";
  label.textContent = "등록할 댓글";
  section.append(label);

  const editor = document.createElement("textarea");
  editor.id = "comment-draft";
  editor.rows = 4;
  editor.maxLength = MAX_COMMENT_CODE_POINTS;
  editor.value = state.draft;
  editor.addEventListener("input", () => handlers.onDraftChange(editor.value));
  section.append(editor);

  const count = document.createElement("p");
  count.className = "draft-count";
  count.textContent = `${Array.from(state.draft).length} / ${MAX_COMMENT_CODE_POINTS}자`;
  section.append(count);

  if (state.closingPhrase.length > 0) {
    const phrase = document.createElement("p");
    phrase.className = "closing-phrase";
    phrase.textContent = `마무리 문구 "${state.closingPhrase}"가 후보 선택 시 붙습니다.`;
    section.append(phrase);
  }

  const actions = document.createElement("div");
  actions.className = "editor-actions";
  const copy = button(document, "copy-button", "댓글 복사", handlers.onCopy);
  copy.disabled = state.draft.length === 0;
  actions.append(copy);
  const approve = button(document, "approve-button", "이 댓글로 승인", handlers.onApprove);
  approve.disabled = !canApprove(state);
  actions.append(approve);
  section.append(actions);

  const detail = selectedCandidate(state);
  if (detail !== null) {
    const reference = document.createElement("p");
    reference.className = "candidate-reference";
    reference.textContent = `근거: ${detail.referencedDetail}`;
    section.append(reference);
  }
  return section;
}

function optionGroup(
  document: Document,
  option: string,
  label: string,
  values: readonly [string, string][],
  current: string | undefined,
  handlers: CommentHandlers,
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

function appendTerm(document: Document, list: Element, term: string, value: string): void {
  const name = document.createElement("dt");
  name.textContent = term;
  const description = document.createElement("dd");
  description.textContent = value;
  list.append(name, description);
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
