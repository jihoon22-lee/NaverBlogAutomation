/**
 * Today view.
 *
 * The wide layout shows the queue list and the selected post's detail at the same time. Rendering
 * is a pure function of state so tests can assert the DOM without a running service.
 */

import type {
  AppReadiness,
  BrowserSession,
  DiscoveryPost,
  DiscoveryState,
  EngagementStepName,
  SafetyStatus,
} from "../api/types";
import type { SettingsSection } from "../controllers/settings";
import {
  batchPreflight,
  canContinueBatchPreflight,
  canOpenSelected,
  selectedPost,
  type TodayState,
  visiblePosts,
} from "../state/today";
import { Button, Card, StatusChip } from "../ui/elements";

export interface TodayHandlers {
  onCloseSession(): void;
  onFocusSession(): void;
  onFilterChange(filter: "source" | "state", value: string): void;
  onSegmentChange(segment: "neighbor" | "search" | "skipped"): void;
  onLaunchSession(): void;
  onLoadMore(): void;
  onOpenPost(postId: string): void;
  onOpenDirectUrl(url: string): void;
  onOpenWorkbench(): void;
  onOpenWriting(): void;
  onOpenOnboarding(): void;
  onClearFilters(): void;
  onOpenBatch(): void;
  onOpenSettings(section?: SettingsSection): void;
  onCloseDetail(): void;
  onPostStateChange(postId: string, state: DiscoveryState): void;
  onRefresh(): void;
  onSelectPost(postId: string): void;
  onSortChange(value: "newest" | "oldest"): void;
  onQueryChange(value: string): void;
  onTogglePostSelection(postId: string): void;
  onToggleBatchStep(step: EngagementStepName): void;
}

const SESSION_LABELS: Record<BrowserSession["state"], string> = {
  stopped: "중지",
  launching: "시작 중",
  ready: "실행 중",
  closing: "종료 중",
};

const LOGIN_LABELS: Record<BrowserSession["login"], string> = {
  unknown: "확인 필요",
  anonymous: "로그아웃",
  authenticated: "로그인",
};

const SOURCE_LABELS: Record<DiscoveryPost["source"], string> = {
  neighbor: "이웃 새 글",
  search: "신규 이웃 후보",
};

const BATCH_STEP_LABELS: Record<EngagementStepName, string> = {
  like: "공감",
  comment: "댓글 등록",
  mutual_neighbor: "서로이웃 신청",
};

/** Render the Today view into `root`. */
export function renderToday(root: Element, state: TodayState, handlers: TodayHandlers): void {
  const document = root.ownerDocument;
  root.textContent = "";

  const status = document.createElement("p");
  status.id = "workspace-status";
  status.setAttribute("role", "status");
  status.textContent = statusMessage(state);
  root.append(status);

  root.append(renderWorkbenchHeader(document, state, handlers));
  const readinessBanner = renderWorkbenchReadinessBanner(document, state, handlers);
  if (readinessBanner !== null) root.append(readinessBanner);

  if (state.phase === "failed") return;

  const layout = document.createElement("div");
  layout.className = "today-layout";
  const queue = document.createElement("div");
  queue.append(renderQueue(document, state, handlers));
  const batch = renderBatchPreview(document, state, handlers);
  if (batch !== null) queue.append(batch);
  queue.append(renderDirectUrl(document, handlers));
  layout.append(queue);
  const detail = renderDetail(document, state, handlers);
  if (detail !== null) layout.append(detail);
  root.append(layout);
}

/**
 * Render the deliberately small home dashboard.
 *
 * The same controller loads readiness and queue metadata for the dashboard, but the potentially
 * long queue itself belongs to the workbench.  Keeping this view separate prevents the home page
 * from turning back into a second work queue on a narrow tablet.
 */
export function renderHome(root: Element, state: TodayState, handlers: TodayHandlers): void {
  const document = root.ownerDocument;
  root.textContent = "";

  const status = document.createElement("p");
  status.id = "workspace-status";
  status.setAttribute("role", "status");
  status.textContent =
    state.phase === "idle" || state.phase === "loading"
      ? "홈 준비 상태를 불러오는 중입니다."
      : state.phase === "failed"
        ? (state.error ?? "홈 준비 상태를 불러오지 못했습니다.")
        : "오늘의 블로그 작업을 준비했습니다.";
  root.append(status);

  const next = homeNextAction(state, handlers);
  const hero = document.createElement("section");
  hero.className = "home-hero";
  hero.setAttribute("aria-labelledby", "home-hero-title");
  const heroTitle = document.createElement("h2");
  heroTitle.id = "home-hero-title";
  heroTitle.textContent = "오늘의 블로그 작업을 시작하세요";
  const intro = document.createElement("p");
  intro.className = "home-hero-intro";
  intro.textContent =
    "댓글을 만들고 초안을 작성하는 데 필요한 상태를 한눈에 확인하고 다음 작업으로 이동하세요.";
  const nextPanel = document.createElement("div");
  nextPanel.className = "home-next-action";
  nextPanel.setAttribute("aria-labelledby", "home-next-action-title");
  const nextTitle = document.createElement("h2");
  nextTitle.id = "home-next-action-title";
  nextTitle.textContent = "다음 작업";
  const nextStatus = StatusChip(document, {
    status: next.status,
    label: next.statusLabel,
    className: "home-next-status",
  });
  const nextDescription = document.createElement("p");
  nextDescription.className = "home-next-action-description";
  nextDescription.textContent = next.description;
  const primary = Button(document, {
    id: next.id,
    label: next.label,
    variant: "primary",
    disabled: next.disabled,
    onClick: next.onClick,
  });
  primary.classList.add("home-primary-action");
  nextPanel.append(nextTitle, nextStatus, nextDescription, primary);
  hero.append(heroTitle, intro, nextPanel);
  root.append(hero);

  const summary = document.createElement("section");
  summary.className = "home-summary-panel";
  summary.setAttribute("aria-labelledby", "home-summary-title");
  const summaryTitle = heading(document, "오늘의 수집 요약");
  summaryTitle.id = "home-summary-title";
  summary.append(summaryTitle);
  const counts = state.counts;
  const activeCount = counts.neighbor + counts.search;
  const description = document.createElement("p");
  description.className = "home-summary-description";
  description.textContent =
    activeCount === 0
      ? "아직 처리할 글이 없습니다. 탐색 설정을 확인하거나 새로 수집하세요."
      : `처리할 글 ${activeCount}건을 출처별로 확인하세요.`;
  summary.append(description);
  const metrics = document.createElement("div");
  metrics.className = "home-metrics-grid";
  metrics.setAttribute("role", "group");
  metrics.setAttribute("aria-label", "수집 요약 지표");
  for (const [key, label, value] of [
    ["total", "전체 항목", counts.total],
    ["neighbor", "이웃 새 글", counts.neighbor],
    ["search", "검색 후보", counts.search],
    ["skipped", "보류됨", counts.skipped],
  ] as const) {
    const metricTitle = document.createElement("h3");
    metricTitle.textContent = label;
    const metricValue = document.createElement("p");
    metricValue.className = "home-metric-value";
    metricValue.textContent = String(value);
    const metric = Card(document, {
      variant: "flat",
      className: "home-metric-card",
      children: [metricTitle, metricValue],
    });
    metric.dataset.metric = key;
    metrics.append(metric);
  }
  summary.append(metrics);
  root.append(summary);

  const readiness = document.createElement("section");
  readiness.className = "home-readiness-panel";
  readiness.setAttribute("aria-labelledby", "home-readiness-title");
  const readinessTitle = heading(document, "시작 준비");
  readinessTitle.id = "home-readiness-title";
  readiness.append(readinessTitle);
  const readinessState = homeReadinessState(state);
  const readinessChip = StatusChip(document, {
    status: readinessState.status,
    label: readinessState.label,
    className: "home-readiness-status",
  });
  const readinessDescription = document.createElement("p");
  readinessDescription.className = "home-readiness-description";
  readinessDescription.textContent = readinessState.description;
  readiness.append(readinessChip, readinessDescription);
  appendReadinessDetails(document, readiness, state, handlers);
  root.append(readiness);

  const quick = document.createElement("section");
  quick.className = "home-quick-panel";
  quick.setAttribute("aria-labelledby", "home-quick-title");
  const quickTitle = heading(document, "빠른 시작");
  quickTitle.id = "home-quick-title";
  quick.append(quickTitle);
  const note = document.createElement("p");
  note.textContent =
    "글을 고르고 댓글을 작성하거나, 집중할 수 있는 글쓰기 화면에서 새 초안을 시작하세요.";
  const quickActions = document.createElement("div");
  quickActions.className = "home-quick-actions";
  const openWorkbench = Button(document, {
    id: "home-quick-workbench",
    label: "작업함 열기",
    variant: "secondary",
    disabled: state.phase === "loading",
    onClick: handlers.onOpenWorkbench,
  });
  const openWriting = Button(document, {
    id: "home-start-writing",
    label: "새 글 시작",
    variant: "secondary",
    onClick: handlers.onOpenWriting,
  });
  quickActions.append(openWorkbench, openWriting);
  quick.append(note, quickActions);
  root.append(quick);
}

interface HomeNextAction {
  id: string;
  label: string;
  description: string;
  status: "ready" | "needs-action" | "running" | "error" | "neutral";
  statusLabel: string;
  disabled: boolean;
  onClick: () => void;
}

interface HomeReadinessState {
  status: "ready" | "needs-action" | "running" | "error" | "neutral";
  label: string;
  description: string;
}

function homeNextAction(state: TodayState, handlers: TodayHandlers): HomeNextAction {
  if (state.phase === "failed") {
    return {
      id: "home-refresh",
      label: "다시 시도",
      description: state.error ?? "홈 준비 상태를 불러오지 못했습니다.",
      status: "error",
      statusLabel: "확인 실패",
      disabled: false,
      onClick: handlers.onRefresh,
    };
  }
  if (state.phase === "idle" || state.phase === "loading") {
    return {
      id: "home-refresh",
      label: "준비 상태 확인 중",
      description: "AI, 브라우저, 네이버 로그인 상태를 확인하고 있습니다.",
      status: "running",
      statusLabel: "확인 중",
      disabled: true,
      onClick: handlers.onRefresh,
    };
  }
  if (state.readiness === null) {
    return {
      id: "home-refresh",
      label: "준비 상태 다시 확인",
      description: "일부 준비 상태를 확인하지 못했습니다. 새로고침해 다시 확인하세요.",
      status: "neutral",
      statusLabel: "일부 미확인",
      disabled: false,
      onClick: handlers.onRefresh,
    };
  }

  if (state.readiness.blockers.length > 0) {
    return {
      id: "home-open-onboarding",
      label: "초기 설정 계속",
      description: "필수 설정을 완료하면 댓글 생성과 수집을 시작할 수 있습니다.",
      status: "needs-action",
      statusLabel: "필요 조치",
      disabled: false,
      onClick: handlers.onOpenOnboarding,
    };
  }

  const activeCount = state.counts.neighbor + state.counts.search;
  if (activeCount > 0) {
    return {
      id: "home-open-workbench",
      label: "작업함 열기",
      description: `처리할 글 ${activeCount}건이 있습니다. 작업함에서 다음 글을 선택하세요.`,
      status: "ready",
      statusLabel: "준비됨",
      disabled: false,
      onClick: handlers.onOpenWorkbench,
    };
  }
  return {
    id: "home-refresh",
    label: "새로 수집",
    description: "처리할 글이 없습니다. 최신 작업을 확인하려면 수집 상태를 새로고침하세요.",
    status: "neutral",
    statusLabel: "대기 중",
    disabled: false,
    onClick: handlers.onRefresh,
  };
}

function homeReadinessState(state: TodayState): HomeReadinessState {
  if (state.phase === "failed") {
    return {
      status: "error",
      label: "확인 실패",
      description: state.error ?? "필수 조건 상태를 확인하지 못했습니다.",
    };
  }
  if (state.phase === "idle" || state.phase === "loading") {
    return {
      status: "running",
      label: "확인 중",
      description: "AI, 브라우저, 네이버 로그인 상태를 확인하는 중입니다.",
    };
  }
  if (state.readiness === null) {
    return {
      status: "neutral",
      label: "일부 미확인",
      description: "일부 준비 상태를 확인하지 못했습니다. 새로고침해 다시 확인하세요.",
    };
  }
  if (state.readiness.blockers.length > 0) {
    return {
      status: "needs-action",
      label: "필요 조치",
      description: "아래 항목을 확인하면 댓글 생성과 수집을 시작할 수 있습니다.",
    };
  }
  return {
    status: "ready",
    label: "준비 완료",
    description: "AI, 브라우저, 네이버 로그인 상태가 모두 준비되었습니다.",
  };
}

function appendReadinessDetails(
  document: Document,
  parent: Element,
  state: TodayState,
  handlers: TodayHandlers,
): void {
  if (state.phase === "failed") {
    const list = document.createElement("ul");
    list.className = "home-readiness-list";
    const item = document.createElement("li");
    item.textContent = "필수 조건을 다시 확인하세요.";
    list.append(item);
    parent.append(list);
    return;
  }
  if (state.phase === "idle" || state.phase === "loading") {
    const list = document.createElement("ul");
    list.className = "home-readiness-list";
    const item = document.createElement("li");
    item.textContent = "필수 조건을 확인하는 중입니다.";
    list.append(item);
    parent.append(list);
    return;
  }
  if (state.readiness === null) {
    const list = document.createElement("ul");
    list.className = "home-readiness-list";
    const item = document.createElement("li");
    item.textContent = "준비 상태 정보를 불러오지 못했습니다.";
    list.append(item);
    parent.append(list);
    return;
  }
  if (state.readiness.blockers.length === 0) {
    const list = document.createElement("ul");
    list.className = "home-readiness-list";
    for (const label of ["AI 생성 준비됨", "자동화 브라우저 준비됨", "네이버 로그인 준비됨"]) {
      const item = document.createElement("li");
      item.textContent = label;
      list.append(item);
    }
    parent.append(list);
    return;
  }

  const list = document.createElement("ul");
  list.className = "home-readiness-list";
  for (const blocker of state.readiness.blockers) {
    const item = document.createElement("li");
    item.className = "home-readiness-item";
    item.dataset.blocker = blocker;
    const chip = StatusChip(document, { status: "needs-action", label: "필요 조치" });
    chip.setAttribute("aria-hidden", "true");
    const message = document.createElement("span");
    message.className = "home-readiness-item-label";
    message.textContent = blockerLabel(blocker);
    item.append(chip, message);

    const action = blockerAction(document, blocker, handlers);
    if (action !== null) item.append(action);
    list.append(item);
  }
  parent.append(list);
}

function blockerAction(
  document: Document,
  blocker: AppReadiness["blockers"][number],
  handlers: TodayHandlers,
): HTMLButtonElement | null {
  if (blocker === "browser_not_running") {
    return Button(document, {
      id: "home-launch-browser",
      label: "브라우저 시작",
      variant: "secondary",
      onClick: handlers.onLaunchSession,
    });
  }
  if (blocker === "naver_login_required") {
    return Button(document, {
      id: "home-focus-browser",
      label: "PC 브라우저 열기",
      variant: "secondary",
      onClick: handlers.onFocusSession,
    });
  }
  if (blocker === "web_app_assets_missing") {
    return Button(document, {
      id: "home-web_app_assets_missing",
      label: "다시 확인",
      variant: "secondary",
      onClick: handlers.onRefresh,
    });
  }
  return Button(document, {
    id: `home-${blocker}`,
    label: "설정 열기",
    variant: "secondary",
    onClick: () => handlers.onOpenSettings(settingsSectionForBlocker(blocker)),
  });
}

function renderDirectUrl(document: Document, handlers: TodayHandlers): Element {
  const section = document.createElement("details");
  section.className = "direct-url-panel";
  const summary = document.createElement("summary");
  summary.textContent = "대기열에 없는 글 처리";
  const note = document.createElement("p");
  note.textContent = "대기열 밖 글은 댓글 후보 생성과 복사만 할 수 있으며 자동 실행하지 않습니다.";
  const label = document.createElement("label");
  label.htmlFor = "direct-post-url";
  label.textContent = "네이버 블로그 글 주소";
  const input = document.createElement("input");
  input.id = "direct-post-url";
  input.type = "url";
  input.placeholder = "https://blog.naver.com/...";
  const open = button(document, "open-direct-url-button", "댓글 후보 만들기", () =>
    handlers.onOpenDirectUrl(input.value),
  );
  section.append(summary, note, label, input, open);
  return section;
}

function statusMessage(state: TodayState): string {
  if (state.phase === "loading") return "오늘의 작업을 불러오는 중입니다.";
  if (state.phase === "failed") return state.error ?? "오늘의 작업을 불러오지 못했습니다.";
  if (state.phase === "idle") return "로컬 서비스에 연결하는 중입니다.";
  const counts = state.counts;
  const active = counts.neighbor + counts.search;
  if (active === 0 && counts.skipped > 0) {
    return `처리할 글이 없습니다. 보류 ${counts.skipped}건이 있습니다.`;
  }
  return active === 0
    ? "대기열이 비어 있습니다. 설정에서 자동 탐색을 확인하세요."
    : `대기 중인 글 ${active}건 (이웃 ${counts.neighbor}, 검색 ${counts.search})`;
}

function renderWorkbenchHeader(
  document: Document,
  state: TodayState,
  handlers: TodayHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "workbench-header";
  section.setAttribute("aria-labelledby", "workbench-header-title");
  const title = document.createElement("h2");
  title.id = "workbench-header-title";
  title.textContent = "댓글 작업함";
  const description = document.createElement("p");
  description.className = "workbench-header-description";
  description.textContent = "처리할 글을 확인하고 댓글 작업을 이어가세요.";

  const counts = state.counts;
  const summary = document.createElement("div");
  summary.className = "workbench-header-summary";
  summary.setAttribute("role", "group");
  summary.setAttribute("aria-label", "작업함 요약");
  summary.append(
    headerMetric(document, "처리 대기", counts.neighbor + counts.search, "active"),
    headerMetric(document, "보류", counts.skipped, "skipped"),
  );

  const connection = document.createElement("div");
  connection.className = "workbench-connection-status";
  const connectionState = workbenchConnectionState(state);
  connection.dataset.status = connectionState.status;
  const chip = StatusChip(document, {
    status: connectionState.status,
    label: connectionState.label,
  });
  const connectionText = document.createElement("span");
  connectionText.textContent = connectionState.description;
  connection.append(chip, connectionText);

  const refresh = Button(document, {
    id: "refresh-button",
    label: "새로고침",
    variant: "secondary",
    disabled: state.phase === "loading",
    onClick: handlers.onRefresh,
  });
  refresh.classList.add("workbench-refresh-action");

  const details = document.createElement("details");
  details.className = "workbench-service-details";
  const detailsSummary = document.createElement("summary");
  detailsSummary.textContent = "연결 상태 상세";
  details.append(detailsSummary, renderServiceDetails(document, state, handlers));
  section.append(title, description, summary, connection, refresh, details);
  return section;
}

function headerMetric(document: Document, label: string, value: number, key: string): Element {
  const metric = Card(document, { variant: "flat", className: "workbench-header-metric" });
  metric.dataset.metric = key;
  const title = document.createElement("span");
  title.className = "workbench-header-metric-label";
  title.textContent = label;
  const count = document.createElement("strong");
  count.className = "workbench-header-metric-value";
  count.textContent = String(value);
  metric.append(title, count);
  return metric;
}

function workbenchConnectionState(state: TodayState): {
  status: "ready" | "needs-action" | "running" | "error" | "neutral";
  label: string;
  description: string;
} {
  if (state.phase === "failed") {
    return { status: "error", label: "확인 실패", description: "연결 상태를 확인하지 못했습니다." };
  }
  if (state.phase === "idle" || state.phase === "loading") {
    return {
      status: "running",
      label: "확인 중",
      description: "서비스와 브라우저 상태를 확인하는 중입니다.",
    };
  }
  if (state.service === null) {
    return {
      status: "neutral",
      label: "일부 미확인",
      description: "서비스 연결 상태를 확인하세요.",
    };
  }
  if (state.session?.state !== "ready") {
    return {
      status: "needs-action",
      label: "브라우저 필요",
      description: "자동화 브라우저를 시작하세요.",
    };
  }
  if (state.session.login !== "authenticated") {
    return {
      status: "needs-action",
      label: "로그인 필요",
      description: "네이버 로그인 상태를 확인하세요.",
    };
  }
  return { status: "ready", label: "연결됨", description: "서비스와 브라우저가 준비되었습니다." };
}

function renderServiceDetails(
  document: Document,
  state: TodayState,
  handlers: TodayHandlers,
): Element {
  const content = document.createElement("div");
  content.className = "workbench-service-details-content";

  const list = document.createElement("dl");
  appendTerm(document, list, "서비스", state.service === null ? "연결 확인 중" : "준비됨");
  appendTerm(document, list, "생성기", state.service?.generatorModel ?? "-");
  appendTerm(
    document,
    list,
    "브라우저",
    state.session === null ? "-" : SESSION_LABELS[state.session.state],
  );
  appendTerm(
    document,
    list,
    "로그인",
    state.session === null ? "-" : LOGIN_LABELS[state.session.login],
  );
  content.append(list);

  if (state.session?.detail != null) {
    const detail = document.createElement("p");
    detail.className = "session-detail";
    detail.textContent = state.session.detail;
    content.append(detail);
  }

  const actions = document.createElement("div");
  actions.className = "service-actions";
  const transitionInProgress =
    state.session?.state === "launching" || state.session?.state === "closing";
  const controlsDisabled = state.phase !== "ready" || transitionInProgress;
  if (state.session?.state === "ready") {
    const focus = button(
      document,
      "focus-session-button",
      "브라우저 창 보이기",
      handlers.onFocusSession,
    );
    focus.disabled = controlsDisabled;
    const close = button(
      document,
      "close-session-button",
      "브라우저 종료",
      handlers.onCloseSession,
    );
    close.disabled = controlsDisabled;
    actions.append(focus, close);
  } else {
    const launch = button(
      document,
      "launch-session-button",
      "브라우저 시작",
      handlers.onLaunchSession,
    );
    launch.disabled = controlsDisabled;
    actions.append(launch);
  }
  content.append(actions);
  return content;
}

function renderWorkbenchReadinessBanner(
  document: Document,
  state: TodayState,
  handlers: TodayHandlers,
): Element | null {
  if (
    state.phase !== "ready" ||
    state.readiness === null ||
    state.readiness.blockers.length === 0
  ) {
    return null;
  }
  const banner = document.createElement("section");
  banner.className = "workbench-readiness-banner";
  banner.setAttribute("aria-labelledby", "workbench-readiness-title");
  const title = document.createElement("h3");
  title.id = "workbench-readiness-title";
  title.textContent = "작업을 시작하기 전에 설정을 확인하세요";
  const message = document.createElement("p");
  message.textContent = `필수 설정 ${state.readiness.blockers.length}건을 확인하면 댓글 작업을 시작할 수 있습니다.`;
  const open = Button(document, {
    id: "open-onboarding-button",
    label: "설정 가이드 열기",
    variant: "primary",
    onClick: handlers.onOpenOnboarding,
  });
  banner.append(title, message, open);
  return banner;
}

function renderQueue(document: Document, state: TodayState, handlers: TodayHandlers): Element {
  const section = document.createElement("section");
  section.className = "queue-panel";
  section.setAttribute("aria-labelledby", "queue-title");
  const heading = document.createElement("h2");
  heading.id = "queue-title";
  heading.textContent = "작업 목록";
  const description = document.createElement("p");
  description.className = "queue-description";
  const activeCount = state.counts.neighbor + state.counts.search;
  description.textContent = `처리 대기 ${activeCount}건 · 보류 ${state.counts.skipped}건`;
  section.append(heading, description);

  section.append(renderSegments(document, state, handlers));
  section.append(renderFilters(document, state, handlers));

  const posts = visiblePosts(state);
  if (posts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "queue-empty";
    if (hasQueueFilters(state)) {
      empty.textContent = "검색 또는 필터 조건에 맞는 글이 없습니다.";
      const clear = button(document, "queue-clear-filters", "필터 초기화", handlers.onClearFilters);
      clear.disabled = state.phase === "loading";
      empty.append(clear);
    } else {
      empty.textContent = "대기 중인 글이 없습니다. 새로 수집하면 여기에 표시됩니다.";
    }
    section.append(empty);
    return section;
  }

  const list = document.createElement("ul");
  list.className = "queue-list";
  for (const post of posts) {
    const item = document.createElement("li");
    const batchLabel = document.createElement("label");
    batchLabel.className = "queue-batch-select";
    const batch = document.createElement("input");
    batch.type = "checkbox";
    batch.id = `queue-batch-${post.id}`;
    batch.checked = state.selectedPostIds.includes(post.id);
    batch.setAttribute("aria-label", `${post.title} 일괄 처리에 선택`);
    batch.addEventListener("click", (event) => event.stopPropagation());
    batch.addEventListener("change", () => handlers.onTogglePostSelection(post.id));
    const ordinal = state.selectedPostIds.indexOf(post.id);
    batchLabel.append(batch, document.createTextNode(ordinal < 0 ? "선택" : `${ordinal + 1}순위`));
    item.append(batchLabel);
    const select = document.createElement("button");
    select.type = "button";
    select.id = `queue-post-${post.id}`;
    select.className = "queue-item";
    select.dataset.postId = post.id;
    select.setAttribute("aria-pressed", String(post.id === state.selectedPostId));
    const topLine = document.createElement("span");
    topLine.className = "queue-item-topline";
    const source = document.createElement("span");
    source.className = "queue-item-source";
    source.textContent = SOURCE_LABELS[post.source];
    const stateBadge = StatusChip(document, {
      status: queueStateStatus(post.state),
      label: queueStateLabel(post.state),
      className: "queue-item-state",
    });
    topLine.append(source, stateBadge);
    const title = document.createElement("span");
    title.className = "queue-item-title";
    title.textContent = post.title;
    const meta = document.createElement("span");
    meta.className = "queue-item-meta";
    const author = post.publisherName ?? post.publisherBlogId ?? "작성자 확인 필요";
    const context = post.sourceLabel ?? "탐색 맥락 없음";
    meta.textContent = `${author} · ${context}`;
    const when = post.publishedAt ?? post.createdAt;
    const time = document.createElement("time");
    time.className = "queue-item-date";
    time.dateTime = when;
    time.textContent = formatQueueDate(when);
    select.append(topLine, title, meta, time);
    select.addEventListener("click", () => handlers.onSelectPost(post.id));
    item.append(select);
    list.append(item);
  }
  section.append(list);
  if (state.nextCursor !== null) {
    section.append(button(document, "load-more-queue-button", "더 불러오기", handlers.onLoadMore));
  }
  return section;
}

function hasQueueFilters(state: TodayState): boolean {
  return (
    state.query.trim().length > 0 ||
    state.sourceFilter !== "neighbor" ||
    state.stateFilter !== "all" ||
    state.sort !== "newest"
  );
}

const QUEUE_STATE_LABELS: Record<DiscoveryState, string> = {
  queued: "대기",
  opened: "열어봄",
  completed: "완료",
  skipped: "보류",
  unavailable: "사용 불가",
};

function queueStateLabel(state: DiscoveryState): string {
  return QUEUE_STATE_LABELS[state];
}

function queueStateStatus(
  state: DiscoveryState,
): "ready" | "needs-action" | "running" | "error" | "neutral" {
  if (state === "completed") return "ready";
  if (state === "opened") return "running";
  if (state === "skipped") return "needs-action";
  if (state === "unavailable") return "error";
  return "neutral";
}

function formatQueueDate(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "게시일 확인 필요";
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed;
  return `${parsed.getUTCFullYear()}.${String(parsed.getUTCMonth() + 1).padStart(2, "0")}.${String(parsed.getUTCDate()).padStart(2, "0")}`;
}

function renderSegments(document: Document, state: TodayState, handlers: TodayHandlers): Element {
  const panel = document.createElement("div");
  panel.className = "queue-segments";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "작업 목록 범위");
  const selected = selectedSegment(state);
  for (const [segment, label, count] of [
    ["neighbor", "이웃 새 글", state.counts.neighbor],
    ["search", "새 이웃 후보", state.counts.search],
    ["skipped", "보류됨", state.counts.skipped],
  ] as const) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.id = `queue-segment-${segment}`;
    choice.disabled = state.phase === "loading";
    choice.className = "queue-segment";
    choice.dataset.segment = segment;
    choice.setAttribute("aria-pressed", String(selected === segment));
    choice.textContent = `${label} ${count}`;
    choice.addEventListener("click", () => handlers.onSegmentChange(segment));
    panel.append(choice);
  }
  return panel;
}

function selectedSegment(state: TodayState): "neighbor" | "search" | "skipped" | null {
  if (state.sourceFilter === "all" && state.stateFilter === "all") return null;
  if (state.stateFilter === "skipped") return "skipped";
  if (state.sourceFilter === "search") return "search";
  if (state.sourceFilter === "neighbor") return "neighbor";
  return null;
}

function renderFilters(document: Document, state: TodayState, handlers: TodayHandlers): Element {
  const panel = document.createElement("div");
  panel.className = "queue-filters";
  panel.setAttribute("role", "search");
  panel.setAttribute("aria-label", "작업 목록 탐색");
  const queryLabel = document.createElement("label");
  queryLabel.htmlFor = "queue-query";
  queryLabel.textContent = "검색";
  const query = document.createElement("input");
  query.id = "queue-query";
  query.type = "search";
  query.placeholder = "제목, 작성자, 검색어 검색";
  query.value = state.query;
  query.disabled = state.phase === "loading";
  const applyQuery = () => handlers.onQueryChange(query.value);
  query.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    applyQuery();
  });
  const search = Button(document, {
    id: "queue-search-button",
    label: "검색 적용",
    variant: "secondary",
    disabled: state.phase === "loading",
    onClick: applyQuery,
  });
  panel.append(queryLabel, query, search);

  const advanced = document.createElement("details");
  advanced.className = "queue-advanced-filters";
  advanced.open =
    state.sourceFilter === "all" || state.stateFilter !== "all" || state.sort === "oldest";
  const advancedSummary = document.createElement("summary");
  advancedSummary.id = "queue-advanced-filters-toggle";
  advancedSummary.textContent = "고급 필터";
  const fields = document.createElement("div");
  fields.className = "queue-filter-fields";

  const source = document.createElement("select");
  source.id = "queue-source-filter";
  source.disabled = state.phase === "loading";
  for (const [value, label] of [
    ["all", "모든 출처"],
    ["neighbor", "이웃 새 글"],
    ["search", "신규 이웃 후보"],
  ]) {
    const option = document.createElement("option");
    option.value = value ?? "";
    option.textContent = label ?? "";
    option.selected = state.sourceFilter === value;
    source.append(option);
  }
  const sourceLabel = document.createElement("label");
  sourceLabel.htmlFor = source.id;
  sourceLabel.textContent = "출처";
  source.addEventListener("change", () => handlers.onFilterChange("source", source.value));
  const status = document.createElement("select");
  status.id = "queue-state-filter";
  status.disabled = state.phase === "loading";
  for (const [value, label] of [
    ["all", "모든 상태"],
    ["queued", "대기"],
    ["opened", "열어봄"],
    ["skipped", "보류"],
    ["completed", "완료"],
    ["unavailable", "사용 불가"],
  ]) {
    const option = document.createElement("option");
    option.value = value ?? "";
    option.textContent = label ?? "";
    option.selected = state.stateFilter === value;
    status.append(option);
  }
  const statusLabel = document.createElement("label");
  statusLabel.htmlFor = status.id;
  statusLabel.textContent = "상태";
  status.addEventListener("change", () => handlers.onFilterChange("state", status.value));
  const sort = document.createElement("select");
  sort.id = "queue-sort";
  for (const [value, label] of [
    ["newest", "최신순"],
    ["oldest", "오래된순"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = state.sort === value;
    sort.append(option);
  }
  const sortLabel = document.createElement("label");
  sortLabel.htmlFor = sort.id;
  sortLabel.textContent = "정렬";
  sort.addEventListener("change", () => handlers.onSortChange(sort.value as "newest" | "oldest"));
  fields.append(sourceLabel, source, statusLabel, status, sortLabel, sort);
  advanced.append(advancedSummary, fields);
  panel.append(advanced);
  return panel;
}

function renderBatchPreview(
  document: Document,
  state: TodayState,
  handlers: TodayHandlers,
): Element | null {
  if (state.selectedPostIds.length === 0) return null;
  const section = document.createElement("section");
  section.className = "queue-batch-preview";
  section.append(heading(document, "일괄 처리 확인"));
  const selected = state.selectedPostIds
    .map((id) => state.posts.find((post) => post.id === id))
    .filter((post): post is DiscoveryPost => post !== undefined);
  const list = document.createElement("ol");
  for (const post of selected) {
    const item = document.createElement("li");
    item.textContent = post.title;
    list.append(item);
  }
  const safety = document.createElement("p");
  safety.className = "queue-batch-summary";
  safety.textContent = `선택 순서대로 ${selected.length}건을 처리합니다. 아래 범위는 승인 직전에 다시 확인합니다.`;
  section.append(list, safety);
  section.append(renderBatchSteps(document, state, handlers));
  section.append(renderBatchSafety(document, state));
  const continueButton = button(
    document,
    "open-batch-preview",
    `${selected.length}건 일괄 처리 계속`,
    handlers.onOpenBatch,
  );
  continueButton.disabled = !canContinueBatchPreflight(state);
  section.append(continueButton);
  return section;
}

function renderBatchSteps(document: Document, state: TodayState, handlers: TodayHandlers): Element {
  const section = document.createElement("section");
  section.className = "queue-batch-steps";
  const title = document.createElement("h3");
  title.textContent = "승인할 단계";
  section.append(title);
  const choices = document.createElement("div");
  choices.className = "step-choices";
  for (const step of ["like", "comment", "mutual_neighbor"] as const) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.id = `batch-step-${step}`;
    choice.className = "step-choice";
    choice.textContent = BATCH_STEP_LABELS[step];
    choice.setAttribute("aria-pressed", String(state.approvedSteps.includes(step)));
    choice.addEventListener("click", () => handlers.onToggleBatchStep(step));
    choices.append(choice);
  }
  const note = document.createElement("p");
  note.className = "queue-batch-step-note";
  note.textContent =
    "댓글·공감·서로이웃 신청은 선택한 단계만 실행하며, 하나 이상은 선택해야 합니다.";
  section.append(choices, note);
  return section;
}

function renderBatchSafety(document: Document, state: TodayState): Element {
  const section = document.createElement("section");
  section.className = "queue-batch-safety";
  const title = document.createElement("h3");
  title.textContent = "현재 안전 한도와 최소 시간";
  section.append(title);
  const safety = state.safety;
  const preview = batchPreflight(state);
  if (safety === null) {
    const unavailable = document.createElement("p");
    unavailable.textContent =
      "현재 안전 정책을 불러오지 못했습니다. 새로고침한 뒤 한도를 확인하세요.";
    section.append(unavailable);
    return section;
  }

  const status = document.createElement("p");
  status.className = safety.allowedNow ? "safety-ok" : "safety-blocked";
  status.textContent = safety.allowedNow
    ? `${safety.localDate} 기준 안전 정책을 확인했습니다.`
    : safetyBlockerLabel(safety);
  section.append(status);

  const limits = document.createElement("ul");
  limits.className = "queue-batch-limits";
  for (const [step, count] of preview.actionCounts) {
    const action = safety.actions.find((candidate) => candidate.name === step);
    const item = document.createElement("li");
    if (action === undefined) {
      item.textContent = `${BATCH_STEP_LABELS[step]} 한도를 확인할 수 없습니다.`;
    } else {
      const permitted = action.remaining >= count;
      item.className = permitted ? "safety-ok" : "safety-blocked";
      item.textContent = `${BATCH_STEP_LABELS[step]}: 오늘 ${action.used}/${action.cap}회 사용 · ${action.remaining}회 남음 · 이번 승인 ${count}회`;
    }
    limits.append(item);
  }
  section.append(limits);

  const pace = document.createElement("p");
  const seconds = preview.minimumDurationSeconds ?? 0;
  pace.textContent =
    seconds === 0
      ? `글 사이 최소 간격은 ${safety.minIntervalSeconds}초입니다. 선택한 범위의 계산상 최소 소요 시간은 0초입니다.`
      : `글 사이 최소 간격은 ${safety.minIntervalSeconds}초입니다. 네트워크·AI·사용자 확인 시간을 제외한 계산상 최소 소요 시간은 약 ${seconds}초입니다.`;
  section.append(pace);
  return section;
}

function safetyBlockerLabel(safety: SafetyStatus): string {
  const labels: Record<string, string> = {
    consecutive_failures: "연속 실패 보호 때문에 지금은 일괄 처리를 시작할 수 없습니다.",
    daily_cap_reached: "오늘의 안전 한도에 도달했습니다.",
    outside_allowed_hours: "허용한 자동화 시간대가 아닙니다.",
  };
  return labels[safety.blockingReason ?? ""] ?? "현재 안전 정책상 일괄 처리를 시작할 수 없습니다.";
}

function renderDetail(
  document: Document,
  state: TodayState,
  handlers: TodayHandlers,
): Element | null {
  const post = selectedPost(state);
  if (post === null) return null;
  const section = document.createElement("section");
  section.className = "detail-panel";
  section.dataset.detailOpen = String(state.detailOpen);
  const close = button(document, "close-detail-sheet", "상세 닫기", handlers.onCloseDetail);
  close.className = "detail-sheet-close";
  section.append(close);
  const heading = document.createElement("h2");
  heading.id = "detail-title";
  heading.textContent = post.title;
  section.append(heading);

  const badges = document.createElement("ul");
  badges.className = "detail-badges";
  const sourceBadge = document.createElement("li");
  sourceBadge.dataset.badge = "source";
  sourceBadge.textContent = `출처 · ${SOURCE_LABELS[post.source]}`;
  const stateBadge = document.createElement("li");
  stateBadge.dataset.badge = "status";
  stateBadge.textContent = `상태 · ${queueStateLabel(post.state)}`;
  badges.append(sourceBadge, stateBadge);
  section.append(badges);

  const list = document.createElement("dl");
  appendTerm(document, list, "작성자", post.publisherName ?? post.publisherBlogId ?? "확인 필요");
  appendTerm(document, list, "탐색 맥락", post.sourceLabel ?? "확인 필요");
  appendTerm(document, list, "게시일", formatQueueDate(post.publishedAt ?? post.createdAt));
  section.append(list);

  const link = document.createElement("a");
  link.className = "detail-link";
  link.href = post.sourceUrl;
  link.rel = "noreferrer noopener";
  link.target = "_blank";
  link.textContent = "원문 주소 열기";

  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const open = Button(document, {
    id: "open-post-button",
    label: "이 글 처리하기",
    variant: "primary",
    onClick: () => handlers.onOpenPost(post.id),
  });
  open.disabled = state.phase === "loading" || !canOpenSelected(state);
  const stateAction = Button(document, {
    id: "skip-post-button",
    label: post.state === "skipped" ? "다시 대기" : "이 글 건너뛰기",
    variant: "secondary",
    onClick: () =>
      handlers.onPostStateChange(post.id, post.state === "skipped" ? "queued" : "skipped"),
  });
  // Queue filters/segments re-fetch the selected post asynchronously. Keep the action disabled
  // while that refresh is in flight so a fast follow-up click cannot be silently discarded by the
  // controller's request guard.
  stateAction.disabled = state.phase === "loading";
  link.classList.add("detail-tertiary-action");
  actions.append(open, stateAction, link);
  section.append(actions);

  if (open.disabled) {
    const hint = document.createElement("p");
    hint.className = "detail-hint";
    hint.textContent = detailDisabledHint(state);
    section.append(hint);
  }
  return section;
}

function detailDisabledHint(state: TodayState): string {
  if (state.phase === "loading") return "브라우저와 로그인 상태를 확인하는 중입니다.";
  if (state.session?.state !== "ready") {
    return "자동화 브라우저를 시작하고 네이버에 로그인한 뒤 이 글을 처리할 수 있습니다.";
  }
  if (state.session.login !== "authenticated") {
    return "PC 자동화 브라우저에서 네이버에 로그인한 뒤 이 글을 처리할 수 있습니다.";
  }
  return "현재 연결 상태에서는 이 글을 처리할 수 없습니다.";
}

function blockerLabel(blocker: string): string {
  const labels: Record<string, string> = {
    web_app_assets_missing: "웹앱 파일이 없습니다. PC에서 client build를 실행하세요.",
    browser_not_running: "PC 자동화 브라우저를 시작해야 합니다.",
    naver_login_required: "PC 자동화 브라우저에서 네이버 로그인 상태를 확인해야 합니다.",
    own_blog_id_missing: "내 블로그 ID가 필요합니다.",
    llm_provider_missing: "사용 가능한 AI provider를 환경에 설정해야 합니다.",
    automation_consent_missing: "자동 실행 동의가 필요합니다.",
    safety_policy_missing: "자동 실행 안전 정책을 확인해야 합니다.",
  };
  return labels[blocker] ?? blocker;
}

function settingsSectionForBlocker(blocker: string): SettingsSection | undefined {
  if (
    blocker === "own_blog_id_missing" ||
    blocker === "automation_consent_missing" ||
    blocker === "safety_policy_missing"
  ) {
    return "automation";
  }
  if (blocker === "llm_provider_missing") return "connections";
  return undefined;
}

function appendTerm(document: Document, list: Element, term: string, value: string): void {
  const name = document.createElement("dt");
  name.textContent = term;
  const description = document.createElement("dd");
  description.textContent = value;
  list.append(name, description);
}

function heading(document: Document, text: string): HTMLHeadingElement {
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
