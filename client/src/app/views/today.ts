/**
 * Today view.
 *
 * The wide layout shows the queue list and the selected post's detail at the same time, which the
 * narrow extension panel could not do. Rendering is a pure function of state so the tests can assert the
 * DOM without a running service.
 */

import type {
  BrowserSession,
  DiscoveryPost,
  DiscoveryState,
  EngagementStepName,
  SafetyStatus,
} from "../api/types";
import {
  type TodayState,
  batchPreflight,
  canContinueBatchPreflight,
  canOpenSelected,
  selectedPost,
  visiblePosts,
} from "../state/today";

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
  onOpenBatch(): void;
  onOpenSettings(): void;
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

  root.append(renderServicePanel(document, state, handlers));
  root.append(renderOnboarding(document, state, handlers));

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
    state.phase === "loading"
      ? "홈 준비 상태를 불러오는 중입니다."
      : state.phase === "failed"
        ? (state.error ?? "홈 준비 상태를 불러오지 못했습니다.")
        : "오늘의 블로그 작업을 준비했습니다.";
  root.append(status);

  const summary = document.createElement("section");
  summary.className = "home-summary-panel";
  summary.append(heading(document, "오늘의 수집 요약"));
  const counts = state.counts;
  const description = document.createElement("p");
  description.textContent =
    counts.total === 0
      ? "아직 처리할 글이 없습니다. 탐색 설정을 확인하거나 새로 수집하세요."
      : `처리 대기 ${counts.total}건 · 이웃 새 글 ${counts.neighbor}건 · 신규 이웃 후보 ${counts.search}건`;
  summary.append(description);
  const open = button(document, "home-open-workbench", "작업함 열기", handlers.onOpenWorkbench);
  open.disabled = state.phase === "loading";
  summary.append(open);
  root.append(summary);

  const readiness = document.createElement("section");
  readiness.className = "home-readiness-panel";
  readiness.append(heading(document, "시작 준비"));
  if (state.readiness === null) {
    const loading = document.createElement("p");
    loading.textContent = "AI, 브라우저, 네이버 로그인 상태를 확인하는 중입니다.";
    readiness.append(loading);
  } else if (state.readiness.blockers.length === 0) {
    const complete = document.createElement("p");
    complete.textContent = "댓글 생성과 자동화 작업을 시작할 준비가 되었습니다.";
    readiness.append(complete);
  } else {
    const list = document.createElement("ul");
    for (const blocker of state.readiness.blockers) {
      const item = document.createElement("li");
      item.textContent = blockerLabel(blocker);
      if (blocker === "browser_not_running") {
        item.append(document.createTextNode(" "));
        item.append(
          button(document, "home-launch-browser", "브라우저 시작", handlers.onLaunchSession),
        );
      } else if (blocker === "naver_login_required") {
        item.append(document.createTextNode(" "));
        item.append(
          button(document, "home-focus-browser", "PC 브라우저 열기", handlers.onFocusSession),
        );
      } else if (blocker !== "web_app_assets_missing") {
        item.append(document.createTextNode(" "));
        item.append(button(document, `home-${blocker}`, "설정 열기", handlers.onOpenSettings));
      }
      list.append(item);
    }
    readiness.append(list);
  }
  root.append(readiness);

  const quick = document.createElement("section");
  quick.className = "home-quick-panel";
  quick.append(heading(document, "빠른 시작"));
  const note = document.createElement("p");
  note.textContent = "글을 고르고 댓글을 작성하거나, 넓은 글쓰기 canvas에서 새 초안을 시작하세요.";
  quick.append(note, button(document, "home-refresh", "준비 상태 새로고침", handlers.onRefresh));
  root.append(quick);
}

function renderDirectUrl(document: Document, handlers: TodayHandlers): Element {
  const section = document.createElement("section");
  section.className = "direct-url-panel";
  const heading = document.createElement("h2");
  heading.textContent = "직접 URL로 댓글 만들기";
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
  section.append(heading, note, label, input, open);
  return section;
}

function statusMessage(state: TodayState): string {
  if (state.phase === "loading") return "오늘의 작업을 불러오는 중입니다.";
  if (state.phase === "failed") return state.error ?? "오늘의 작업을 불러오지 못했습니다.";
  if (state.phase === "idle") return "로컬 서비스에 연결하는 중입니다.";
  const counts = state.counts;
  return counts.total === 0
    ? "대기열이 비어 있습니다. 설정에서 자동 탐색을 확인하세요."
    : `대기 중인 글 ${counts.total}건 (이웃 ${counts.neighbor}, 검색 ${counts.search})`;
}

function renderServicePanel(
  document: Document,
  state: TodayState,
  handlers: TodayHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "service-panel";
  const heading = document.createElement("h2");
  heading.textContent = "로컬 서비스";
  section.append(heading);

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
  section.append(list);

  if (state.session?.detail != null) {
    const detail = document.createElement("p");
    detail.className = "session-detail";
    detail.textContent = state.session.detail;
    section.append(detail);
  }

  const actions = document.createElement("div");
  actions.className = "service-actions";
  const refresh = button(document, "refresh-button", "새로고침", handlers.onRefresh);
  refresh.disabled = state.phase === "loading";
  actions.append(refresh);
  if (state.session?.state === "ready") {
    actions.append(
      button(document, "focus-session-button", "브라우저 창 보이기", handlers.onFocusSession),
    );
    actions.append(
      button(document, "close-session-button", "브라우저 종료", handlers.onCloseSession),
    );
  } else {
    const launch = button(
      document,
      "launch-session-button",
      "브라우저 시작",
      handlers.onLaunchSession,
    );
    if (state.session?.state === "launching" || state.session?.state === "closing") {
      launch.disabled = true;
    }
    actions.append(launch);
  }
  section.append(actions);
  return section;
}

function renderOnboarding(document: Document, state: TodayState, handlers: TodayHandlers): Element {
  const section = document.createElement("section");
  section.className = "onboarding-panel";
  const heading = document.createElement("h2");
  heading.textContent = "시작 준비";
  section.append(heading);
  const readiness = state.readiness;
  if (readiness === null) {
    const loading = document.createElement("p");
    loading.textContent = "필수 조건을 확인하는 중입니다.";
    section.append(loading);
    return section;
  }
  if (readiness.blockers.length === 0) {
    const complete = document.createElement("p");
    complete.textContent = "댓글 생성과 자동 실행을 시작할 준비가 되었습니다.";
    section.append(complete);
    return section;
  }
  const list = document.createElement("ul");
  for (const blocker of readiness.blockers) {
    const item = document.createElement("li");
    item.textContent = blockerLabel(blocker);
    if (blocker === "browser_not_running") {
      item.append(document.createTextNode(" "));
      item.append(
        button(document, "onboarding-launch-browser", "브라우저 시작", handlers.onLaunchSession),
      );
    } else if (blocker === "naver_login_required") {
      item.append(document.createTextNode(" "));
      item.append(
        button(document, "onboarding-focus-browser", "PC 브라우저 열기", handlers.onFocusSession),
      );
    } else if (blocker !== "web_app_assets_missing") {
      item.append(document.createTextNode(" "));
      item.append(button(document, `onboarding-${blocker}`, "설정 열기", handlers.onOpenSettings));
    }
    list.append(item);
  }
  section.append(list);
  if (state.nextCursor !== null) {
    section.append(button(document, "load-more-queue-button", "더 불러오기", handlers.onLoadMore));
  }
  return section;
}

function renderQueue(document: Document, state: TodayState, handlers: TodayHandlers): Element {
  const section = document.createElement("section");
  section.className = "queue-panel";
  const heading = document.createElement("h2");
  heading.textContent = "작업함";
  section.append(heading);

  section.append(renderSegments(document, state, handlers));
  section.append(renderFilters(document, state, handlers));

  const posts = visiblePosts(state);
  if (posts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "queue-empty";
    empty.textContent = "대기 중인 글이 없습니다.";
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
    select.className = "queue-item";
    select.dataset.postId = post.id;
    select.setAttribute("aria-pressed", String(post.id === state.selectedPostId));
    const context = post.sourceLabel ?? post.publisherName ?? post.publisherBlogId ?? "확인 필요";
    const when = post.publishedAt ?? post.createdAt;
    select.textContent = `${SOURCE_LABELS[post.source]} · ${context} · ${post.title} · ${when}`;
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

function renderSegments(document: Document, state: TodayState, handlers: TodayHandlers): Element {
  const panel = document.createElement("div");
  panel.className = "queue-segments";
  const selected =
    state.stateFilter === "skipped"
      ? "skipped"
      : state.sourceFilter === "search"
        ? "search"
        : "neighbor";
  for (const [segment, label, count] of [
    ["neighbor", "이웃 새 글", state.counts.neighbor],
    ["search", "새 이웃 후보", state.counts.search],
    ["skipped", "보류됨", state.counts.skipped],
  ] as const) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "queue-segment";
    choice.dataset.segment = segment;
    choice.setAttribute("aria-pressed", String(selected === segment));
    choice.textContent = `${label} ${count}`;
    choice.addEventListener("click", () => handlers.onSegmentChange(segment));
    panel.append(choice);
  }
  return panel;
}

function renderFilters(document: Document, state: TodayState, handlers: TodayHandlers): Element {
  const panel = document.createElement("div");
  panel.className = "queue-filters";
  const query = document.createElement("input");
  query.id = "queue-query";
  query.type = "search";
  query.placeholder = "제목, 작성자, 검색어 검색";
  query.value = state.query;
  query.addEventListener("change", () => handlers.onQueryChange(query.value));
  panel.append(query);

  const source = document.createElement("select");
  source.id = "queue-source-filter";
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
  source.addEventListener("change", () => handlers.onFilterChange("source", source.value));
  const status = document.createElement("select");
  status.id = "queue-state-filter";
  for (const [value, label] of [
    ["all", "모든 상태"],
    ["queued", "대기"],
    ["opened", "열어봄"],
    ["skipped", "건너뜀"],
  ]) {
    const option = document.createElement("option");
    option.value = value ?? "";
    option.textContent = label ?? "";
    option.selected = state.stateFilter === value;
    status.append(option);
  }
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
  sort.addEventListener("change", () => handlers.onSortChange(sort.value as "newest" | "oldest"));
  panel.append(source, status, sort);
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
  const heading = document.createElement("h2");
  heading.id = "detail-title";
  heading.textContent = post.title;
  section.append(heading);

  const list = document.createElement("dl");
  appendTerm(document, list, "출처", SOURCE_LABELS[post.source]);
  appendTerm(document, list, "탐색 맥락", post.sourceLabel ?? "확인 필요");
  appendTerm(document, list, "게시 시각", post.publishedAt ?? post.createdAt);
  appendTerm(document, list, "작성자", post.publisherName ?? post.publisherBlogId ?? "확인 필요");
  appendTerm(document, list, "상태", post.state);
  section.append(list);

  const link = document.createElement("a");
  link.className = "detail-link";
  link.href = post.sourceUrl;
  link.rel = "noreferrer noopener";
  link.target = "_blank";
  link.textContent = "원문 주소 열기";
  section.append(link);

  const open = button(document, "open-post-button", "이 글 처리하기", () =>
    handlers.onOpenPost(post.id),
  );
  open.disabled = !canOpenSelected(state);
  section.append(open);

  const stateAction = button(
    document,
    "skip-post-button",
    post.state === "skipped" ? "다시 대기" : "이 글 건너뛰기",
    () => handlers.onPostStateChange(post.id, post.state === "skipped" ? "queued" : "skipped"),
  );
  section.append(stateAction);

  if (open.disabled) {
    const hint = document.createElement("p");
    hint.className = "detail-hint";
    hint.textContent = "브라우저를 시작하고 네이버에 로그인한 뒤 처리할 수 있습니다.";
    section.append(hint);
  }
  return section;
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
