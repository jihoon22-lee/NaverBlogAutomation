import { PREVIEW_CODE_POINTS, boundCodePoints } from "../extraction/normalize";
import type { CaptureFailureCode } from "../extraction/types";
import type { PanelState, PanelView } from "./state";

const FAILURE_MESSAGES: Record<CaptureFailureCode, string> = {
  empty_article: "본문 영역을 찾지 못했습니다. 페이지 로딩을 확인한 뒤 다시 시도해 주세요.",
  extraction_failed: "페이지 구조가 예상과 달라 본문을 확인하지 못했습니다.",
  no_active_tab: "현재 활성화된 탭을 찾지 못했습니다.",
  permission_denied:
    "이 페이지를 읽을 권한이 없습니다. 네이버 블로그 탭에서 확장 아이콘을 다시 눌러 주세요.",
  short_article: "추출된 본문이 너무 짧습니다. 글이 완전히 로드되었는지 확인해 주세요.",
  stale_page:
    "탭 또는 페이지가 변경되었습니다. 현재 네이버 블로그 탭에서 확장 아이콘을 다시 눌러 주세요.",
  unsupported_url: "지원되는 HTTPS 네이버 블로그 글에서만 본문을 읽을 수 있습니다.",
};

function requireElement<T extends Element>(document: Document, selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing Side Panel element: ${selector}`);
  }
  return element;
}

export class DomPanelView implements PanelView {
  readonly #app: HTMLElement;
  readonly #bodyPreview: HTMLElement;
  readonly #characterCount: HTMLElement;
  readonly #document: Document;
  readonly #errorMessage: HTMLElement;
  readonly #errorPanel: HTMLElement;
  readonly #errorTitle: HTMLElement;
  readonly #postTitle: HTMLElement;
  readonly #postUrl: HTMLElement;
  readonly #previewPanel: HTMLElement;
  readonly #previewTitle: HTMLElement;
  readonly #retryButton: HTMLButtonElement;
  readonly #status: HTMLElement;
  readonly #truncationNotice: HTMLElement;

  constructor(document: Document) {
    this.#document = document;
    this.#app = requireElement(document, "#app");
    this.#bodyPreview = requireElement(document, "#body-preview");
    this.#characterCount = requireElement(document, "#character-count");
    this.#errorMessage = requireElement(document, "#error-message");
    this.#errorPanel = requireElement(document, "#error-panel");
    this.#errorTitle = requireElement(document, "#error-title");
    this.#postTitle = requireElement(document, "#post-title");
    this.#postUrl = requireElement(document, "#post-url");
    this.#previewPanel = requireElement(document, "#preview-panel");
    this.#previewTitle = requireElement(document, "#preview-title");
    this.#retryButton = requireElement(document, "#retry-button");
    this.#status = requireElement(document, "#status");
    this.#truncationNotice = requireElement(document, "#truncation-notice");
  }

  onRetry(listener: () => void): void {
    this.#retryButton.addEventListener("click", listener);
  }

  render(state: PanelState): void {
    this.#app.setAttribute("aria-busy", String(state.kind === "extracting"));
    this.#errorPanel.hidden = state.kind !== "error";
    this.#previewPanel.hidden = state.kind !== "preview";

    if (state.kind === "extracting") {
      this.#status.textContent = "현재 글의 본문을 확인하고 있습니다.";
      return;
    }
    if (state.kind === "error") {
      this.#status.textContent = "본문 확인이 중단되었습니다.";
      this.#errorMessage.textContent = FAILURE_MESSAGES[state.failure.code];
      this.#focus(this.#errorTitle);
      return;
    }

    const { preview } = state;
    this.#status.textContent = "본문 preview를 확인했습니다. 아직 외부로 전송하지 않았습니다.";
    this.#postTitle.textContent = preview.title;
    this.#postUrl.textContent = preview.sourceUrl;
    this.#characterCount.textContent = preview.truncated
      ? `${preview.transmittedLength.toLocaleString("ko-KR")}자 전송 예정 / ${preview.originalLength.toLocaleString("ko-KR")}자 추출`
      : `${preview.transmittedLength.toLocaleString("ko-KR")}자`;
    const boundedPreview = boundCodePoints(preview.body, PREVIEW_CODE_POINTS);
    this.#bodyPreview.textContent = boundedPreview.truncated
      ? `${boundedPreview.text}\n…`
      : boundedPreview.text;
    this.#truncationNotice.hidden = !preview.truncated;
    this.#truncationNotice.textContent = preview.truncated
      ? `API 제한에 맞춰 앞 ${preview.transmittedLength.toLocaleString("ko-KR")}자만 전송될 예정입니다.`
      : "";
    this.#focus(this.#previewTitle);
  }

  #focus(element: HTMLElement): void {
    this.#document.defaultView?.requestAnimationFrame(() => element.focus());
  }
}
