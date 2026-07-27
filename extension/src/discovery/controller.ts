import { LocalApiClient } from "../api/client";
import type { AutomaticDiscoverySettings, DiscoveryPost, DiscoverySource } from "../api/types";
import {
  ChromeDiscoveryTabNavigator,
  type DiscoveryNavigationTarget,
  type DiscoveryTabNavigator,
} from "../browser/discovery-tab-navigator";

type QueueTab = DiscoverySource;

export class DiscoveryController {
  readonly #api: LocalApiClient;
  readonly #document: Document;
  readonly #navigator: DiscoveryTabNavigator;
  readonly #posts = new Map<string, DiscoveryPost>();
  readonly #queues: Record<QueueTab, readonly DiscoveryPost[]> = {
    neighbor: [],
    search: [],
  };
  #currentPost: DiscoveryPost | null = null;
  #tab: QueueTab = "neighbor";

  constructor(
    document: Document,
    api: LocalApiClient = new LocalApiClient(),
    navigator: DiscoveryTabNavigator = new ChromeDiscoveryTabNavigator(),
  ) {
    this.#document = document;
    this.#api = api;
    this.#navigator = navigator;
  }

  start(): void {
    this.#button("discovery-sync-button").addEventListener("click", () => void this.syncNow());
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
    this.#form("discovery-automation-form").addEventListener(
      "submit",
      (event) => void this.saveAutomaticSettings(event),
    );
    this.#form("discovery-search-form").addEventListener(
      "submit",
      (event) => void this.saveSearch(event),
    );
    this.#form("discovery-digest-form").addEventListener(
      "submit",
      (event) => void this.saveDigestSettings(event),
    );
    this.#element("discovery-queue").addEventListener(
      "click",
      (event) => void this.queueAction(event),
    );
    void this.render();
  }

  private async render(): Promise<void> {
    try {
      const [neighbors, searches, neighborPosts, searchPosts, digest, automation] =
        await Promise.all([
          this.#api.listDiscoveryNeighbors(),
          this.#api.listDiscoverySearches(),
          this.#api.listDiscoveryQueue("neighbor"),
          this.#api.listDiscoveryQueue("search"),
          this.#api.digestSettings(),
          this.#api.automaticDiscoverySettings(),
        ]);
      this.#queues.neighbor = neighborPosts;
      this.#queues.search = searchPosts;
      this.#currentPost ??=
        [...neighborPosts, ...searchPosts].find((post) => post.state === "opened") ?? null;
      this.#renderNeighbors(neighbors);
      this.#renderSearches(searches);
      this.#renderCounts();
      this.#renderQueue(this.#queues[this.#tab]);
      this.#renderCurrentPost();
      this.#renderDigestSettings(digest);
      this.#renderAutomaticSettings(automation);
      this.#notice(
        automation.enabled
          ? "자동 탐색이 설정되었습니다. 필요하면 지금 동기화로 바로 확인할 수 있습니다."
          : "탐색 설정과 알림을 열어 내 블로그 ID를 저장하면 매일 대기열을 갱신할 수 있습니다.",
      );
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

  async openNext(source?: QueueTab): Promise<void> {
    if (source !== undefined) this.#tab = source;
    if (this.#queues[this.#tab].length === 0) await this.render();
    const next = this.#queues[this.#tab].find(
      (post) =>
        post.id !== this.#currentPost?.id &&
        !["completed", "skipped", "unavailable"].includes(post.state),
    );
    if (next === undefined) {
      this.#notice("이 대기열에 다음으로 처리할 글이 없습니다.");
      this.#dispatch("discovery-next-empty", {});
      return;
    }
    await this.#openPost(next, "current");
  }

  private async syncNow(): Promise<void> {
    this.#notice("공개 이웃 목록·RSS·저장한 검색어를 동기화하고 있습니다.");
    try {
      const result = await this.#api.syncAutomaticDiscovery();
      await this.render();
      this.#notice(result.detail);
    } catch (error) {
      this.#notice(error instanceof Error ? error.message : "이웃 새 글을 갱신하지 못했습니다.");
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
      const saved = await this.#api.saveDiscoverySearch({
        query: stringField(data, "query"),
        excludedTerms: stringField(data, "excluded-terms")
          .split(",")
          .map((term) => term.trim())
          .filter(Boolean),
        freshnessDays: Number(stringField(data, "freshness-days")),
      });
      form.reset();
      await this.render();
      try {
        const result = await this.#api.refreshDiscoverySearch(saved.id);
        await this.render();
        this.#notice(result.detail);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "검색 결과를 가져오지 못했습니다.";
        this.#notice(`신규 이웃 검색어를 저장했습니다. ${detail}`);
      }
    } catch (error) {
      this.#notice(error instanceof Error ? error.message : "검색어를 저장하지 못했습니다.");
    }
  }

  private async saveAutomaticSettings(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    try {
      const settings = await this.#api.saveAutomaticDiscoverySettings({
        ownBlogId: stringField(data, "own-blog-id"),
        enabled: data.get("automation-enabled") === "on",
        timezone: stringField(data, "automation-timezone"),
        hour: Number(stringField(data, "automation-hour")),
        minute: Number(stringField(data, "automation-minute")),
      });
      this.#renderAutomaticSettings(settings);
      this.#notice(
        settings.enabled
          ? "자동 탐색을 저장했습니다. 지금 동기화로 첫 결과를 확인해 보세요."
          : "자동 탐색 설정을 저장했습니다.",
      );
    } catch (error) {
      this.#notice(
        error instanceof Error ? error.message : "자동 탐색 설정을 저장하지 못했습니다.",
      );
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

  private async queueAction(event: Event): Promise<void> {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-post-id]");
    if (!button) return;
    const id = button.dataset.postId ?? "";
    const action = button.dataset.action;
    try {
      if (action === "skip") {
        await this.#api.updateDiscoveryPostState(id, "skipped");
        if (this.#currentPost?.id === id) this.#currentPost = null;
        this.#notice("대기열에서 건너뛰었습니다.");
        await this.render();
        return;
      }
      const selected = this.#posts.get(id);
      if (selected === undefined) return;
      const target: DiscoveryNavigationTarget = action === "open-new" ? "new" : "current";
      await this.#openPost(selected, target);
    } catch (error) {
      this.#notice(error instanceof Error ? error.message : "글을 열지 못했습니다.");
    }
  }

  async #openPost(selected: DiscoveryPost, target: DiscoveryNavigationTarget): Promise<void> {
    const tabId = await this.#navigator.open(selected.sourceUrl, target);
    const updated = await this.#api.updateDiscoveryPostState(selected.id, "opened");
    const openedPost = { ...selected, ...updated, state: "opened" as const };
    this.#currentPost = openedPost;
    this.#renderCurrentPost();
    this.#dispatch("discovery-open-post", { post: openedPost, tabId });
  }

  #renderNeighbors(items: readonly { name: string; feedStatus: string }[]): void {
    this.#element("discovery-neighbors").replaceChildren(
      ...items.map((item) => listItem(`${item.name} · RSS ${item.feedStatus}`)),
    );
  }

  #renderSearches(items: readonly { id: string; query: string; freshnessDays: number }[]): void {
    this.#element("discovery-searches").replaceChildren(
      ...items.map((item) =>
        listItem(`${item.query} · 최근 ${item.freshnessDays}일 · 공식 검색 API`),
      ),
    );
  }

  #renderQueue(items: readonly DiscoveryPost[]): void {
    this.#posts.clear();
    for (const item of items) this.#posts.set(item.id, item);
    const queue = this.#element("discovery-queue");
    const empty = this.#element("discovery-empty");
    empty.hidden = items.length > 0;
    queue.replaceChildren(
      ...items.map((item) => {
        const row = this.#document.createElement("li");
        row.className = "discovery-item";
        row.dataset.url = item.sourceUrl;
        const title = this.#document.createElement("p");
        title.textContent = item.title;
        row.append(title);
        const meta = this.#document.createElement("small");
        meta.textContent = [
          item.publisherName,
          item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : "게시일 미상",
        ]
          .filter(Boolean)
          .join(" · ");
        row.append(meta);
        const actions = this.#document.createElement("div");
        actions.className = "actions";
        actions.append(
          queueButton(this.#document, item.id, "open", "이 글 처리하기"),
          queueButton(this.#document, item.id, "open-new", "새 탭에서 처리"),
          queueButton(this.#document, item.id, "skip", "건너뛰기"),
        );
        row.append(actions);
        return row;
      }),
    );
  }

  #renderCounts(): void {
    const neighborCount = this.#queues.neighbor.length;
    const searchCount = this.#queues.search.length;
    for (const id of ["today-neighbor-count", "discovery-neighbor-count"]) {
      this.#element(id).textContent = String(neighborCount);
    }
    for (const id of ["today-search-count", "discovery-search-count"]) {
      this.#element(id).textContent = String(searchCount);
    }
  }

  #renderCurrentPost(): void {
    const card = this.#element("today-current-card");
    card.hidden = this.#currentPost === null;
    this.#element("today-current-post").textContent =
      this.#currentPost === null
        ? ""
        : `${this.#currentPost.source === "search" ? "신규 이웃 후보" : "이웃 새 글"} · ${this.#currentPost.title}`;
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

  #renderAutomaticSettings(settings: AutomaticDiscoverySettings): void {
    const form = this.#form("discovery-automation-form");
    (form.elements.namedItem("own-blog-id") as HTMLInputElement).value = settings.ownBlogId;
    (form.elements.namedItem("automation-enabled") as HTMLInputElement).checked = settings.enabled;
    (form.elements.namedItem("automation-timezone") as HTMLInputElement).value = settings.timezone;
    (form.elements.namedItem("automation-hour") as HTMLInputElement).value = String(settings.hour);
    (form.elements.namedItem("automation-minute") as HTMLInputElement).value = String(
      settings.minute,
    );
    const status = settings.lastSyncedAt
      ? `마지막 동기화 ${new Date(settings.lastSyncedAt).toLocaleString()} · ${settings.lastDetail}`
      : "아직 자동 동기화를 실행하지 않았습니다.";
    this.#element("discovery-automation-status").textContent = status;
  }

  #notice(value: string): void {
    this.#element("discovery-notice").textContent = value;
  }
  #dispatch(name: string, detail: object): void {
    const EventConstructor = this.#document.defaultView?.CustomEvent;
    if (EventConstructor !== undefined) {
      this.#document.defaultView?.dispatchEvent(new EventConstructor(name, { detail }));
    }
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
function queueButton(
  document: Document,
  id: string,
  action: "open" | "open-new" | "skip",
  text: string,
): HTMLButtonElement {
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
