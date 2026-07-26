import { LocalApiClient } from "../api/client";
import type { DiscoveryPost, DiscoverySource } from "../api/types";
import type { ChromeDiscoveryPageGateway } from "../browser/discovery-page-gateway";

type QueueTab = DiscoverySource;

export class DiscoveryController {
  readonly #api: LocalApiClient;
  readonly #gateway: ChromeDiscoveryPageGateway;
  readonly #document: Document;
  #tab: QueueTab = "neighbor";

  constructor(document: Document, gateway: ChromeDiscoveryPageGateway, api = new LocalApiClient()) {
    this.#document = document;
    this.#gateway = gateway;
    this.#api = api;
  }

  start(): void {
    this.#button("discovery-refresh-button").addEventListener(
      "click",
      () => void this.refreshNeighbors(),
    );
    this.#button("import-neighbors-button").addEventListener(
      "click",
      () => void this.importNeighbors(),
    );
    this.#button("discovery-neighbor-tab").addEventListener(
      "click",
      () => void this.selectTab("neighbor"),
    );
    this.#button("discovery-search-tab").addEventListener(
      "click",
      () => void this.selectTab("search"),
    );
    this.#form("discovery-neighbor-form").addEventListener(
      "submit",
      (event) => void this.saveNeighbor(event),
    );
    this.#form("discovery-search-form").addEventListener(
      "submit",
      (event) => void this.saveSearch(event),
    );
    this.#form("discovery-digest-form").addEventListener(
      "submit",
      (event) => void this.saveDigestSettings(event),
    );
    this.#element("discovery-searches").addEventListener(
      "click",
      (event) => void this.importSearch(event),
    );
    this.#element("discovery-queue").addEventListener(
      "click",
      (event) => void this.queueAction(event),
    );
    void this.render();
  }

  private async render(): Promise<void> {
    try {
      const [neighbors, searches, posts, digest] = await Promise.all([
        this.#api.listDiscoveryNeighbors(),
        this.#api.listDiscoverySearches(),
        this.#api.listDiscoveryQueue(this.#tab),
        this.#api.digestSettings(),
      ]);
      this.#renderNeighbors(neighbors);
      this.#renderSearches(searches);
      this.#renderQueue(posts);
      this.#renderDigestSettings(digest);
      this.#notice("이웃 새 글과 검색 후보를 직접 확인해 열 수 있습니다.");
    } catch (error) {
      this.#notice(error instanceof Error ? error.message : "탐색 대기열을 불러오지 못했습니다.");
    }
  }

  private async selectTab(tab: QueueTab): Promise<void> {
    this.#tab = tab;
    this.#button("discovery-neighbor-tab").setAttribute("aria-pressed", String(tab === "neighbor"));
    this.#button("discovery-search-tab").setAttribute("aria-pressed", String(tab === "search"));
    await this.render();
  }

  private async refreshNeighbors(): Promise<void> {
    this.#notice("등록한 이웃의 공개 RSS를 확인하고 있습니다.");
    try {
      const count = await this.#api.refreshDiscoveryNeighbors();
      this.#notice(`${count}개의 새 글을 대기열에 추가했습니다.`);
      await this.render();
    } catch (error) {
      this.#notice(error instanceof Error ? error.message : "이웃 새 글을 갱신하지 못했습니다.");
    }
  }

  private async importNeighbors(): Promise<void> {
    try {
      const capture = await this.#gateway.capture();
      if (!capture.blogs.length)
        return this.#notice("열린 페이지에서 이웃 블로그 주소를 찾지 못했습니다.");
      if (!window.confirm(`${capture.blogs.length}개의 블로그를 이웃 목록에 추가할까요?`)) return;
      await Promise.all(capture.blogs.map((blog) => this.#api.saveDiscoveryNeighbor(blog)));
      this.#notice(`${capture.blogs.length}개의 이웃 블로그를 저장했습니다.`);
      await this.render();
    } catch (error) {
      this.#notice(error instanceof Error ? error.message : "이웃 목록을 가져오지 못했습니다.");
    }
  }

  private async saveNeighbor(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    try {
      await this.#api.saveDiscoveryNeighbor({
        name: stringField(data, "name"),
        blogId: stringField(data, "blog-id"),
        blogUrl: stringField(data, "blog-url"),
      });
      form.reset();
      this.#notice("이웃 블로그를 저장했습니다.");
      await this.render();
    } catch (error) {
      this.#notice(error instanceof Error ? error.message : "이웃 블로그를 저장하지 못했습니다.");
    }
  }

  private async saveSearch(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    try {
      await this.#api.saveDiscoverySearch({
        query: stringField(data, "query"),
        excludedTerms: stringField(data, "excluded-terms")
          .split(",")
          .map((term) => term.trim())
          .filter(Boolean),
        freshnessDays: Number(stringField(data, "freshness-days")),
      });
      form.reset();
      this.#notice("신규 이웃 검색어를 저장했습니다.");
      await this.render();
    } catch (error) {
      this.#notice(error instanceof Error ? error.message : "검색어를 저장하지 못했습니다.");
    }
  }

  private async saveDigestSettings(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    try {
      const settings = await this.#api.saveDigestSettings({
        timezone: stringField(data, "timezone"),
        hour: Number(stringField(data, "hour")),
        minute: Number(stringField(data, "minute")),
        emailEnabled: data.get("email-enabled") === "on",
      });
      this.#renderDigestSettings(settings);
      this.#notice("하루 요약 시간을 저장했습니다.");
    } catch (error) {
      this.#notice(
        error instanceof Error ? error.message : "하루 요약 시간을 저장하지 못했습니다.",
      );
    }
  }

  private async importSearch(event: Event): Promise<void> {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-import-search]");
    if (!button) return;
    try {
      const capture = await this.#gateway.capture();
      if (!capture.posts.length)
        return this.#notice("열린 검색 결과에서 네이버 블로그 글을 찾지 못했습니다.");
      if (!window.confirm(`${capture.posts.length}개 글을 신규 이웃 후보에 추가할까요?`)) return;
      const count = await this.#api.importDiscoveryPosts(
        "search",
        button.dataset.importSearch ?? "",
        capture.posts,
      );
      this.#notice(`${count}개의 신규 이웃 후보를 추가했습니다.`);
      await this.selectTab("search");
    } catch (error) {
      this.#notice(error instanceof Error ? error.message : "검색 결과를 가져오지 못했습니다.");
    }
  }

  private async queueAction(event: Event): Promise<void> {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-post-id]");
    if (!button) return;
    const id = button.dataset.postId ?? "";
    const action = button.dataset.action;
    try {
      if (action === "skip") {
        await this.#api.updateDiscoveryPostState(id, "skipped");
        this.#notice("대기열에서 건너뛰었습니다.");
        await this.render();
        return;
      }
      const post = button.closest<HTMLLIElement>("li")?.dataset.url;
      if (!post) return;
      await this.#api.updateDiscoveryPostState(id, "opened");
      await chrome.tabs.update({ url: post });
      window.dispatchEvent(new Event("discovery-open-post"));
    } catch (error) {
      this.#notice(error instanceof Error ? error.message : "글을 열지 못했습니다.");
    }
  }

  #renderNeighbors(items: readonly { name: string; feedStatus: string }[]): void {
    this.#element("discovery-neighbors").replaceChildren(
      ...items.map((item) => listItem(`${item.name} · RSS ${item.feedStatus}`)),
    );
  }

  #renderSearches(items: readonly { id: string; query: string; freshnessDays: number }[]): void {
    this.#element("discovery-searches").replaceChildren(
      ...items.map((item) => {
        const row = listItem(`${item.query} · 최근 ${item.freshnessDays}일`);
        const button = document.createElement("button");
        button.className = "text-button";
        button.type = "button";
        button.dataset.importSearch = item.id;
        button.textContent = "현재 검색 결과 가져오기";
        row.append(button);
        return row;
      }),
    );
  }

  #renderQueue(items: readonly DiscoveryPost[]): void {
    const queue = this.#element("discovery-queue");
    const empty = this.#element("discovery-empty");
    empty.hidden = items.length > 0;
    queue.replaceChildren(
      ...items.map((item) => {
        const row = document.createElement("li");
        row.className = "discovery-item";
        row.dataset.url = item.sourceUrl;
        const title = document.createElement("p");
        title.textContent = item.title;
        row.append(title);
        const meta = document.createElement("small");
        meta.textContent = [
          item.publisherName,
          item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : "게시일 미상",
        ]
          .filter(Boolean)
          .join(" · ");
        row.append(meta);
        const actions = document.createElement("div");
        actions.className = "actions";
        actions.append(
          queueButton(item.id, "open", "이 글 열기"),
          queueButton(item.id, "skip", "건너뛰기"),
        );
        row.append(actions);
        return row;
      }),
    );
  }

  #renderDigestSettings(settings: {
    timezone: string;
    hour: number;
    minute: number;
    emailEnabled: boolean;
    smtpConfigured: boolean;
  }): void {
    const form = this.#form("discovery-digest-form");
    (form.elements.namedItem("timezone") as HTMLInputElement).value = settings.timezone;
    (form.elements.namedItem("hour") as HTMLInputElement).value = String(settings.hour);
    (form.elements.namedItem("minute") as HTMLInputElement).value = String(settings.minute);
    (form.elements.namedItem("email-enabled") as HTMLInputElement).checked = settings.emailEnabled;
    this.#element("discovery-smtp-status").textContent = settings.smtpConfigured
      ? "SMTP 이메일 전송 설정이 준비되었습니다."
      : "이메일은 private env의 SMTP 설정을 모두 입력한 뒤 켤 수 있습니다.";
  }

  #notice(value: string): void {
    this.#element("discovery-notice").textContent = value;
  }
  #element(id: string): HTMLElement {
    const value = this.#document.getElementById(id);
    if (!value) throw new Error(`${id} 요소를 찾지 못했습니다.`);
    return value;
  }
  #button(id: string): HTMLButtonElement {
    const value = this.#element(id);
    if (!(value instanceof HTMLButtonElement)) throw new Error(`${id} 버튼을 찾지 못했습니다.`);
    return value;
  }
  #form(id: string): HTMLFormElement {
    const value = this.#element(id);
    if (!(value instanceof HTMLFormElement)) throw new Error(`${id} 폼을 찾지 못했습니다.`);
    return value;
  }
}

function listItem(text: string): HTMLLIElement {
  const item = document.createElement("li");
  item.textContent = text;
  return item;
}
function queueButton(id: string, action: "open" | "skip", text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button";
  button.dataset.postId = id;
  button.dataset.action = action;
  button.textContent = text;
  return button;
}
function stringField(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}
