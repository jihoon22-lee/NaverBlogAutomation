/**
 * Execution panel for one approved post.
 *
 * The panel shows one explicit run button, live step results, and a manual-completion form for the
 * steps a user finished by hand. An unknown result never offers a retry button.
 */

import type { EngagementStepName } from "../api/types";
import { type RunState, isBusy, needsManualResolution } from "../state/run";

export interface RunHandlers {
  onManualComplete(): void;
  onStart(): void;
  onToggleManualStep(name: EngagementStepName): void;
}

const STEP_LABELS: Record<EngagementStepName, string> = {
  like: "공감",
  comment: "댓글 등록",
  mutual_neighbor: "서로이웃 신청",
};

const STEP_STATE_LABELS: Record<string, string> = {
  pending: "대기",
  running: "진행 중",
  succeeded: "성공",
  skipped: "건너뜀",
  failed: "실패",
  unconfirmed: "확인 불가",
};

const RESULT_LABELS: Record<string, string> = {
  already_liked: "이미 공감한 글입니다.",
  ambiguous: "대상이 여러 개여서 실행하지 않았습니다.",
  author_mismatch: "글 작성자가 대기열 후보와 다릅니다.",
  browser_operation_failed: "브라우저 조작이 실패했습니다.",
  captcha_required: "보안 문자 확인이 필요합니다.",
  comment_blocked: "댓글 작성이 제한된 글입니다.",
  comment_field_occupied: "입력란에 다른 내용이 있어 건드리지 않았습니다.",
  comment_published: "댓글을 등록했습니다.",
  comment_unconfirmed: "등록 결과를 확인할 수 없습니다. 자동으로 다시 등록하지 않습니다.",
  interrupted_before_confirmation: "이전 실행이 확인 전에 중단됐습니다.",
  liked: "공감했습니다.",
  like_unconfirmed: "공감 결과를 확인할 수 없습니다.",
  login_required: "다시 로그인해야 합니다.",
  neighbor_message_missing: "서로이웃 기본 메시지를 설정하세요.",
  neighbor_requested: "서로이웃을 신청했습니다.",
  neighbor_unconfirmed: "신청 결과를 확인할 수 없습니다. 자동으로 다시 신청하지 않습니다.",
  not_found: "대상을 찾지 못했습니다.",
  request_pending: "이미 신청 대기 중입니다.",
  request_unavailable: "신청할 수 없는 상대입니다.",
  state_unknown: "상태를 판별하지 못했습니다.",
};

/** Render the execution panel for `state`. */
export function renderRun(document: Document, state: RunState, handlers: RunHandlers): Element {
  const section = document.createElement("section");
  section.className = "run-panel";

  const heading = document.createElement("h2");
  heading.textContent = "공감·댓글 실행";
  section.append(heading);

  const status = document.createElement("p");
  status.id = "run-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = statusMessage(state);
  section.append(status);

  if (state.phase === "refused") {
    const start = document.createElement("button");
    start.type = "button";
    start.id = "run-button";
    start.textContent = "실행만 다시 시도";
    start.disabled = isBusy(state);
    start.addEventListener("click", handlers.onStart);
    section.append(start);
  }

  if (state.steps.length > 0) section.append(renderSteps(document, state));
  if (needsManualResolution(state)) section.append(renderManual(document, state, handlers));
  return section;
}

function statusMessage(state: RunState): string {
  switch (state.phase) {
    case "idle":
      return "승인한 댓글로 이 글 하나만 실행합니다.";
    case "starting":
      return "실행을 시작하는 중입니다.";
    case "running":
      return state.reconnects > 0
        ? "연결이 끊겨 다시 연결했습니다. 진행 상황을 계속 표시합니다."
        : "단계별로 실행하는 중입니다.";
    case "refused":
      return state.error ?? "실행할 수 없습니다.";
    default:
      return summary(state);
  }
}

function summary(state: RunState): string {
  const failed = state.steps.filter(
    (step) => step.state === "failed" || step.state === "unconfirmed",
  );
  if (failed.length === 0) return "모든 단계를 마쳤습니다.";
  return "일부 단계가 끝나지 않았습니다. 직접 처리한 단계만 아래에서 기록하세요.";
}

function renderSteps(document: Document, state: RunState): Element {
  const list = document.createElement("ol");
  list.className = "run-steps";
  for (const step of state.steps) {
    const item = document.createElement("li");
    item.dataset.step = step.name;
    item.dataset.state = step.state;
    const label = document.createElement("span");
    label.className = "run-step-name";
    label.textContent = STEP_LABELS[step.name];
    const value = document.createElement("span");
    value.className = "run-step-state";
    value.textContent = STEP_STATE_LABELS[step.state] ?? step.state;
    item.append(label, value);
    if (step.resultCode !== null) {
      const detail = document.createElement("span");
      detail.className = "run-step-result";
      detail.textContent = RESULT_LABELS[step.resultCode] ?? step.resultCode;
      item.append(detail);
    }
    list.append(item);
  }
  return list;
}

function renderManual(document: Document, state: RunState, handlers: RunHandlers): Element {
  const group = document.createElement("fieldset");
  group.className = "manual-panel";
  const legend = document.createElement("legend");
  legend.textContent = "직접 처리한 단계 기록";
  group.append(legend);

  const hint = document.createElement("p");
  hint.className = "manual-hint";
  hint.textContent = "실제로 완료한 단계만 선택하세요. 선택한 단계는 다시 실행하지 않습니다.";
  group.append(hint);

  for (const step of state.steps) {
    if (step.state !== "failed" && step.state !== "unconfirmed") continue;
    const label = document.createElement("label");
    label.className = "manual-choice";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `manual-${step.name}`;
    checkbox.dataset.step = step.name;
    checkbox.checked = state.manualSteps.includes(step.name);
    checkbox.addEventListener("change", () => handlers.onToggleManualStep(step.name));
    label.append(checkbox, document.createTextNode(STEP_LABELS[step.name]));
    group.append(label);
  }

  const submit = document.createElement("button");
  submit.type = "button";
  submit.id = "manual-complete-button";
  submit.textContent = "선택한 단계 완료 기록";
  submit.disabled = state.manualSteps.length === 0;
  submit.addEventListener("click", handlers.onManualComplete);
  group.append(submit);
  return group;
}
