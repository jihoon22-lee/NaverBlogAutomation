/** A compact, local-only recent-work screen. */

import type { RecommendationHistoryItem } from "../api/types";
import type { ActivityState } from "../controllers/activity";

export interface ActivityHandlers {
  onClearExamples(): void;
  onDeleteRecommendation(id: string): void;
  onOpenDraft(id: string): void;
  onOpenRecommendation(id: string): void;
  onOpenSession(id: string): void;
  onRefresh(): void;
  onTogglePersonalization(item: RecommendationHistoryItem): void;
}

export function renderActivity(
  root: Element,
  state: ActivityState,
  handlers: ActivityHandlers,
): void {
  const document = root.ownerDocument;
  root.textContent = "";
  const status = document.createElement("p");
  status.id = "workspace-status";
  status.setAttribute("role", "status");
  status.textContent =
    state.error ?? state.notice ?? (state.loading ? "최근 작업을 불러오는 중입니다." : "최근 작업");
  root.append(status);
  const refresh = button(document, "refresh-activity-button", "새로고침", handlers.onRefresh);
  refresh.disabled = state.loading;
  root.append(refresh);
  root.append(
    recommendations(document, state, handlers),
    sessions(document, state, handlers),
    drafts(document, state, handlers),
  );
}

function recommendations(
  document: Document,
  state: ActivityState,
  handlers: ActivityHandlers,
): Element {
  const section = panel(document, "최근 댓글 작업");
  const clear = button(
    document,
    "clear-personalization-button",
    "개인화 예시 모두 지우기",
    handlers.onClearExamples,
  );
  clear.disabled = state.loading;
  section.append(clear);
  if (state.recommendations.length === 0)
    return appendEmpty(document, section, "아직 저장된 댓글 작업이 없습니다.");
  const list = document.createElement("ul");
  for (const item of state.recommendations) {
    const row = document.createElement("li");
    row.textContent = `${item.title} · ${item.reviewStatus} · ${item.updatedAt ?? item.createdAt}`;
    if (item.comment !== null) {
      const comment = document.createElement("p");
      comment.textContent = item.comment;
      row.append(comment);
    }
    const personalize = button(
      document,
      `personalization-${item.id}`,
      item.personalizationEligible ? "개인화 예시에서 제외" : "개인화 예시에 포함",
      () => handlers.onTogglePersonalization(item),
    );
    const remove = button(document, `delete-recommendation-${item.id}`, "추천 삭제", () =>
      handlers.onDeleteRecommendation(item.id),
    );
    const open = button(document, `open-recommendation-${item.id}`, "댓글 다시 보기", () =>
      handlers.onOpenRecommendation(item.id),
    );
    row.append(open, personalize, remove);
    list.append(row);
  }
  section.append(list);
  return section;
}

function sessions(document: Document, state: ActivityState, handlers: ActivityHandlers): Element {
  const section = panel(document, "여러 글 처리 이력");
  if (state.sessions.length === 0)
    return appendEmpty(document, section, "실행한 여러 글 작업이 없습니다.");
  const list = document.createElement("ul");
  for (const session of state.sessions) {
    const item = document.createElement("li");
    item.textContent = `${session.state} · ${session.createdAt}`;
    item.append(
      document.createTextNode(" "),
      button(document, `open-session-${session.id}`, "작업 다시 보기", () =>
        handlers.onOpenSession(session.id),
      ),
    );
    list.append(item);
  }
  section.append(list);
  return section;
}

function drafts(document: Document, state: ActivityState, handlers: ActivityHandlers): Element {
  const section = panel(document, "글 작성 이력");
  if (state.drafts.length === 0)
    return appendEmpty(document, section, "저장한 글 초안이 없습니다.");
  const list = document.createElement("ul");
  for (const draft of state.drafts) {
    const item = document.createElement("li");
    item.textContent = `${draft.title} · ${draft.status} · ${draft.updatedAt ?? "저장 시각 없음"}`;
    item.append(
      document.createTextNode(" "),
      button(document, `open-draft-${draft.id}`, "초안 다시 열기", () =>
        handlers.onOpenDraft(draft.id),
      ),
    );
    list.append(item);
  }
  section.append(list);
  return section;
}

function panel(document: Document, title: string): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = title;
  section.append(heading);
  return section;
}

function appendEmpty(document: Document, section: Element, text: string): Element {
  const empty = document.createElement("p");
  empty.textContent = text;
  section.append(empty);
  return section;
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
