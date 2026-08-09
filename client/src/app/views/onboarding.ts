/**
 * First-run onboarding view.
 *
 * This view intentionally owns no state transitions. It derives one linear checklist from the
 * readiness snapshot and delegates every action to the caller, which keeps the shell/controller
 * responsible for navigation and refreshing the snapshot.
 */

import type { AppReadiness, BrowserSessionState } from "../api/types";
import type { SettingsSection } from "../controllers/settings";
import type { TodayState } from "../state/today";
import { Button, StatusChip } from "../ui/elements";

export interface OnboardingHandlers {
  onLaunchSession(): void;
  onFocusSession(): void;
  onOpenSettings(section?: SettingsSection): void;
  onRefresh(): void;
  onComplete(): void;
}

type StepId = "app" | "ai" | "blog" | "browser" | "login" | "safety";
type StepState = "complete" | "current" | "upcoming";

interface StepDefinition {
  id: StepId;
  label: string;
  complete(readiness: AppReadiness): boolean;
}

interface StepSnapshot extends StepDefinition {
  state: StepState;
}

interface StepAction {
  label: string;
  onClick(): void;
}

const STEP_DEFINITIONS: readonly StepDefinition[] = [
  {
    id: "app",
    label: "앱 준비",
    complete: (readiness) => readiness.webAppAssetsReady,
  },
  {
    id: "ai",
    label: "AI 연결",
    complete: (readiness) => readiness.generationAvailable,
  },
  {
    id: "blog",
    label: "내 블로그",
    complete: (readiness) => readiness.ownBlogConfigured,
  },
  {
    id: "browser",
    label: "자동화 브라우저",
    complete: (readiness) => readiness.browserState === "ready",
  },
  {
    id: "login",
    label: "네이버 로그인",
    complete: (readiness) => readiness.browserLogin === "authenticated",
  },
  {
    id: "safety",
    label: "안전 설정",
    complete: (readiness) => readiness.automationConsent && readiness.safetyPolicyConfigured,
  },
];

const STEP_STATE_LABELS: Record<StepState, string> = {
  complete: "완료",
  current: "현재",
  upcoming: "예정",
};

/** Render the standalone first-run checklist into `root`. */
export function renderOnboarding(
  root: Element,
  state: TodayState,
  handlers: OnboardingHandlers,
): void {
  const document = root.ownerDocument;
  root.textContent = "";

  const status = document.createElement("p");
  status.id = "workspace-status";
  status.setAttribute("role", "status");
  status.textContent = onboardingStatusMessage(state);
  root.append(status);

  const shell = document.createElement("div");
  shell.className = "onboarding-shell";
  shell.setAttribute("aria-labelledby", "onboarding-title");

  const hero = document.createElement("section");
  hero.className = "onboarding-hero";
  const title = document.createElement("h2");
  title.id = "onboarding-title";
  title.textContent = "처음 사용하기 전에 준비할 항목";
  const intro = document.createElement("p");
  intro.textContent = "필수 연결을 순서대로 확인하면 댓글 생성과 블로그 작업을 시작할 수 있습니다.";
  hero.append(title, intro);

  const snapshots = stepSnapshots(state);
  const completedCount = snapshots.filter((step) => step.state === "complete").length;
  const progress = document.createElement("section");
  progress.className = "onboarding-progress";
  progress.setAttribute("aria-labelledby", "onboarding-progress-title");
  const progressTitle = document.createElement("h3");
  progressTitle.id = "onboarding-progress-title";
  progressTitle.textContent = "설정 진행률";
  const progressBar = document.createElement("progress");
  progressBar.max = STEP_DEFINITIONS.length;
  progressBar.value = completedCount;
  progressBar.setAttribute("aria-label", "초기 설정 진행률");
  const progressLabel = document.createElement("span");
  progressLabel.className = "onboarding-progress-label";
  progressLabel.textContent = `${completedCount}/${STEP_DEFINITIONS.length} 완료`;
  progress.append(progressTitle, progressBar, progressLabel);

  const stepList = document.createElement("ol");
  stepList.className = "onboarding-step-list";
  snapshots.forEach((step, index) => {
    stepList.append(renderStep(document, step, index));
  });

  shell.append(hero, progress, stepList);
  if (isComplete(state, snapshots)) {
    shell.append(renderComplete(document, handlers));
  } else {
    const current = snapshots.find((step) => step.state === "current") ?? snapshots[0];
    if (current !== undefined) shell.append(renderCurrent(document, current, state, handlers));
  }
  root.append(shell);
}

function stepSnapshots(state: TodayState): StepSnapshot[] {
  const readiness = state.readiness;
  if (readiness === null) {
    return STEP_DEFINITIONS.map((definition, index) => ({
      ...definition,
      state: index === 0 ? "current" : "upcoming",
    }));
  }

  const completed = STEP_DEFINITIONS.map((definition) => definition.complete(readiness));
  let currentIndex = completed.findIndex((isComplete) => !isComplete);
  if (currentIndex < 0 && state.phase !== "ready") currentIndex = 0;
  return STEP_DEFINITIONS.map((definition, index) => ({
    ...definition,
    state: index === currentIndex ? "current" : completed[index] ? "complete" : "upcoming",
  }));
}

function isComplete(state: TodayState, snapshots: readonly StepSnapshot[]): boolean {
  return (
    state.phase === "ready" &&
    state.readiness !== null &&
    snapshots.every((step) => step.state === "complete")
  );
}

function renderStep(document: Document, step: StepSnapshot, index: number): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "onboarding-step";
  item.dataset.state = step.state;
  item.dataset.step = step.id;
  if (step.state === "current") item.setAttribute("aria-current", "step");

  const number = document.createElement("span");
  number.className = "onboarding-step-number";
  number.textContent = String(index + 1);
  const label = document.createElement("span");
  label.className = "onboarding-step-label";
  label.textContent = step.label;
  const state = document.createElement("span");
  state.className = "onboarding-step-state";
  state.textContent = STEP_STATE_LABELS[step.state];
  item.append(number, label, state);
  return item;
}

function renderCurrent(
  document: Document,
  step: StepSnapshot,
  state: TodayState,
  handlers: OnboardingHandlers,
): HTMLElement {
  const panel = document.createElement("section");
  panel.className = "onboarding-current-panel";
  panel.setAttribute("aria-labelledby", "onboarding-current-title");
  const title = document.createElement("h3");
  title.id = "onboarding-current-title";
  title.textContent = `현재 단계 · ${step.label}`;
  const status = StatusChip(document, {
    status: currentStatus(state),
    label: currentStatusLabel(state),
  });
  const description = document.createElement("p");
  description.className = "onboarding-current-description";
  description.textContent = stepDescription(step.id, state);
  const actions = document.createElement("div");
  actions.className = "onboarding-actions";
  const action = stepAction(step.id, state, handlers);
  const primary = Button(document, {
    id: "onboarding-current-action",
    label: action.label,
    variant: "primary",
    disabled: state.phase === "loading",
    onClick: action.onClick,
  });
  primary.classList.add("onboarding-primary-action");
  actions.append(primary);
  panel.append(title, status, description, actions);
  return panel;
}

function renderComplete(document: Document, handlers: OnboardingHandlers): HTMLElement {
  const complete = document.createElement("section");
  complete.className = "onboarding-complete";
  complete.setAttribute("aria-labelledby", "onboarding-complete-title");
  const title = document.createElement("h3");
  title.id = "onboarding-complete-title";
  title.textContent = "필수 설정을 완료했습니다";
  const summary = document.createElement("p");
  summary.textContent = "이제 홈에서 댓글 작업과 글쓰기를 시작할 수 있습니다.";
  const actions = document.createElement("div");
  actions.className = "onboarding-actions";
  const primary = Button(document, {
    id: "onboarding-complete-button",
    label: "홈으로 돌아가기",
    variant: "primary",
    onClick: handlers.onComplete,
  });
  primary.classList.add("onboarding-primary-action");
  actions.append(primary);
  complete.append(title, summary, actions);
  return complete;
}

function stepAction(step: StepId, state: TodayState, handlers: OnboardingHandlers): StepAction {
  if (state.phase === "failed") {
    return { label: "다시 시도", onClick: handlers.onRefresh };
  }
  switch (step) {
    case "app":
      return { label: "다시 확인", onClick: handlers.onRefresh };
    case "ai":
      return { label: "AI 연결 설정 열기", onClick: () => handlers.onOpenSettings("connections") };
    case "blog":
      return { label: "내 블로그 설정 열기", onClick: () => handlers.onOpenSettings("automation") };
    case "browser":
      if (
        state.readiness?.browserState === "launching" ||
        state.readiness?.browserState === "closing"
      ) {
        return { label: "상태 다시 확인", onClick: handlers.onRefresh };
      }
      return { label: "브라우저 시작", onClick: handlers.onLaunchSession };
    case "login":
      return { label: "PC 브라우저 열기", onClick: handlers.onFocusSession };
    case "safety":
      return { label: "안전 설정 열기", onClick: () => handlers.onOpenSettings("automation") };
  }
}

function stepDescription(step: StepId, state: TodayState): string {
  const readiness = state.readiness;
  if (state.phase === "failed") {
    return state.error === null
      ? "설정 상태를 확인하지 못했습니다. 다시 시도해 주세요."
      : `설정 상태를 확인하지 못했습니다: ${state.error} 다시 시도해 주세요.`;
  }
  if (readiness === null) {
    return "현재 설정 상태를 확인한 뒤 다음 단계로 이동합니다.";
  }
  switch (step) {
    case "app":
      return readiness.webAppAssetsReady
        ? "웹앱 파일이 준비되어 있습니다."
        : "PC에서 웹앱 파일을 준비한 뒤 다시 확인하세요.";
    case "ai":
      return readiness.generationAvailable
        ? "AI 연결이 준비되어 있습니다."
        : "사용할 AI provider와 model을 설정하세요.";
    case "blog":
      return readiness.ownBlogConfigured
        ? "내 블로그 연결이 준비되어 있습니다."
        : "댓글과 수집에 사용할 내 블로그 ID를 설정하세요.";
    case "browser":
      return browserDescription(readiness.browserState);
    case "login":
      return readiness.browserLogin === "authenticated"
        ? "네이버 로그인 상태가 확인되었습니다."
        : "PC 자동화 브라우저에서 네이버에 로그인하세요.";
    case "safety":
      return safetyDescription(readiness);
  }
}

function browserDescription(state: BrowserSessionState): string {
  if (state === "launching") return "자동화 브라우저를 시작하는 중입니다. 잠시 후 다시 확인하세요.";
  if (state === "closing") return "자동화 브라우저가 종료되는 중입니다. 종료 후 다시 시작하세요.";
  if (state === "ready") return "자동화 브라우저가 실행 중입니다.";
  return "PC 자동화 브라우저를 시작하세요.";
}

function safetyDescription(readiness: AppReadiness): string {
  const missing: string[] = [];
  if (!readiness.automationConsent) missing.push("자동 실행 동의");
  if (!readiness.safetyPolicyConfigured) missing.push("안전 정책");
  if (missing.length === 0) return "자동 실행 동의와 안전 정책이 모두 준비되었습니다.";
  if (missing.length === 1)
    return `${missing[0]}${missing[0] === "자동 실행 동의" ? "를" : "을"} 확인하세요.`;
  return "자동 실행 동의와 안전 정책을 확인하세요.";
}

function currentStatus(
  state: TodayState,
): "ready" | "needs-action" | "running" | "error" | "neutral" {
  if (state.phase === "failed") return "error";
  if (state.phase === "loading" || state.readiness === null) return "running";
  return "needs-action";
}

function currentStatusLabel(state: TodayState): string {
  if (state.phase === "failed") return "확인 실패";
  if (state.phase === "loading" || state.readiness === null) return "확인 중";
  return "필요 조치";
}

function onboardingStatusMessage(state: TodayState): string {
  if (state.phase === "failed") return state.error ?? "초기 설정 상태를 확인하지 못했습니다.";
  if (state.phase === "loading") return "초기 설정 상태를 확인하는 중입니다.";
  const readiness = state.readiness;
  if (readiness === null) return "초기 설정 상태를 확인할 수 없습니다. 다시 확인하세요.";
  if (state.phase === "ready" && STEP_DEFINITIONS.every((step) => step.complete(readiness))) {
    return "초기 설정을 완료했습니다.";
  }
  return "초기 설정을 진행하세요.";
}
