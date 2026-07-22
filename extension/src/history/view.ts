import type { RecommendationHistoryItem } from "../api/types";
import type { HistoryActions, HistoryState, HistoryView } from "./state";

function requireElement<T extends Element>(document: Document, selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing history element: ${selector}`);
  return element;
}

export class DomHistoryView implements HistoryView {
  readonly #document: Document;
  readonly #empty: HTMLElement;
  readonly #fallback: HTMLTextAreaElement;
  readonly #list: HTMLElement;
  readonly #notice: HTMLElement;
  readonly #refresh: HTMLButtonElement;
  readonly #service: HTMLElement;
  readonly #summaryCount: HTMLElement;

  constructor(document: Document) {
    this.#document = document;
    this.#empty = requireElement(document, "#history-empty");
    this.#fallback = requireElement(document, "#history-copy-fallback");
    this.#list = requireElement(document, "#history-list");
    this.#notice = requireElement(document, "#history-notice");
    this.#refresh = requireElement(document, "#history-refresh-button");
    this.#service = requireElement(document, "#service-status");
    this.#summaryCount = requireElement(document, "#history-count");
  }

  bind(actions: HistoryActions): void {
    this.#refresh.addEventListener("click", actions.refresh);
    this.#list.addEventListener("click", (event) => {
      const Button = this.#document.defaultView?.HTMLButtonElement;
      const target = event.target;
      if (Button === undefined || !(target instanceof Button)) return;
      const id = target.dataset.historyId;
      if (id === undefined) return;
      if (target.dataset.historyAction === "copy") actions.copy(id);
      if (
        target.dataset.historyAction === "delete" &&
        this.#document.defaultView?.confirm(
          "이 추천 기록과 retry metadata를 이 기기에서 삭제할까요? 삭제 후에는 복구할 수 없습니다.",
        ) === true
      ) {
        actions.delete(id);
      }
    });
  }

  async copyText(value: string): Promise<boolean> {
    try {
      const clipboard = this.#document.defaultView?.navigator.clipboard;
      if (clipboard === undefined) throw new Error("Clipboard API unavailable");
      await clipboard.writeText(value);
      this.#fallback.hidden = true;
      this.#fallback.value = "";
      return true;
    } catch {
      this.#fallback.hidden = false;
      this.#fallback.value = value;
      this.#fallback.focus();
      this.#fallback.select();
      return false;
    }
  }

  render(state: HistoryState): void {
    this.#list.replaceChildren();
    this.#notice.hidden = true;
    this.#refresh.disabled = state.kind === "loading";
    if (state.kind === "loading") {
      this.#fallback.hidden = true;
      this.#fallback.value = "";
      this.#service.textContent = "로컬 서비스 확인 중";
      this.#service.dataset.status = "checking";
      this.#summaryCount.textContent = "";
      this.#empty.hidden = false;
      this.#empty.textContent = "최근 작업을 불러오고 있습니다.";
      return;
    }
    if (state.kind === "error") {
      this.#fallback.hidden = true;
      this.#fallback.value = "";
      this.#service.textContent = "로컬 서비스 연결 안 됨";
      this.#service.dataset.status = "error";
      this.#summaryCount.textContent = "";
      this.#empty.hidden = false;
      this.#empty.textContent = state.message;
      return;
    }

    this.#service.textContent =
      state.service.generatorMode === "openai"
        ? `연결됨 · ${state.service.generatorModel}`
        : "연결됨 · test generator";
    this.#service.dataset.status = "ready";
    this.#summaryCount.textContent = state.items.length > 0 ? `${state.items.length}` : "";
    this.#empty.hidden = state.items.length > 0;
    this.#empty.textContent = "아직 저장된 추천 작업이 없습니다.";
    this.#list.replaceChildren(...state.items.map((item) => this.#historyItem(item, state.busyId)));
    this.#notice.hidden = state.notice === undefined;
    this.#notice.textContent = state.notice ?? "";
  }

  #historyItem(item: RecommendationHistoryItem, busyId: string | undefined): HTMLElement {
    const row = this.#document.createElement("li");
    row.className = "history-item";
    const heading = this.#document.createElement("div");
    heading.className = "history-item-heading";
    const link = this.#document.createElement("a");
    link.href = item.sourceUrl;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    link.textContent = item.title;
    const meta = this.#document.createElement("small");
    meta.textContent = `${statusLabel(item.reviewStatus)} · ${formatDate(item.updatedAt ?? item.createdAt)}`;
    heading.append(link, meta);
    row.append(heading);
    if (item.comment !== null) {
      const comment = this.#document.createElement("p");
      comment.textContent = item.comment;
      row.append(comment);
    }
    const actions = this.#document.createElement("div");
    actions.className = "history-actions";
    if (item.comment !== null) actions.append(this.#button("댓글 복사", "copy", item.id, false));
    actions.append(this.#button("기록 삭제", "delete", item.id, busyId === item.id));
    row.append(actions);
    return row;
  }

  #button(label: string, action: string, id: string, disabled: boolean): HTMLButtonElement {
    const button = this.#document.createElement("button");
    button.className = action === "delete" ? "text-button danger-text" : "text-button";
    button.dataset.historyAction = action;
    button.dataset.historyId = id;
    button.disabled = disabled;
    button.type = "button";
    button.textContent = disabled ? "삭제 중…" : label;
    return button;
  }
}

function statusLabel(status: string): string {
  return { approved: "승인됨", completed: "완료", drafted: "검토 전" }[status] ?? status;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
