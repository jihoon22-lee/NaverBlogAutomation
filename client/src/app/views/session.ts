/**
 * Session batch screen.
 *
 * One approval covers several queued posts, so this screen makes the scope explicit before the batch
 * starts: which steps run, how many posts at most, and what stopped a previous batch. Cancelling is
 * always visible while a batch is in flight.
 */

import { SCHEDULE_REASONS, type SessionState, isSessionBusy } from "../controllers/session";
import type { AutomationSession, EngagementStepName } from "../api/types";

export interface SessionHandlers {
  onStart(): void;
  onCancel(): void;
  onRefresh(): void;
  onToggleStep(name: EngagementStepName): void;
  onMaxPostsChange(value: number): void;
}

const STEP_LABELS: Record<EngagementStepName, string> = {
  like: "공감",
  comment: "댓글 등록",
  mutual_neighbor: "서로이웃 신청",
};

const STATE_LABELS: Record<string, string> = {
  pending: "시작 대기",
  running: "진행 중",
  completed: "완료",
  aborted: "중단",
  cancelled: "취소",
};

const ABORT_LABELS: Record<string, string> = {
  daily_cap_reached: "오늘 상한에 도달해 중단했습니다.",
  outside_allowed_hours: "허용한 시간대를 벗어나 중단했습니다.",
  consecutive_failures: "연속으로 실패해 중단했습니다.",
  captcha_required: "사람 확인이 필요해 중단했습니다. 직접 처리하세요.",
  login_required: "로그인이 필요해 중단했습니다. 브라우저에서 로그인하세요.",
};

const POST_STATE_LABELS: Record<string, string> = {
  succeeded: "성공",
  failed: "실패",
  unconfirmed: "확인 불가",
  running: "진행 중",
};

/** Render the batch screen for `state`. */
export function renderSession(root: Element, state: SessionState, handlers: SessionHandlers): void {
  const document = root.ownerDocument;
  root.textContent = "";

  const status = document.createElement("p");
  status.id = "workspace-status";
  status.setAttribute("role", "status");
  status.textContent = statusMessage(state);
  root.append(status);

  root.append(renderSchedulePanel(document, state));
  root.append(renderScopePanel(document, state, handlers));
  if (state.current !== null) root.append(renderProgressPanel(document, state, handlers));
  if (state.completedPosts.length > 0) root.append(renderPostList(document, state));
  root.append(renderRecentPanel(document, state));
}

function statusMessage(state: SessionState): string {
  if (state.phase === "loading") return "배치 정보를 불러오는 중입니다.";
  if (state.phase === "failed") return state.error ?? "배치 정보를 불러오지 못했습니다.";
  if (state.phase === "starting") return "배치를 시작하는 중입니다.";
  if (state.phase === "running") {
    const done = state.current?.processedCount ?? 0;
    const total = state.current?.maxPosts ?? state.maxPosts;
    return state.cancelRequested
      ? `취소를 요청했습니다. 지금 처리 중인 글까지 끝냅니다. (${done}/${total})`
      : `배치를 진행하는 중입니다. (${done}/${total})`;
  }
  if (state.phase === "finished") return finishedMessage(state.current);
  return "처리할 단계와 글 수를 고른 뒤 배치를 시작하세요.";
}

function finishedMessage(session: AutomationSession | null): string {
  if (session === null) return "배치가 끝났습니다.";
  if (session.state === "cancelled") {
    return `취소했습니다. ${session.processedCount}건을 처리했습니다.`;
  }
  if (session.state === "aborted") {
    const reason = session.abortReason ?? "";
    const detail = ABORT_LABELS[reason] ?? "중단했습니다.";
    return `${detail} ${session.processedCount}건을 처리했습니다.`;
  }
  return `배치를 마쳤습니다. ${session.processedCount}건을 처리했습니다.`;
}

function renderSchedulePanel(document: Document, state: SessionState): Element {
  const section = document.createElement("section");
  section.className = "schedule-panel";
  const heading = document.createElement("h2");
  heading.textContent = "무인 실행";
  section.append(heading);

  const line = document.createElement("p");
  line.className = "schedule-state";
  const schedule = state.schedule;
  if (schedule === null) {
    line.textContent = "무인 실행 상태를 아직 확인하지 못했습니다.";
  } else if (schedule.enabled) {
    const hour = String(schedule.hour).padStart(2, "0");
    const minute = String(schedule.minute).padStart(2, "0");
    line.textContent = `매일 ${hour}:${minute}에 최대 ${schedule.maxPosts}건을 자동으로 처리합니다.`;
  } else {
    const reason = schedule.blockingReason ?? "";
    line.textContent = SCHEDULE_REASONS[reason] ?? "무인 실행이 꺼져 있습니다.";
  }
  section.append(line);
  return section;
}

function renderScopePanel(
  document: Document,
  state: SessionState,
  handlers: SessionHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "scope-panel";
  const heading = document.createElement("h2");
  heading.textContent = "배치 범위";
  section.append(heading);

  const steps = document.createElement("div");
  steps.className = "step-choices";
  const stepNames: EngagementStepName[] = ["like", "comment", "mutual_neighbor"];
  for (const name of stepNames) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "step-choice";
    choice.dataset.step = name;
    choice.textContent = STEP_LABELS[name];
    const selected = state.approvedSteps.includes(name);
    choice.setAttribute("aria-pressed", selected ? "true" : "false");
    choice.disabled = isSessionBusy(state);
    choice.addEventListener("click", () => handlers.onToggleStep(name));
    steps.append(choice);
  }
  section.append(steps);

  const label = document.createElement("label");
  label.setAttribute("for", "max-posts");
  label.textContent = "최대 글 수";
  const input = document.createElement("input");
  input.id = "max-posts";
  input.type = "number";
  input.min = "1";
  input.max = "20";
  input.value = String(state.maxPosts);
  input.disabled = isSessionBusy(state);
  input.addEventListener("change", () => handlers.onMaxPostsChange(Number(input.value)));
  section.append(label, input);

  const note = document.createElement("p");
  note.className = "scope-note";
  note.textContent =
    "한 번 승인하면 고른 글 수까지 이어서 처리합니다. 취소는 지금 처리 중인 글이 끝난 뒤에 반영됩니다.";
  section.append(note);

  const start = document.createElement("button");
  start.type = "button";
  start.id = "start-session-button";
  start.textContent = "배치 시작";
  start.disabled = isSessionBusy(state);
  start.addEventListener("click", () => handlers.onStart());
  section.append(start);

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.id = "refresh-sessions-button";
  refresh.textContent = "새로고침";
  refresh.disabled = isSessionBusy(state);
  refresh.addEventListener("click", () => handlers.onRefresh());
  section.append(refresh);
  return section;
}

function renderProgressPanel(
  document: Document,
  state: SessionState,
  handlers: SessionHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "progress-panel";
  const heading = document.createElement("h2");
  heading.textContent = "진행 상황";
  section.append(heading);

  const session = state.current;
  if (session !== null) {
    const progress = document.createElement("p");
    progress.className = "progress-count";
    progress.textContent = `${STATE_LABELS[session.state] ?? session.state} · ${session.processedCount}/${session.maxPosts}건`;
    section.append(progress);

    const steps = document.createElement("p");
    steps.className = "progress-steps";
    steps.textContent = `단계 ${session.approvedSteps.map((name) => STEP_LABELS[name]).join(", ")}`;
    section.append(steps);

    if (session.state === "running" || session.state === "pending") {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.id = "cancel-session-button";
      cancel.textContent = state.cancelRequested ? "취소 요청함" : "배치 취소";
      cancel.disabled = state.cancelRequested;
      cancel.addEventListener("click", () => handlers.onCancel());
      section.append(cancel);
    }
  }
  return section;
}

function renderPostList(document: Document, state: SessionState): Element {
  const section = document.createElement("section");
  section.className = "post-result-panel";
  const heading = document.createElement("h2");
  heading.textContent = "처리한 글";
  section.append(heading);

  const list = document.createElement("ul");
  list.className = "post-result-list";
  for (const post of state.completedPosts) {
    const item = document.createElement("li");
    item.className = "post-result-item";
    const label = POST_STATE_LABELS[post.state] ?? post.state;
    const codes = post.resultCodes.length === 0 ? "" : ` (${post.resultCodes.join(", ")})`;
    item.textContent = `${label}${codes}`;
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderRecentPanel(document: Document, state: SessionState): Element {
  const section = document.createElement("section");
  section.className = "recent-session-panel";
  const heading = document.createElement("h2");
  heading.textContent = "최근 배치";
  section.append(heading);

  if (state.recent.length === 0) {
    const empty = document.createElement("p");
    empty.className = "recent-empty";
    empty.textContent = "아직 실행한 배치가 없습니다.";
    section.append(empty);
    return section;
  }

  const list = document.createElement("ul");
  list.className = "recent-session-list";
  for (const session of state.recent) {
    const item = document.createElement("li");
    item.className = "recent-session-item";
    const label = STATE_LABELS[session.state] ?? session.state;
    const reason =
      session.abortReason === null
        ? ""
        : ` · ${ABORT_LABELS[session.abortReason] ?? session.abortReason}`;
    item.textContent = `${label} · ${session.processedCount}/${session.maxPosts}건${reason}`;
    list.append(item);
  }
  section.append(list);
  return section;
}
