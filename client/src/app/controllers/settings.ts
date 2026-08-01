/**
 * Settings controller for automatic discovery.
 *
 * The README tells people to save their blog id and press "지금 동기화" here, so this screen owns
 * both. Synchronization reports what it added rather than only that it finished, because "성공"
 * with nothing added and "성공" with twelve new posts need different follow-up.
 */

import { ApiError, LocalApiClient } from "../api/client";
import type {
  AutoDiscoverySettings,
  DigestSettings,
  DiscoveryNeighbor,
  DiscoverySearchRefresh,
  DiscoverySyncResult,
  SavedSearch,
} from "../api/types";
import { renderSettings } from "../views/settings";

const REFUSALS: Record<string, string> = {
  own_blog_id_missing: "내 블로그 ID를 먼저 저장하세요.",
  search_provider_unavailable:
    "검색 API key가 설정되지 않아 검색 후보를 가져올 수 없습니다. 이웃 새 글은 계속 수집합니다.",
  discovery_search_not_configured:
    "검색 API key가 설정되지 않았습니다. 설정 후 검색어를 다시 갱신하세요.",
  discovery_search_unavailable:
    "신규 이웃 검색 결과를 가져오지 못했습니다. 잠시 후 다시 시도하세요.",
  invalid_blog_id: "블로그 ID 형식을 확인하세요.",
  search_limit_reached: "저장한 검색어가 상한에 도달했습니다. 쓰지 않는 검색어를 지우세요.",
};

export interface SettingsState {
  phase: "idle" | "loading" | "ready" | "saving" | "syncing" | "failed";
  settings: AutoDiscoverySettings | null;
  searches: SavedSearch[];
  neighbors: DiscoveryNeighbor[];
  digest: DigestSettings | null;
  lastSync: DiscoverySyncResult | null;
  lastSearchRefresh: { searchId: string; result: DiscoverySearchRefresh } | null;
  form: { ownBlogId: string; enabled: boolean; hour: number; minute: number };
  newQuery: string;
  neighborForm: { name: string; blogId: string; blogUrl: string };
  digestForm: { timezone: string; hour: number; minute: number; emailEnabled: boolean };
  error: string | null;
  notice: string | null;
}

type SettingsApi = Pick<
  LocalApiClient,
  | "autoDiscoverySettings"
  | "saveAutoDiscoverySettings"
  | "syncDiscovery"
  | "savedSearches"
  | "saveSearch"
  | "deleteSearch"
  | "discoveryNeighbors"
  | "saveDiscoveryNeighbor"
  | "refreshSavedSearch"
  | "digestSettings"
  | "saveDigestSettings"
>;

export interface SettingsControllerOptions {
  api?: SettingsApi;
  onChange?: () => void;
}

/** The starting state: nothing loaded and an empty form. */
export function initialSettingsState(): SettingsState {
  return {
    phase: "idle",
    settings: null,
    searches: [],
    neighbors: [],
    digest: null,
    lastSync: null,
    lastSearchRefresh: null,
    form: { ownBlogId: "", enabled: false, hour: 9, minute: 0 },
    newQuery: "",
    neighborForm: { name: "", blogId: "", blogUrl: "" },
    digestForm: { timezone: "Asia/Seoul", hour: 9, minute: 0, emailEnabled: false },
    error: null,
    notice: null,
  };
}

/** Report whether a request is in flight and the form must not be submitted again. */
export function isSettingsBusy(state: SettingsState): boolean {
  return state.phase === "loading" || state.phase === "saving" || state.phase === "syncing";
}

export class SettingsController {
  readonly #root: Element;
  readonly #api: SettingsApi;
  readonly #listeners: (() => void)[] = [];
  #state: SettingsState = initialSettingsState();

  constructor(root: Element, options: SettingsControllerOptions = {}) {
    this.#root = root;
    this.#api = options.api ?? new LocalApiClient();
    if (options.onChange !== undefined) this.#listeners.push(options.onChange);
  }

  observe(listener: () => void): void {
    this.#listeners.push(listener);
  }

  get state(): SettingsState {
    return this.#state;
  }

  /** Draw the settings screen for the current state. */
  render(): void {
    renderSettings(this.#root, this.#state, {
      onSave: () => void this.save(),
      onSync: () => void this.sync(),
      onRefresh: () => void this.load(),
      onFieldChange: (patch) => {
        this.#state = { ...this.#state, form: { ...this.#state.form, ...patch } };
      },
      onQueryChange: (value) => {
        this.#state = { ...this.#state, newQuery: value };
      },
      onAddSearch: () => void this.addSearch(),
      onDeleteSearch: (id) => void this.deleteSearch(id),
      onRefreshSearch: (id) => void this.refreshSearch(id),
      onNeighborFieldChange: (patch) => {
        this.#state = {
          ...this.#state,
          neighborForm: { ...this.#state.neighborForm, ...patch },
        };
      },
      onSaveNeighbor: () => void this.saveNeighbor(),
      onToggleNeighbor: (id) => void this.toggleNeighbor(id),
      onDigestFieldChange: (patch) => {
        this.#state = {
          ...this.#state,
          digestForm: { ...this.#state.digestForm, ...patch },
        };
      },
      onSaveDigest: () => void this.saveDigest(),
    });
  }

  /** Load the saved discovery settings and searches. */
  async load(): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    this.#patch({ phase: "loading", error: null, notice: null });
    try {
      const [settings, searches, neighbors, digest] = await Promise.all([
        this.#api.autoDiscoverySettings(),
        this.#searchesOrEmpty(),
        this.#api.discoveryNeighbors(),
        this.#api.digestSettings(),
      ]);
      this.#patch({
        phase: "ready",
        settings,
        searches,
        neighbors,
        digest,
        form: {
          ownBlogId: settings.ownBlogId,
          enabled: settings.enabled,
          hour: settings.hour,
          minute: settings.minute,
        },
        digestForm: {
          timezone: digest.timezone,
          hour: digest.hour,
          minute: digest.minute,
          emailEnabled: digest.emailEnabled,
        },
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Save the form, refusing an empty blog id before asking the service. */
  async save(): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    if (this.#state.form.ownBlogId.trim().length === 0) {
      this.#patch({ error: "내 블로그 ID를 입력하세요.", notice: null });
      return;
    }
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      const settings = await this.#api.saveAutoDiscoverySettings({
        ownBlogId: this.#state.form.ownBlogId.trim(),
        enabled: this.#state.form.enabled,
        hour: this.#state.form.hour,
        minute: this.#state.form.minute,
        timezone: this.#state.settings?.timezone ?? "Asia/Seoul",
      });
      this.#patch({ phase: "ready", settings, notice: "자동 탐색 설정을 저장했습니다." });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Collect public metadata now and report what it added. */
  async sync(): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    this.#patch({ phase: "syncing", error: null, notice: null });
    try {
      const result = await this.#api.syncDiscovery();
      const settings = await this.#api.autoDiscoverySettings();
      this.#patch({ phase: "ready", lastSync: result, settings });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Save one search term. Duplicated or empty terms never reach the service. */
  async addSearch(): Promise<void> {
    const query = this.#state.newQuery.trim();
    if (isSettingsBusy(this.#state) || query.length === 0) return;
    if (this.#state.searches.some((search) => search.query === query)) {
      this.#patch({ error: "이미 저장한 검색어입니다.", notice: null });
      return;
    }
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      const saved = await this.#api.saveSearch({ query });
      this.#patch({
        phase: "ready",
        searches: [...this.#state.searches, saved],
        newQuery: "",
        notice: `검색어 "${saved.query}"를 저장했습니다.`,
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Remove one search term from the candidate list. */
  async deleteSearch(id: string): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      await this.#api.deleteSearch(id);
      this.#patch({
        phase: "ready",
        searches: this.#state.searches.filter((search) => search.id !== id),
        notice: "검색어를 지웠습니다. 이미 모인 글은 후보 목록에서만 숨습니다.",
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Refresh one search profile without collecting every configured source. */
  async refreshSearch(id: string): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    this.#patch({ phase: "syncing", error: null, notice: null });
    try {
      const result = await this.#api.refreshSavedSearch(id);
      this.#patch({
        phase: "ready",
        lastSearchRefresh: { searchId: id, result },
        notice: `검색 후보 ${result.importedCount}건을 확인했습니다.`,
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Save a manually entered neighbour, or update an existing URL through the API upsert. */
  async saveNeighbor(): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    const { name, blogId, blogUrl } = this.#state.neighborForm;
    if (!name.trim() || !blogId.trim() || !blogUrl.trim()) {
      this.#patch({ error: "이웃 이름, 블로그 ID, 공개 URL을 모두 입력하세요.", notice: null });
      return;
    }
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      const saved = await this.#api.saveDiscoveryNeighbor({
        name: name.trim(),
        blogId: blogId.trim(),
        blogUrl: blogUrl.trim(),
      });
      this.#patch({
        phase: "ready",
        neighbors: upsertNeighbor(this.#state.neighbors, saved),
        neighborForm: { name: "", blogId: "", blogUrl: "" },
        notice: `이웃 "${saved.name}"을 저장했습니다.`,
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Keep the stored address and identity while changing only collection availability. */
  async toggleNeighbor(id: string): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    const neighbor = this.#state.neighbors.find((item) => item.id === id);
    if (neighbor === undefined) return;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      const saved = await this.#api.saveDiscoveryNeighbor({
        name: neighbor.name,
        blogId: neighbor.blogId,
        blogUrl: neighbor.blogUrl,
        enabled: !neighbor.enabled,
      });
      this.#patch({
        phase: "ready",
        neighbors: upsertNeighbor(this.#state.neighbors, saved),
        notice: saved.enabled
          ? `이웃 "${saved.name}" 수집을 다시 켰습니다.`
          : `이웃 "${saved.name}" 수집을 멈췄습니다.`,
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Persist the local digest time and optional email preference. */
  async saveDigest(): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      const digest = await this.#api.saveDigestSettings(this.#state.digestForm);
      this.#patch({
        phase: "ready",
        digest,
        digestForm: {
          timezone: digest.timezone,
          hour: digest.hour,
          minute: digest.minute,
          emailEnabled: digest.emailEnabled,
        },
        notice: "이메일 요약 설정을 저장했습니다.",
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Treat an unavailable search provider as an empty list rather than a screen-wide failure. */
  async #searchesOrEmpty(): Promise<SavedSearch[]> {
    try {
      return await this.#api.savedSearches();
    } catch {
      return [];
    }
  }

  #fail(error: unknown): void {
    this.#patch({ phase: "failed", error: message(error), notice: null });
  }

  #patch(changes: Partial<SettingsState>): void {
    this.#state = { ...this.#state, ...changes };
    for (const listener of this.#listeners) listener();
  }
}

function upsertNeighbor(
  neighbors: DiscoveryNeighbor[],
  saved: DiscoveryNeighbor,
): DiscoveryNeighbor[] {
  const index = neighbors.findIndex((neighbor) => neighbor.id === saved.id);
  const next = index < 0 ? [...neighbors, saved] : neighbors.toSpliced(index, 1, saved);
  return next.toSorted((left, right) => left.name.localeCompare(right.name, "ko-KR"));
}

function message(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.code ?? "";
    return REFUSALS[code] ?? error.message;
  }
  return "알 수 없는 오류가 발생했습니다. 로컬 서비스가 실행 중인지 확인하세요.";
}
