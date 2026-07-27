export const DEFAULT_MUTUAL_NEIGHBOR_MESSAGE =
  "좋은 글 잘 읽었습니다. 서로이웃으로 소통하고 싶어요.";
export const MUTUAL_NEIGHBOR_MESSAGE_STORAGE_KEY = "mutualNeighborMessageV1";
const MAX_MESSAGE_LENGTH = 500;

export interface MessageSettingsStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class MutualNeighborMessageSettings {
  readonly #document: Document;
  readonly #storage: MessageSettingsStorage;
  readonly #form: HTMLFormElement;
  readonly #input: HTMLTextAreaElement;
  readonly #count: HTMLElement;
  readonly #notice: HTMLElement;

  constructor(document: Document, storage: MessageSettingsStorage = chrome.storage.local) {
    this.#document = document;
    this.#storage = storage;
    this.#form = required(document, "#mutual-neighbor-message-form");
    this.#input = required(document, "#mutual-neighbor-default-message");
    this.#count = required(document, "#mutual-neighbor-message-count");
    this.#notice = required(document, "#mutual-neighbor-message-notice");
  }

  async start(): Promise<string> {
    this.#input.addEventListener("input", () => {
      this.#input.value = boundMessage(this.#input.value);
      this.#renderCount();
    });
    this.#form.addEventListener("submit", (event) => void this.#save(event));
    const message = await this.#load();
    this.#input.value = message;
    this.#renderCount();
    return message;
  }

  async #load(): Promise<string> {
    try {
      const raw = (await this.#storage.get(MUTUAL_NEIGHBOR_MESSAGE_STORAGE_KEY))[
        MUTUAL_NEIGHBOR_MESSAGE_STORAGE_KEY
      ];
      return parseStoredMessage(raw) ?? DEFAULT_MUTUAL_NEIGHBOR_MESSAGE;
    } catch {
      this.#showNotice("저장된 신청 메시지를 불러오지 못해 기본 문구를 사용합니다.");
      return DEFAULT_MUTUAL_NEIGHBOR_MESSAGE;
    }
  }

  async #save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const message = boundMessage(this.#input.value).trim();
    if (message.length === 0) {
      this.#showNotice("서로이웃 신청 메시지를 한 글자 이상 입력해 주세요.");
      this.#input.focus();
      return;
    }
    try {
      await this.#storage.set({
        [MUTUAL_NEIGHBOR_MESSAGE_STORAGE_KEY]: {
          message,
          schemaVersion: 1,
        },
      });
      this.#input.value = message;
      this.#renderCount();
      this.#showNotice("다음 신규 이웃 후보부터 사용할 기본 메시지를 저장했습니다.");
      this.#dispatch(message);
    } catch {
      this.#showNotice("신청 메시지를 저장하지 못했습니다. Browser storage를 확인해 주세요.");
    }
  }

  #renderCount(): void {
    this.#count.textContent = `${Array.from(this.#input.value).length.toLocaleString("ko-KR")} / 500자`;
  }

  #showNotice(value: string): void {
    this.#notice.hidden = false;
    this.#notice.textContent = value;
  }

  #dispatch(message: string): void {
    const EventConstructor = this.#document.defaultView?.CustomEvent;
    if (EventConstructor !== undefined) {
      this.#document.defaultView?.dispatchEvent(
        new EventConstructor("mutual-neighbor-message-changed", {
          detail: { message },
        }),
      );
    }
  }
}

function parseStoredMessage(value: unknown): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("message" in value) ||
    typeof value.message !== "string"
  ) {
    return null;
  }
  const message = boundMessage(value.message).trim();
  return message.length > 0 && message === value.message ? message : null;
}

function boundMessage(value: string): string {
  return Array.from(value).slice(0, MAX_MESSAGE_LENGTH).join("");
}

function required<T extends Element>(document: Document, selector: string): T {
  const value = document.querySelector<T>(selector);
  if (value === null) throw new Error(`Missing message settings element: ${selector}`);
  return value;
}
