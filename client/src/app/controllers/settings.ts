/**
 * Settings controller for automatic discovery.
 *
 * The README tells people to save their blog id and press "지금 동기화" here, so this screen owns
 * both. Synchronization reports what it added rather than only that it finished, because "성공"
 * with nothing added and "성공" with twelve new posts need different follow-up.
 */

import { ApiError, LocalApiClient } from "../api/client";
import type { AutoDiscoverySettings, DiscoverySyncResult, SavedSearch } from "../api/types";
import { renderSettings } from "../views/settings";

const REFUSALS: Record<string, string> = {
  own_blog_id_missing: "내 블로그 ID를 먼저 저장하세요.",
  search_provider_unavailable:
    "검색 API key가 설정되지 않아 검색 후보를 가져올 수 없습니다. 이웃 새 글은 계속 수집합니다.",
  invalid_blog_id: "블로그 ID 형식을 확인하세요.",
  search_limit_reached: "저장한 검색어가 상한에 도달했습니다. 쓰지 않는 검색어를 지우세요.",
};

export interface SettingsState {
  phase: "idle" | "loading" | "ready" | "saving" | "syncing" | "failed";
  settings: AutoDiscoverySettings | null;
  searches: SavedSearch[];
  lastSync: DiscoverySyncResult | null;
  form: { ownBlogId: string; enabled: boolean; hour: number; minute: number };
  newQuery: string;
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
    lastSync: null,
    form: { ownBlogId: "", enabled: false, hour: 9, minute: 0 },
    newQuery: "",
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
        this.#patch({ form: { ...this.#state.form, ...patch } });
      },
      onQueryChange: (value) => {
        this.#state = { ...this.#state, newQuery: value };
      },
      onAddSearch: () => void this.addSearch(),
      onDeleteSearch: (id) => void this.deleteSearch(id),
    });
  }

  /** Load the saved discovery settings and searches. */
  async load(): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    this.#patch({ phase: "loading", error: null, notice: null });
    try {
      const [settings, searches] = await Promise.all([
        this.#api.autoDiscoverySettings(),
        this.#searchesOrEmpty(),
      ]);
      this.#patch({
        phase: "ready",
        settings,
        searches,
        form: {
          ownBlogId: settings.ownBlogId,
          enabled: settings.enabled,
          hour: settings.hour,
          minute: settings.minute,
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

function message(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.code ?? "";
    return REFUSALS[code] ?? error.message;
  }
  return "알 수 없는 오류가 발생했습니다. 로컬 서비스가 실행 중인지 확인하세요.";
}
