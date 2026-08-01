/**
 * Today view.
 *
 * The wide layout shows the queue list and the selected post's detail at the same time, which the
 * narrow extension panel could not do. Rendering is a pure function of state so the tests can assert the
 * DOM without a running service.
 */

import type { BrowserSession, DiscoveryPost } from "../api/types";
import { type TodayState, canOpenSelected, queueCounts, selectedPost } from "../state/today";

export interface TodayHandlers {
  onCloseSession(): void;
  onFocusSession(): void;
  onLaunchSession(): void;
  onOpenPost(postId: string): void;
  onRefresh(): void;
  onSelectPost(postId: string): void;
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

  if (state.phase === "failed") return;

  const layout = document.createElement("div");
  layout.className = "today-layout";
  layout.append(renderQueue(document, state, handlers));
  const detail = renderDetail(document, state, handlers);
  if (detail !== null) layout.append(detail);
  root.append(layout);
}

function statusMessage(state: TodayState): string {
  if (state.phase === "loading") return "오늘의 작업을 불러오는 중입니다.";
  if (state.phase === "failed") return state.error ?? "오늘의 작업을 불러오지 못했습니다.";
  if (state.phase === "idle") return "로컬 서비스에 연결하는 중입니다.";
  const counts = queueCounts(state.posts);
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

function renderQueue(document: Document, state: TodayState, handlers: TodayHandlers): Element {
  const section = document.createElement("section");
  section.className = "queue-panel";
  const heading = document.createElement("h2");
  heading.textContent = "글 탐색 대기열";
  section.append(heading);

  if (state.posts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "queue-empty";
    empty.textContent = "대기 중인 글이 없습니다.";
    section.append(empty);
    return section;
  }

  const list = document.createElement("ul");
  list.className = "queue-list";
  for (const post of state.posts) {
    const item = document.createElement("li");
    const select = document.createElement("button");
    select.type = "button";
    select.className = "queue-item";
    select.dataset.postId = post.id;
    select.setAttribute("aria-pressed", String(post.id === state.selectedPostId));
    select.textContent = `${SOURCE_LABELS[post.source]} · ${post.title}`;
    select.addEventListener("click", () => handlers.onSelectPost(post.id));
    item.append(select);
    list.append(item);
  }
  section.append(list);
  return section;
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

  if (open.disabled) {
    const hint = document.createElement("p");
    hint.className = "detail-hint";
    hint.textContent = "브라우저를 시작하고 네이버에 로그인한 뒤 처리할 수 있습니다.";
    section.append(hint);
  }
  return section;
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
