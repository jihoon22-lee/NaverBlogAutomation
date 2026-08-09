/**
 * Settings controller for automatic discovery.
 *
 * The README tells people to save their blog id and press "지금 동기화" here, so this screen owns
 * both. Synchronization reports what it added rather than only that it finished, because "성공"
 * with nothing added and "성공" with twelve new posts need different follow-up.
 */

import { ApiError, LocalApiClient } from "../api/client";
import type {
  AppSettingRecord,
  AutoDiscoverySettings,
  DigestSettings,
  DiscoveryNeighbor,
  DiscoverySearchRefresh,
  DiscoverySyncResult,
  RuntimeConfiguration,
  RuntimeData,
  SavedSearch,
} from "../api/types";
import { renderSettings } from "../views/settings";

export type SettingsSection = "defaults" | "automation" | "connections";

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
  section: SettingsSection;
  /** Explicit disclosure choices survive async state updates and section changes. */
  expandedPanels: Record<string, boolean>;
  phase: "idle" | "loading" | "ready" | "saving" | "syncing" | "restarting" | "failed";
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
  commentForm: {
    closingPhrase: string;
    commentLength: "short" | "medium" | "long";
    commentMood: "calm" | "warm" | "lively";
    neighborMessage: string;
    personalizationMode: "off" | "completed_examples";
    relationshipLevel: "new" | "polite" | "friendly" | "close";
    speechStyle: "honorific" | "banmal";
  };
  automationForm: {
    accepted: boolean;
    dailyCommentCap: number;
    dailyLikeCap: number;
    dailyNeighborCap: number;
    allowedHours: number[];
    jitterPercent: number;
    maxConsecutiveFailures: number;
    minIntervalSeconds: number;
  };
  writingForm: {
    structure: "plain" | "sectioned" | "story";
    bodyTagCap: number;
    referencePostCount: number;
    targetLength: "short" | "medium" | "long";
    tone: "calm" | "warm" | "lively";
    useImageVision: boolean;
  };
  scheduleForm: {
    mode: "manual" | "session" | "schedule";
    hour: number;
    minute: number;
    maxPosts: number;
  };
  budgetForm: { dailyCallCap: number; perRequestProviderCap: number };
  runtime: RuntimeConfiguration | null;
  runtimeData: RuntimeData | null;
  runtimeDataResetConfirmation: string;
  runtimeForm: {
    activeProvider: "openai" | "gemini" | "anthropic" | "fake";
    anthropicApiKey: string;
    clearAnthropicApiKey: boolean;
    clearGeminiApiKey: boolean;
    clearNaverSearchClientId: boolean;
    clearNaverSearchClientSecret: boolean;
    clearOpenaiApiKey: boolean;
    clearSmtpPassword: boolean;
    clearSmtpUsername: boolean;
    anthropicModel: string;
    openaiModel: string;
    browserDriver: "patchright" | "playwright" | "fake";
    browserHeadless: boolean;
    browserChannel: string;
    geminiApiKey: string;
    geminiModel: string;
    accessMode: "local" | "lan";
    naverSearchClientId: string;
    naverSearchClientSecret: string;
    openaiApiKey: string;
    smtpHost: string;
    smtpPassword: string;
    smtpPort: number;
    smtpSecurity: "starttls" | "ssl";
    smtpUsername: string;
    digestEmailFrom: string;
    digestEmailTo: string;
  };
  error: string | null;
  notice: string | null;
}

type SettingsApi = Pick<
  LocalApiClient,
  | "autoDiscoverySettings"
  | "appSetting"
  | "saveAutoDiscoverySettings"
  | "saveAppSetting"
  | "syncDiscovery"
  | "savedSearches"
  | "saveSearch"
  | "deleteSearch"
  | "discoveryNeighbors"
  | "saveDiscoveryNeighbor"
  | "refreshSavedSearch"
  | "digestSettings"
  | "saveDigestSettings"
  | "runtimeConfiguration"
  | "patchRuntimeConfiguration"
  | "restartRuntime"
  | "runtimeData"
  | "exportRuntimeData"
  | "resetRuntimeData"
  | "status"
>;

export interface SettingsControllerOptions {
  api?: SettingsApi;
  onChange?: () => void;
}

/** The starting state: nothing loaded and an empty form. */
export function initialSettingsState(): SettingsState {
  return {
    phase: "idle",
    section: "defaults",
    expandedPanels: {},
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
    commentForm: {
      closingPhrase: "",
      commentLength: "medium",
      commentMood: "warm",
      neighborMessage: "",
      personalizationMode: "off",
      relationshipLevel: "friendly",
      speechStyle: "honorific",
    },
    automationForm: {
      accepted: false,
      dailyCommentCap: 20,
      dailyLikeCap: 20,
      dailyNeighborCap: 5,
      allowedHours: Array.from({ length: 14 }, (_, index) => index + 9),
      jitterPercent: 40,
      maxConsecutiveFailures: 3,
      minIntervalSeconds: 90,
    },
    writingForm: {
      structure: "sectioned",
      bodyTagCap: 10,
      referencePostCount: 3,
      targetLength: "medium",
      tone: "warm",
      useImageVision: false,
    },
    scheduleForm: { mode: "manual", hour: 10, minute: 0, maxPosts: 5 },
    budgetForm: { dailyCallCap: 60, perRequestProviderCap: 3 },
    runtime: null,
    runtimeData: null,
    runtimeDataResetConfirmation: "",
    runtimeForm: {
      activeProvider: "openai",
      anthropicApiKey: "",
      clearAnthropicApiKey: false,
      clearGeminiApiKey: false,
      clearNaverSearchClientId: false,
      clearNaverSearchClientSecret: false,
      clearOpenaiApiKey: false,
      clearSmtpPassword: false,
      clearSmtpUsername: false,
      anthropicModel: "claude-sonnet-5-20260514",
      openaiModel: "gpt-5.6-terra",
      browserDriver: "patchright",
      browserHeadless: false,
      browserChannel: "",
      geminiApiKey: "",
      geminiModel: "gemini-3.6-flash",
      accessMode: "local",
      naverSearchClientId: "",
      naverSearchClientSecret: "",
      openaiApiKey: "",
      smtpHost: "",
      smtpPassword: "",
      smtpPort: 587,
      smtpSecurity: "starttls",
      smtpUsername: "",
      digestEmailFrom: "",
      digestEmailTo: "",
    },
    error: null,
    notice: null,
  };
}

/** Report whether a request is in flight and the form must not be submitted again. */
export function isSettingsBusy(state: SettingsState): boolean {
  return (
    state.phase === "loading" ||
    state.phase === "saving" ||
    state.phase === "syncing" ||
    state.phase === "restarting"
  );
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

  /** Select the card group requested by an onboarding blocker or a deep link. */
  setSection(section: SettingsSection): void {
    this.#state = { ...this.#state, section };
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
      onCommentFieldChange: (patch) => {
        this.#state = { ...this.#state, commentForm: { ...this.#state.commentForm, ...patch } };
      },
      onAutomationFieldChange: (patch) => {
        this.#state = {
          ...this.#state,
          automationForm: { ...this.#state.automationForm, ...patch },
        };
      },
      onWritingFieldChange: (patch) => {
        this.#state = { ...this.#state, writingForm: { ...this.#state.writingForm, ...patch } };
      },
      onSaveCommentSettings: () => void this.saveCommentSettings(),
      onSaveAutomationSettings: () => void this.saveAutomationSettings(),
      onSaveWritingSettings: () => void this.saveWritingSettings(),
      onSectionChange: (section) => {
        this.#state = { ...this.#state, section };
        this.render();
      },
      onPanelToggle: (id, open) => {
        this.#state = {
          ...this.#state,
          expandedPanels: { ...this.#state.expandedPanels, [id]: open },
        };
      },
      onScheduleFieldChange: (patch) => {
        this.#state = { ...this.#state, scheduleForm: { ...this.#state.scheduleForm, ...patch } };
      },
      onBudgetFieldChange: (patch) => {
        this.#state = { ...this.#state, budgetForm: { ...this.#state.budgetForm, ...patch } };
      },
      onSaveScheduleAndBudget: () => void this.saveScheduleAndBudget(),
      onRuntimeFieldChange: (patch) => {
        this.#state = { ...this.#state, runtimeForm: { ...this.#state.runtimeForm, ...patch } };
      },
      onSaveRuntimeConfiguration: () => void this.saveRuntimeConfiguration(),
      onRestartRuntime: () => void this.restartRuntime(),
      onExportRuntimeData: () => void this.exportRuntimeData(),
      onRuntimeDataResetConfirmationChange: (value) => {
        this.#state = { ...this.#state, runtimeDataResetConfirmation: value };
      },
      onResetRuntimeData: () => void this.resetRuntimeData(),
    });
  }

  /** Load the saved discovery settings and searches. */
  async load(): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    const formSnapshot = {
      form: this.#state.form,
      digestForm: this.#state.digestForm,
      commentForm: this.#state.commentForm,
      automationForm: this.#state.automationForm,
      writingForm: this.#state.writingForm,
      scheduleForm: this.#state.scheduleForm,
      budgetForm: this.#state.budgetForm,
      runtimeForm: this.#state.runtimeForm,
    };
    this.#patch({ phase: "loading", error: null, notice: null });
    try {
      const [
        settings,
        searches,
        neighbors,
        digest,
        generation,
        closing,
        neighborMessage,
        consent,
        safety,
        writing,
        schedule,
        budget,
        runtime,
        runtimeData,
      ] = await Promise.all([
        this.#api.autoDiscoverySettings(),
        this.#searchesOrEmpty(),
        this.#api.discoveryNeighbors(),
        this.#api.digestSettings(),
        this.#settingOrDefault("generation_profile", {
          relationship_level: "friendly",
          speech_style: "honorific",
          comment_length: "medium",
          comment_mood: "warm",
          personalization_mode: "off",
        }),
        this.#settingOrDefault("closing_phrase", { phrase: "" }),
        this.#settingOrDefault("neighbor_message", { message: "" }),
        this.#settingOrDefault("automation_consent", { accepted: false, consent_version: 1 }),
        this.#settingOrDefault("safety_policy", {
          daily_like_cap: 20,
          daily_comment_cap: 20,
          daily_neighbor_cap: 5,
          min_interval_seconds: 90,
          jitter_ratio: 0.4,
          allowed_hours: Array.from({ length: 14 }, (_, index) => index + 9),
          max_consecutive_failures: 3,
        }),
        this.#settingOrDefault("writing_profile", {
          target_length: "medium",
          tone: "warm",
          structure: "sectioned",
          reference_post_count: 3,
          body_tag_cap: 10,
          use_image_vision: false,
        }),
        this.#settingOrDefault("schedule_policy", {
          mode: "manual",
          hour: 10,
          minute: 0,
          max_posts: 5,
        }),
        this.#settingOrDefault("llm_budget", {
          daily_call_cap: 60,
          per_request_provider_cap: 3,
        }),
        this.#runtimeOrNull(),
        this.#runtimeDataOrNull(),
      ]);
      this.#patch({
        phase: "ready",
        settings,
        searches,
        neighbors,
        digest,
        form:
          this.#state.form === formSnapshot.form
            ? {
                ownBlogId: settings.ownBlogId,
                enabled: settings.enabled,
                hour: settings.hour,
                minute: settings.minute,
              }
            : this.#state.form,
        digestForm:
          this.#state.digestForm === formSnapshot.digestForm
            ? {
                timezone: digest.timezone,
                hour: digest.hour,
                minute: digest.minute,
                emailEnabled: digest.emailEnabled,
              }
            : this.#state.digestForm,
        commentForm:
          this.#state.commentForm === formSnapshot.commentForm
            ? commentForm(generation, closing, neighborMessage)
            : this.#state.commentForm,
        automationForm:
          this.#state.automationForm === formSnapshot.automationForm
            ? automationForm(consent, safety)
            : this.#state.automationForm,
        writingForm:
          this.#state.writingForm === formSnapshot.writingForm
            ? writingForm(writing)
            : this.#state.writingForm,
        scheduleForm:
          this.#state.scheduleForm === formSnapshot.scheduleForm
            ? scheduleForm(schedule)
            : this.#state.scheduleForm,
        budgetForm:
          this.#state.budgetForm === formSnapshot.budgetForm
            ? budgetForm(budget)
            : this.#state.budgetForm,
        runtime,
        runtimeData,
        runtimeForm:
          this.#state.runtimeForm === formSnapshot.runtimeForm
            ? runtime === null
              ? this.#state.runtimeForm
              : runtimeForm(runtime)
            : this.#state.runtimeForm,
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
    const querySnapshot = this.#state.newQuery;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      const saved = await this.#api.saveSearch({ query });
      this.#patch({
        phase: "ready",
        searches: [...this.#state.searches, saved],
        newQuery: this.#state.newQuery === querySnapshot ? "" : this.#state.newQuery,
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
    const neighborFormSnapshot = this.#state.neighborForm;
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
        neighborForm:
          this.#state.neighborForm === neighborFormSnapshot
            ? { name: "", blogId: "", blogUrl: "" }
            : this.#state.neighborForm,
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
    const digestFormSnapshot = this.#state.digestForm;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      const digest = await this.#api.saveDigestSettings(this.#state.digestForm);
      this.#patch({
        phase: "ready",
        digest,
        digestForm:
          this.#state.digestForm === digestFormSnapshot
            ? {
                timezone: digest.timezone,
                hour: digest.hour,
                minute: digest.minute,
                emailEnabled: digest.emailEnabled,
              }
            : this.#state.digestForm,
        notice: "이메일 요약 설정을 저장했습니다.",
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  async saveCommentSettings(): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    const form = this.#state.commentForm;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      await Promise.all([
        this.#api.saveAppSetting("generation_profile", {
          relationship_level: form.relationshipLevel,
          speech_style: form.speechStyle,
          comment_length: form.commentLength,
          comment_mood: form.commentMood,
          personalization_mode: form.personalizationMode,
        }),
        this.#api.saveAppSetting("closing_phrase", { phrase: form.closingPhrase }),
        this.#api.saveAppSetting("neighbor_message", { message: form.neighborMessage }),
      ]);
      this.#patch({ phase: "ready", notice: "댓글과 AI 기본값을 저장했습니다." });
    } catch (error) {
      this.#fail(error);
    }
  }

  async saveAutomationSettings(): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    const form = this.#state.automationForm;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      await Promise.all([
        this.#api.saveAppSetting("automation_consent", {
          accepted: form.accepted,
          consent_version: 1,
        }),
        this.#api.saveAppSetting("safety_policy", {
          daily_like_cap: form.dailyLikeCap,
          daily_comment_cap: form.dailyCommentCap,
          daily_neighbor_cap: form.dailyNeighborCap,
          min_interval_seconds: form.minIntervalSeconds,
          jitter_ratio: form.jitterPercent / 100,
          allowed_hours: form.allowedHours,
          max_consecutive_failures: form.maxConsecutiveFailures,
        }),
      ]);
      this.#patch({ phase: "ready", notice: "자동 실행 안전 설정을 저장했습니다." });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Save the advanced unattended schedule and the LLM cost guard together. */
  async saveScheduleAndBudget(): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    const { scheduleForm, budgetForm } = this.#state;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      await Promise.all([
        this.#api.saveAppSetting("schedule_policy", {
          mode: scheduleForm.mode,
          hour: scheduleForm.hour,
          minute: scheduleForm.minute,
          max_posts: scheduleForm.maxPosts,
        }),
        this.#api.saveAppSetting("llm_budget", {
          daily_call_cap: budgetForm.dailyCallCap,
          per_request_provider_cap: budgetForm.perRequestProviderCap,
        }),
      ]);
      this.#patch({ phase: "ready", notice: "예약 실행과 AI 예산 한도를 저장했습니다." });
    } catch (error) {
      this.#fail(error);
    }
  }

  async saveWritingSettings(): Promise<void> {
    if (isSettingsBusy(this.#state)) return;
    const form = this.#state.writingForm;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      await this.#api.saveAppSetting("writing_profile", {
        target_length: form.targetLength,
        tone: form.tone,
        structure: form.structure,
        reference_post_count: form.referencePostCount,
        body_tag_cap: form.bodyTagCap,
        use_image_vision: form.useImageVision,
      });
      this.#patch({ phase: "ready", notice: "글쓰기 기본값을 저장했습니다." });
    } catch (error) {
      this.#fail(error);
    }
  }

  async saveRuntimeConfiguration(): Promise<void> {
    if (isSettingsBusy(this.#state) || this.#state.runtime === null) return;
    const form = this.#state.runtimeForm;
    const runtimeFormSnapshot = form;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      const runtime = await this.#api.patchRuntimeConfiguration({
        activeProvider: form.activeProvider,
        anthropicModel: form.anthropicModel,
        openaiModel: form.openaiModel,
        browserDriver: form.browserDriver,
        browserHeadless: form.browserHeadless,
        browserChannel: form.browserChannel,
        geminiModel: form.geminiModel,
        accessMode: form.accessMode,
        ...secretPatch("openaiApiKey", form.openaiApiKey, form.clearOpenaiApiKey),
        ...secretPatch("anthropicApiKey", form.anthropicApiKey, form.clearAnthropicApiKey),
        ...secretPatch("geminiApiKey", form.geminiApiKey, form.clearGeminiApiKey),
        ...secretPatch(
          "naverSearchClientId",
          form.naverSearchClientId,
          form.clearNaverSearchClientId,
        ),
        ...secretPatch(
          "naverSearchClientSecret",
          form.naverSearchClientSecret,
          form.clearNaverSearchClientSecret,
        ),
        smtpHost: form.smtpHost,
        ...secretPatch("smtpUsername", form.smtpUsername, form.clearSmtpUsername),
        ...secretPatch("smtpPassword", form.smtpPassword, form.clearSmtpPassword),
        smtpPort: form.smtpPort,
        smtpSecurity: form.smtpSecurity,
        digestEmailFrom: form.digestEmailFrom,
        digestEmailTo: form.digestEmailTo,
      });
      this.#patch({
        phase: "ready",
        runtime,
        runtimeForm:
          this.#state.runtimeForm === runtimeFormSnapshot
            ? runtimeForm(runtime)
            : this.#state.runtimeForm,
        notice: runtime.restartRequired
          ? "연결 설정을 저장했습니다. 적용하려면 재시작하세요."
          : "연결 설정을 저장했습니다.",
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  async restartRuntime(): Promise<void> {
    if (isSettingsBusy(this.#state) || this.#state.runtime === null) return;
    const runtimeFormSnapshot = this.#state.runtimeForm;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      const runtime = await this.#api.restartRuntime();
      this.#patch({
        phase: "restarting",
        runtime,
        runtimeForm:
          this.#state.runtimeForm === runtimeFormSnapshot
            ? runtimeForm(runtime)
            : this.#state.runtimeForm,
        notice: "재시작을 요청했습니다. 준비되면 화면이 자동으로 새로고침됩니다.",
      });
      await this.#waitForRestart();
    } catch (error) {
      this.#fail(error);
    }
  }

  async exportRuntimeData(): Promise<void> {
    if (isSettingsBusy(this.#state) || this.#state.runtimeData === null) return;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      const archive = await this.#api.exportRuntimeData();
      if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
        throw new Error("download_unavailable");
      }
      const url = URL.createObjectURL(archive);
      const link = document.createElement("a");
      link.href = url;
      link.download = "naver-blog-assistant-data.zip";
      link.click();
      URL.revokeObjectURL(url);
      this.#patch({ phase: "ready", notice: "로컬 데이터 내보내기를 시작했습니다." });
    } catch (error) {
      this.#fail(error);
    }
  }

  async resetRuntimeData(): Promise<void> {
    if (isSettingsBusy(this.#state) || this.#state.runtimeData?.resetAvailable !== true) return;
    this.#patch({ phase: "saving", error: null, notice: null });
    try {
      await this.#api.resetRuntimeData(this.#state.runtimeDataResetConfirmation);
      this.#patch({
        phase: "restarting",
        notice: "기존 데이터는 복구 가능한 backup으로 옮겼습니다. 서비스를 다시 시작합니다.",
      });
      await this.#waitForRestart();
    } catch (error) {
      this.#fail(error);
    }
  }

  async #waitForRestart(): Promise<void> {
    // The supervisor reads the marker asynchronously.  A brief delay avoids
    // mistaking the still-healthy old child for the replacement process.
    await delay(250);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await this.#api.status();
        if (typeof window !== "undefined") window.location.reload();
        return;
      } catch {
        await delay(500);
      }
    }
    this.#patch({
      phase: "ready",
      notice: "서비스 재시작을 기다리는 중입니다. 잠시 후 화면을 새로고침하세요.",
    });
  }

  /** Treat an unavailable search provider as an empty list rather than a screen-wide failure. */
  async #searchesOrEmpty(): Promise<SavedSearch[]> {
    try {
      return await this.#api.savedSearches();
    } catch {
      return [];
    }
  }

  async #settingOrDefault(
    kind: string,
    fallback: Record<string, unknown>,
  ): Promise<AppSettingRecord> {
    try {
      return await this.#api.appSetting(kind);
    } catch {
      return { kind, schemaVersion: 1, payload: fallback, updatedAt: null };
    }
  }

  async #runtimeOrNull(): Promise<RuntimeConfiguration | null> {
    try {
      return await this.#api.runtimeConfiguration();
    } catch {
      // Paired tablets intentionally cannot inspect desktop credentials or browser settings.
      return null;
    }
  }

  async #runtimeDataOrNull(): Promise<RuntimeData | null> {
    try {
      return await this.#api.runtimeData();
    } catch {
      return null;
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

function payload(record: AppSettingRecord): Record<string, unknown> {
  return record.payload;
}

function commentForm(
  generation: AppSettingRecord,
  closing: AppSettingRecord,
  neighborMessage: AppSettingRecord,
): SettingsState["commentForm"] {
  const profile = payload(generation);
  return {
    closingPhrase: stringValue(payload(closing).phrase),
    commentLength: enumValue(profile.comment_length, ["short", "medium", "long"], "medium"),
    commentMood: enumValue(profile.comment_mood, ["calm", "warm", "lively"], "warm"),
    neighborMessage: stringValue(payload(neighborMessage).message),
    personalizationMode: enumValue(
      profile.personalization_mode,
      ["off", "completed_examples"],
      "off",
    ),
    relationshipLevel: enumValue(
      profile.relationship_level,
      ["new", "polite", "friendly", "close"],
      "friendly",
    ),
    speechStyle: enumValue(profile.speech_style, ["honorific", "banmal"], "honorific"),
  };
}

function runtimeForm(runtime: RuntimeConfiguration): SettingsState["runtimeForm"] {
  return {
    activeProvider: runtime.ai.activeProvider,
    anthropicApiKey: "",
    clearAnthropicApiKey: false,
    clearGeminiApiKey: false,
    clearNaverSearchClientId: false,
    clearNaverSearchClientSecret: false,
    clearOpenaiApiKey: false,
    clearSmtpPassword: false,
    clearSmtpUsername: false,
    anthropicModel:
      runtime.ai.providers.find((provider) => provider.provider === "anthropic")?.model ??
      "claude-sonnet-5-20260514",
    openaiModel:
      runtime.ai.providers.find((provider) => provider.provider === "openai")?.model ??
      "gpt-5.6-terra",
    browserDriver: runtime.browser.driver,
    browserHeadless: runtime.browser.headless,
    browserChannel: runtime.browser.channel,
    geminiApiKey: "",
    geminiModel:
      runtime.ai.providers.find((provider) => provider.provider === "gemini")?.model ??
      "gemini-3.6-flash",
    accessMode: runtime.network.accessMode,
    naverSearchClientId: "",
    naverSearchClientSecret: "",
    openaiApiKey: "",
    smtpHost: runtime.smtp.host,
    smtpPassword: "",
    smtpPort: runtime.smtp.port,
    smtpSecurity: runtime.smtp.security,
    smtpUsername: "",
    digestEmailFrom: runtime.smtp.digestEmailFrom,
    digestEmailTo: runtime.smtp.digestEmailTo,
  };
}

function secretPatch(
  key:
    | "anthropicApiKey"
    | "geminiApiKey"
    | "naverSearchClientId"
    | "naverSearchClientSecret"
    | "openaiApiKey"
    | "smtpPassword"
    | "smtpUsername",
  value: string,
  clear: boolean,
): Record<string, { clear: true } | { replace: string }> {
  if (clear) return { [key]: { clear: true } };
  return value.length === 0 ? {} : { [key]: { replace: value } };
}

function automationForm(
  consent: AppSettingRecord,
  safety: AppSettingRecord,
): SettingsState["automationForm"] {
  const policy = payload(safety);
  return {
    accepted: payload(consent).accepted === true,
    dailyCommentCap: numberValue(policy.daily_comment_cap, 20),
    dailyLikeCap: numberValue(policy.daily_like_cap, 20),
    dailyNeighborCap: numberValue(policy.daily_neighbor_cap, 5),
    allowedHours: allowedHoursValue(policy.allowed_hours),
    jitterPercent: Math.round(numberValue(policy.jitter_ratio, 0.4) * 100),
    maxConsecutiveFailures: numberValue(policy.max_consecutive_failures, 3),
    minIntervalSeconds: numberValue(policy.min_interval_seconds, 90),
  };
}

function writingForm(record: AppSettingRecord): SettingsState["writingForm"] {
  const profile = payload(record);
  return {
    bodyTagCap: numberValue(profile.body_tag_cap, 10),
    referencePostCount: numberValue(profile.reference_post_count, 3),
    structure: enumValue(profile.structure, ["plain", "sectioned", "story"], "sectioned"),
    targetLength: enumValue(profile.target_length, ["short", "medium", "long"], "medium"),
    tone: enumValue(profile.tone, ["calm", "warm", "lively"], "warm"),
    useImageVision: profile.use_image_vision === true,
  };
}

function scheduleForm(record: AppSettingRecord): SettingsState["scheduleForm"] {
  const value = payload(record);
  return {
    mode: enumValue(value.mode, ["manual", "session", "schedule"], "manual"),
    hour: numberValue(value.hour, 10),
    minute: numberValue(value.minute, 0),
    maxPosts: numberValue(value.max_posts, 5),
  };
}

function budgetForm(record: AppSettingRecord): SettingsState["budgetForm"] {
  const value = payload(record);
  return {
    dailyCallCap: numberValue(value.daily_call_cap, 60),
    perRequestProviderCap: numberValue(value.per_request_provider_cap, 3),
  };
}

function allowedHoursValue(value: unknown): number[] {
  const fallback = Array.from({ length: 14 }, (_, index) => index + 9);
  if (!Array.isArray(value)) return fallback;
  const hours = value.filter(
    (hour): hour is number => typeof hour === "number" && Number.isInteger(hour),
  );
  return hours.length === 0
    ? fallback
    : [...new Set(hours)].toSorted((left, right) => left - right);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
