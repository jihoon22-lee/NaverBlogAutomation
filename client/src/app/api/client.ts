/**
 * Same-origin client for the local API.
 *
 * The app is served by the same FastAPI process, so requests use relative paths and need no CORS
 * relaxation. Every response is validated before it reaches the views: an unexpected shape is a
 * contract error, not something to render.
 */

import type {
  AppReadiness,
  AppSettingRecord,
  ArticleExtraction,
  CandidateTone,
  CommentCandidate,
  CommentFanout,
  CommentGeneration,
  CommentRefinement,
  GenerationOptions,
  Recommendation,
  RecommendationHistoryItem,
  ReviewStatus,
  BrowserLoginState,
  BrowserSession,
  BrowserSessionState,
  BlogCategory,
  BodyBlock,
  DiscoveryPost,
  DiscoveryQueuePage,
  DiscoverySource,
  DiscoveryState,
  EngagementRun,
  AutoDiscoverySettings,
  AutomationSession,
  EngagementRunState,
  EngagementStep,
  EngagementStepName,
  DiscoverySyncResult,
  DiscoveryNeighbor,
  DiscoverySearchRefresh,
  DigestSettings,
  SavedSearch,
  ScheduleStatus,
  SafetyStatus,
  SessionState,
  SessionTrigger,
  EngagementStepState,
  LlmProviderName,
  LlmProviderStatus,
  PostDraft,
  ProblemDetails,
  PublishRun,
  PublishStep,
  PublishStepName,
  ServiceStatus,
  RemoteDevice,
  RemotePairingCode,
  ReadinessBlockerCode,
} from "./types";

const SESSION_STATES = new Set<BrowserSessionState>(["stopped", "launching", "ready", "closing"]);
const LOGIN_STATES = new Set<BrowserLoginState>(["unknown", "anonymous", "authenticated"]);
const SOURCES = new Set<DiscoverySource>(["neighbor", "search"]);
const STATES = new Set<DiscoveryState>(["queued", "opened", "completed", "skipped", "unavailable"]);
const SELECTOR_KINDS = new Set(["modern", "legacy", "semantic"]);
const TONES = new Set<CandidateTone>(["warm", "curious", "supportive"]);
const REVIEW_STATUSES = new Set<ReviewStatus>(["drafted", "approved", "completed"]);
const QUALITY_WARNINGS = new Set([
  "length_target_missed",
  "candidate_roles_blurred",
  "candidates_too_similar",
]);
const STEP_NAMES = new Set<EngagementStepName>(["like", "comment", "mutual_neighbor"]);
const STEP_STATES = new Set<EngagementStepState>([
  "pending",
  "running",
  "succeeded",
  "skipped",
  "failed",
  "unconfirmed",
]);
const RUN_STATES = new Set<EngagementRunState>(["running", "succeeded", "failed", "unconfirmed"]);
const SESSION_TRIGGERS = new Set<SessionTrigger>(["manual", "session", "schedule"]);
const SYNC_HISTORY = new Set(["never", "success", "partial", "failed"]);
const SYNC_STATES = new Set(["success", "partial", "failed"]);
const NEIGHBOR_FEED_STATUSES = new Set(["ready", "unavailable", "unknown"]);
const BATCH_STATES = new Set<SessionState>([
  "pending",
  "running",
  "completed",
  "aborted",
  "cancelled",
]);
const RESULT_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const PROVIDERS = new Set<LlmProviderName>(["openai", "gemini", "anthropic"]);
const DRAFT_STATUSES = new Set([
  "collecting",
  "composed",
  "refining",
  "tagged",
  "staging",
  "staged",
  "abandoned",
]);
const REVISION_KINDS = new Set(["seed", "composed", "refined", "user_edited"]);
const BLOCK_KINDS = new Set(["heading", "paragraph", "quote", "image"]);
const TAG_SOURCES = new Set(["generated", "user"]);
const PUBLISH_STEPS = new Set<PublishStepName>(["title", "body", "images", "tags", "save"]);
const READINESS_BLOCKERS = new Set<ReadinessBlockerCode>([
  "web_app_assets_missing",
  "browser_not_running",
  "naver_login_required",
  "own_blog_id_missing",
  "llm_provider_missing",
  "automation_consent_missing",
  "safety_policy_missing",
]);

export interface DraftGenerationOptions {
  provider: LlmProviderName;
  model?: string | null;
  length?: "short" | "medium" | "long";
  tone?: "calm" | "warm" | "lively";
  structure?: "plain" | "sectioned" | "story";
  referenceLimit?: number;
  request?: string;
}

function generationPayload(options: DraftGenerationOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = { provider: options.provider };
  if (options.model !== undefined && options.model !== null) payload.model = options.model;
  if (options.length !== undefined) payload.length = options.length;
  if (options.tone !== undefined) payload.tone = options.tone;
  if (options.structure !== undefined) payload.structure = options.structure;
  if (options.referenceLimit !== undefined) payload.reference_limit = options.referenceLimit;
  if (options.request !== undefined) payload.request = options.request;
  return payload;
}
const PROBLEM_CODE = /^[a-z][a-z0-9_]*$/u;

type Fetch = typeof fetch;

export class ApiError extends Error {
  readonly problem: ProblemDetails | null;
  readonly status: number | null;

  constructor(
    message: string,
    options: { problem?: ProblemDetails | null; status?: number | null } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.problem = options.problem ?? null;
    this.status = options.status ?? null;
  }

  /** Return the stable machine-readable code when the service supplied one. */
  get code(): string | null {
    return this.problem?.code ?? null;
  }
}

export class LocalApiClient {
  readonly #fetch: Fetch;
  readonly #base: string;

  constructor(options: { base?: string; fetch?: Fetch } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#base = options.base ?? "";
  }

  async status(): Promise<ServiceStatus> {
    return readServiceStatus(await this.#request("GET", "/api/v1/status"));
  }

  async appReadiness(): Promise<AppReadiness> {
    return readAppReadiness(await this.#request("GET", "/api/v1/app/readiness"));
  }

  async createRemotePairingCode(): Promise<RemotePairingCode> {
    return readRemotePairingCode(await this.#request("POST", "/api/v1/remote/pairing-code"));
  }

  async pairRemoteDevice(code: string, deviceName: string): Promise<RemoteDevice> {
    const body = await this.#request("POST", "/api/v1/remote/pair", {
      code,
      device_name: deviceName,
    });
    if (!isRecord(body)) throw contractError("pairing response");
    return readRemoteDevice(body.device);
  }

  async remoteDevices(): Promise<RemoteDevice[]> {
    const body = await this.#request("GET", "/api/v1/remote/devices");
    if (!isRecord(body) || !Array.isArray(body.items)) throw contractError("remote devices");
    return body.items.map(readRemoteDevice);
  }

  async revokeRemoteDevice(id: string): Promise<void> {
    await this.#request("DELETE", `/api/v1/remote/devices/${id}`);
  }

  /**
   * Read both queue sources.
   *
   * The existing contract requires one `source` per request, so the app merges the two lists rather
   * than changing an endpoint the frozen extension also uses.
   */
  async discoveryQueue(): Promise<DiscoveryPost[]> {
    const [neighbor, search] = await Promise.all([
      this.discoveryQueueFor("neighbor"),
      this.discoveryQueueFor("search"),
    ]);
    return [...neighbor, ...search];
  }

  async discoveryQueueFor(source: DiscoverySource): Promise<DiscoveryPost[]> {
    const body = await this.#request("GET", `/api/v1/app/discovery/queue?source=${source}`);
    return readDiscoveryQueue(body);
  }

  async discoveryQueuePage(
    options: {
      source?: DiscoverySource;
      state?: DiscoveryState;
      query?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<DiscoveryQueuePage> {
    const parameters = new URLSearchParams();
    if (options.source !== undefined) parameters.set("source", options.source);
    if (options.state !== undefined) parameters.set("state", options.state);
    if (options.query?.trim()) parameters.set("query", options.query.trim());
    if (options.cursor !== undefined) parameters.set("cursor", options.cursor);
    if (options.limit !== undefined) parameters.set("limit", String(options.limit));
    const query = parameters.size === 0 ? "" : `?${parameters.toString()}`;
    return readDiscoveryQueuePage(
      await this.#request("GET", `/api/v1/app/discovery/queue${query}`),
    );
  }

  async browserSession(options: { refresh?: boolean } = {}): Promise<BrowserSession> {
    const query = options.refresh === true ? "?refresh=true" : "";
    return readBrowserSession(await this.#request("GET", `/api/v1/automation/session${query}`));
  }

  async launchBrowserSession(): Promise<BrowserSession> {
    return readBrowserSession(await this.#request("POST", "/api/v1/automation/session/launch"));
  }

  async closeBrowserSession(): Promise<BrowserSession> {
    return readBrowserSession(await this.#request("POST", "/api/v1/automation/session/close"));
  }

  async focusBrowserSession(): Promise<BrowserSession> {
    return readBrowserSession(await this.#request("POST", "/api/v1/automation/session/focus"));
  }

  async extractArticle(url: string): Promise<ArticleExtraction> {
    const body = await this.#request("POST", "/api/v1/automation/extract", { url });
    return readArticleExtraction(body);
  }

  async generateComment(url: string, options: GenerationOptions = {}): Promise<CommentGeneration> {
    const payload: Record<string, unknown> = { url };
    if (options.relationshipLevel !== undefined) {
      payload.relationship_level = options.relationshipLevel;
    }
    if (options.speechStyle !== undefined) payload.speech_style = options.speechStyle;
    if (options.commentLength !== undefined) payload.comment_length = options.commentLength;
    if (options.commentMood !== undefined) payload.comment_mood = options.commentMood;
    if (options.personalizationMode !== undefined) {
      payload.personalization_mode = options.personalizationMode;
    }
    if (options.replace === true) payload.replace = true;
    const body = await this.#request("POST", "/api/v1/automation/comments", payload);
    return readCommentGeneration(body);
  }

  async generateCommentFanout(
    url: string,
    providers: { provider: LlmProviderName; model?: string }[],
    options: GenerationOptions = {},
  ): Promise<CommentFanout> {
    const payload: Record<string, unknown> = { url };
    if (options.relationshipLevel !== undefined) {
      payload.relationship_level = options.relationshipLevel;
    }
    if (options.speechStyle !== undefined) payload.speech_style = options.speechStyle;
    if (options.commentLength !== undefined) payload.comment_length = options.commentLength;
    if (options.commentMood !== undefined) payload.comment_mood = options.commentMood;
    if (options.personalizationMode !== undefined) {
      payload.personalization_mode = options.personalizationMode;
    }
    if (options.replace === true) payload.replace = true;
    payload.providers = providers.map((selection) => ({
      provider: selection.provider,
      ...(selection.model === undefined ? {} : { model: selection.model }),
    }));
    return readCommentFanout(
      await this.#request("POST", "/api/v1/automation/comments/fanout", payload),
    );
  }

  async reviewRecommendation(
    id: string,
    patch: {
      editedComment?: string;
      personalizationEligible?: boolean;
      reviewStatus?: ReviewStatus;
      selectedCandidateId?: string;
    },
  ): Promise<Recommendation> {
    const payload: Record<string, unknown> = {};
    if (patch.selectedCandidateId !== undefined) {
      payload.selected_candidate_id = patch.selectedCandidateId;
    }
    if (patch.editedComment !== undefined) payload.edited_comment = patch.editedComment;
    if (patch.personalizationEligible !== undefined) {
      payload.personalization_eligible = patch.personalizationEligible;
    }
    if (patch.reviewStatus !== undefined) payload.review_status = patch.reviewStatus;
    const body = await this.#request("PATCH", `/api/v1/recommendations/${id}`, payload);
    return readRecommendation(body);
  }

  async recommendation(id: string): Promise<Recommendation> {
    return readRecommendation(await this.#request("GET", `/api/v1/recommendations/${id}`));
  }

  async recommendations(limit = 20): Promise<RecommendationHistoryItem[]> {
    const body = await this.#request("GET", `/api/v1/recommendations?limit=${limit}`);
    return readItems(body, readRecommendationHistoryItem);
  }

  async deleteRecommendation(id: string): Promise<void> {
    await this.#request("DELETE", `/api/v1/recommendations/${id}`);
  }

  async clearPersonalizationExamples(): Promise<void> {
    await this.#request("DELETE", "/api/v1/personalization/examples");
  }

  async refineRecommendation(
    id: string,
    payload: {
      currentComment: string;
      provider: LlmProviderName;
      preset?: "shorter" | "natural" | "warmer" | "specific";
      request?: string;
      model?: string;
      idempotencyKey: string;
    },
  ): Promise<CommentRefinement> {
    const body = await this.#request(
      "POST",
      `/api/v1/recommendations/${id}/refine`,
      {
        current_comment: payload.currentComment,
        provider: payload.provider,
        ...(payload.preset === undefined ? {} : { preset: payload.preset }),
        ...(payload.request === undefined ? {} : { request: payload.request }),
        ...(payload.model === undefined ? {} : { model: payload.model }),
      },
      { "Idempotency-Key": payload.idempotencyKey },
    );
    return readCommentRefinement(body);
  }

  async updateDiscoveryPostState(id: string, state: DiscoveryState): Promise<DiscoveryPost> {
    return readDiscoveryPost(
      await this.#request("PATCH", `/api/v1/discovery/queue/${id}`, { state }),
    );
  }

  async autoDiscoverySettings(): Promise<AutoDiscoverySettings> {
    return readAutoDiscoverySettings(
      await this.#request("GET", "/api/v1/discovery/automation-settings"),
    );
  }

  async saveAutoDiscoverySettings(settings: {
    ownBlogId: string;
    enabled: boolean;
    hour: number;
    minute: number;
    timezone?: string;
  }): Promise<AutoDiscoverySettings> {
    const body = await this.#request("PUT", "/api/v1/discovery/automation-settings", {
      own_blog_id: settings.ownBlogId,
      enabled: settings.enabled,
      hour: settings.hour,
      minute: settings.minute,
      timezone: settings.timezone ?? "Asia/Seoul",
    });
    return readAutoDiscoverySettings(body);
  }

  /** Collect public metadata now instead of waiting for the daily run. */
  async syncDiscovery(): Promise<DiscoverySyncResult> {
    return readDiscoverySyncResult(await this.#request("POST", "/api/v1/discovery/sync"));
  }

  async savedSearches(): Promise<SavedSearch[]> {
    const body = await this.#request("GET", "/api/v1/discovery/searches");
    return readItems(body, readSavedSearch);
  }

  async saveSearch(search: {
    query: string;
    excludedTerms?: string[];
    freshnessDays?: number;
    enabled?: boolean;
  }): Promise<SavedSearch> {
    const body = await this.#request("POST", "/api/v1/discovery/searches", {
      query: search.query,
      excluded_terms: search.excludedTerms ?? [],
      freshness_days: search.freshnessDays ?? 14,
      enabled: search.enabled ?? true,
    });
    return readSavedSearch(body);
  }

  async deleteSearch(id: string): Promise<void> {
    await this.#request("DELETE", `/api/v1/discovery/searches/${id}`);
  }

  async discoveryNeighbors(): Promise<DiscoveryNeighbor[]> {
    const body = await this.#request("GET", "/api/v1/discovery/neighbors");
    return readItems(body, readDiscoveryNeighbor);
  }

  async saveDiscoveryNeighbor(neighbor: {
    name: string;
    blogUrl: string;
    blogId: string;
    enabled?: boolean;
  }): Promise<DiscoveryNeighbor> {
    const body = await this.#request("POST", "/api/v1/discovery/neighbors", {
      name: neighbor.name,
      blog_url: neighbor.blogUrl,
      blog_id: neighbor.blogId,
      enabled: neighbor.enabled ?? true,
    });
    return readDiscoveryNeighbor(body);
  }

  async refreshSavedSearch(id: string): Promise<DiscoverySearchRefresh> {
    return readDiscoverySearchRefresh(
      await this.#request("POST", `/api/v1/discovery/searches/${id}/refresh`),
    );
  }

  async digestSettings(): Promise<DigestSettings> {
    return readDigestSettings(await this.#request("GET", "/api/v1/discovery/digest-settings"));
  }

  async saveDigestSettings(settings: {
    timezone: string;
    hour: number;
    minute: number;
    emailEnabled: boolean;
  }): Promise<DigestSettings> {
    return readDigestSettings(
      await this.#request("PUT", "/api/v1/discovery/digest-settings", {
        timezone: settings.timezone,
        hour: settings.hour,
        minute: settings.minute,
        email_enabled: settings.emailEnabled,
      }),
    );
  }

  async appSetting(kind: string): Promise<AppSettingRecord> {
    return readAppSetting(await this.#request("GET", `/api/v1/settings/${kind}`));
  }

  async saveAppSetting(kind: string, payload: Record<string, unknown>): Promise<AppSettingRecord> {
    return readAppSetting(await this.#request("PUT", `/api/v1/settings/${kind}`, { payload }));
  }

  /** Approve exactly one queued post for execution. The service answers before the run finishes. */
  async startEngagementRun(
    discoveryPostId: string,
    recommendationId: string,
  ): Promise<EngagementRun> {
    const body = await this.#request("POST", "/api/v1/automation/engagement-runs", {
      discovery_post_id: discoveryPostId,
      recommendation_id: recommendationId,
    });
    return readEngagementRun(body);
  }

  async engagementRun(id: string): Promise<EngagementRun> {
    return readEngagementRun(await this.#request("GET", `/api/v1/engagement-runs/${id}`));
  }

  /** Return the URL of one run's progress stream. */
  engagementRunEventsUrl(id: string): string {
    return `${this.#base}/api/v1/automation/engagement-runs/${id}/events`;
  }

  /** Approve one batch of queued posts. The service answers before the batch finishes. */
  async approveSession(request: {
    approvedSteps: EngagementStepName[];
    maxPosts: number;
    sources: DiscoverySource[];
    postIds?: string[];
  }): Promise<AutomationSession> {
    const body = await this.#request("POST", "/api/v1/automation/sessions", {
      approved_steps: request.approvedSteps,
      max_posts: request.maxPosts,
      sources: request.sources,
      ...(request.postIds === undefined ? {} : { post_ids: request.postIds }),
    });
    return readAutomationSession(body);
  }

  async sessions(limit?: number): Promise<AutomationSession[]> {
    const query = limit === undefined ? "" : `?limit=${limit}`;
    const body = await this.#request("GET", `/api/v1/automation/sessions${query}`);
    return readItems(body, readAutomationSession);
  }

  async session(id: string): Promise<AutomationSession> {
    return readAutomationSession(await this.#request("GET", `/api/v1/automation/sessions/${id}`));
  }

  /** Ask the batch to stop. The post already running finishes first. */
  async cancelSession(id: string): Promise<AutomationSession> {
    return readAutomationSession(
      await this.#request("POST", `/api/v1/automation/sessions/${id}/cancel`),
    );
  }

  /** Return the URL of one batch's progress stream. */
  sessionEventsUrl(id: string): string {
    return `${this.#base}/api/v1/automation/sessions/${id}/events`;
  }

  async schedule(): Promise<ScheduleStatus> {
    return readScheduleStatus(await this.#request("GET", "/api/v1/automation/schedule"));
  }

  async safetyStatus(): Promise<SafetyStatus> {
    return readSafetyStatus(await this.#request("GET", "/api/v1/automation/safety-status"));
  }

  /** Record only the steps a user confirms were completed by hand. */
  async completeEngagementManually(
    id: string,
    completedSteps: EngagementStepName[],
  ): Promise<EngagementRun> {
    const body = await this.#request("POST", `/api/v1/engagement-runs/${id}/manual-completion`, {
      completed_steps: completedSteps,
    });
    return readEngagementRun(body);
  }

  async llmProviders(): Promise<LlmProviderStatus[]> {
    const body = await this.#request("GET", "/api/v1/llm/providers");
    return readItems(body, readLlmProvider);
  }

  async blogCategories(): Promise<BlogCategory[]> {
    const body = await this.#request("GET", "/api/v1/blog/categories");
    return readItems(body, readBlogCategory);
  }

  async syncBlogCategories(): Promise<BlogCategory[]> {
    const body = await this.#request("POST", "/api/v1/blog/categories/sync");
    return readItems(body, readBlogCategory);
  }

  async createDraft(payload: {
    title: string;
    seedText: string;
    categoryNo?: number | null;
    useImageVision?: boolean;
  }): Promise<PostDraft> {
    const body = await this.#request("POST", "/api/v1/drafts", {
      title: payload.title,
      seed_text: payload.seedText,
      ...(payload.categoryNo === undefined ? {} : { category_no: payload.categoryNo }),
      ...(payload.useImageVision === undefined ? {} : { use_image_vision: payload.useImageVision }),
    });
    return readPostDraft(body);
  }

  async drafts(limit = 20): Promise<PostDraft[]> {
    const body = await this.#request("GET", `/api/v1/drafts?limit=${limit}`);
    return readItems(body, readPostDraft);
  }

  async draft(id: string): Promise<PostDraft> {
    return readPostDraft(await this.#request("GET", `/api/v1/drafts/${id}`));
  }

  async deleteDraft(id: string): Promise<void> {
    await this.#request("DELETE", `/api/v1/drafts/${id}`);
  }

  async patchDraft(
    id: string,
    patch: { title?: string; categoryNo?: number; activeRevisionId?: string },
  ): Promise<PostDraft> {
    const payload: Record<string, unknown> = {};
    if (patch.title !== undefined) payload.title = patch.title;
    if (patch.categoryNo !== undefined) payload.category_no = patch.categoryNo;
    if (patch.activeRevisionId !== undefined) {
      payload.active_revision_id = patch.activeRevisionId;
    }
    return readPostDraft(await this.#request("PATCH", `/api/v1/drafts/${id}`, payload));
  }

  async uploadDraftImage(id: string, file: File, altText = ""): Promise<PostDraft> {
    const form = new FormData();
    form.append("file", file);
    form.append("alt_text", altText);
    return readPostDraft(await this.#upload(`/api/v1/drafts/${id}/images`, form));
  }

  async deleteDraftImage(id: string, imageId: string): Promise<PostDraft> {
    return readPostDraft(await this.#request("DELETE", `/api/v1/drafts/${id}/images/${imageId}`));
  }

  async saveDraftBody(
    id: string,
    payload: { title: string; blocks: BodyBlock[]; summary?: string },
  ): Promise<PostDraft> {
    return readPostDraft(
      await this.#request("PUT", `/api/v1/drafts/${id}/body`, {
        title: payload.title,
        blocks: payload.blocks,
        ...(payload.summary === undefined ? {} : { summary: payload.summary }),
      }),
    );
  }

  async composeDraft(id: string, payload: DraftGenerationOptions): Promise<PostDraft> {
    return readPostDraft(
      await this.#request("POST", `/api/v1/drafts/${id}/compose`, generationPayload(payload)),
    );
  }

  async refineDraft(id: string, payload: DraftGenerationOptions): Promise<PostDraft> {
    return readPostDraft(
      await this.#request("POST", `/api/v1/drafts/${id}/refine`, generationPayload(payload)),
    );
  }

  async generateDraftTags(id: string, payload: DraftGenerationOptions): Promise<PostDraft> {
    return readPostDraft(
      await this.#request("POST", `/api/v1/drafts/${id}/tags`, generationPayload(payload)),
    );
  }

  async patchDraftTags(
    id: string,
    patch: { selected?: string[]; added?: string[] },
  ): Promise<PostDraft> {
    const payload: Record<string, unknown> = {};
    if (patch.selected !== undefined) payload.selected = patch.selected;
    if (patch.added !== undefined) payload.added = patch.added;
    return readPostDraft(await this.#request("PATCH", `/api/v1/drafts/${id}/tags`, payload));
  }

  async stageDraft(id: string): Promise<PublishRun> {
    return readPublishRun(await this.#request("POST", `/api/v1/drafts/${id}/stage`));
  }

  /** Return the URL of one staging run's progress stream. */
  stagingEventsUrl(id: string): string {
    return `${this.#base}/api/v1/drafts/${id}/stage/events`;
  }

  async #upload(path: string, form: FormData): Promise<unknown> {
    const headers = new Headers();
    const csrfToken = readCsrfCookie();
    if (csrfToken !== null) headers.set("X-NBA-CSRF", csrfToken);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, { method: "POST", body: form, headers });
    } catch {
      throw new ApiError("로컬 서비스에 연결할 수 없습니다.", { status: null });
    }
    if (!response.ok) {
      throw new ApiError("로컬 서비스가 요청을 거부했습니다.", {
        problem: await readProblem(response),
        status: response.status,
      });
    }
    try {
      return await response.json();
    } catch {
      throw new ApiError("응답을 해석할 수 없습니다.", { status: response.status });
    }
  }

  async #request(
    method: string,
    path: string,
    payload?: unknown,
    extraHeaders: HeadersInit = {},
  ): Promise<unknown> {
    const headers = new Headers();
    for (const [name, value] of new Headers(extraHeaders)) headers.set(name, value);
    if (payload !== undefined) headers.set("Content-Type", "application/json");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const csrfToken = readCsrfCookie();
      if (csrfToken !== null) headers.set("X-NBA-CSRF", csrfToken);
    }
    const init: RequestInit =
      payload === undefined
        ? { method, headers }
        : {
            method,
            headers,
            body: JSON.stringify(payload),
          };
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, init);
    } catch {
      throw new ApiError("로컬 서비스에 연결할 수 없습니다.", { status: null });
    }
    if (!response.ok) {
      throw new ApiError("로컬 서비스가 요청을 거부했습니다.", {
        problem: await readProblem(response),
        status: response.status,
      });
    }
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new ApiError("응답을 해석할 수 없습니다.", { status: response.status });
    }
  }
}

function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const prefix = "nba_csrf=";
  const value = document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  return value === undefined ? null : decodeURIComponent(value.slice(prefix.length));
}

async function readProblem(response: Response): Promise<ProblemDetails | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  const code = body.code;
  const detail = body.detail;
  const title = body.title;
  const status = body.status;
  if (
    typeof code !== "string" ||
    !PROBLEM_CODE.test(code) ||
    typeof detail !== "string" ||
    typeof title !== "string" ||
    typeof status !== "number"
  ) {
    return null;
  }
  return { code, detail, status, title };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contractError(field: string): ApiError {
  return new ApiError(`응답의 ${field} 값이 계약과 다릅니다.`);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw contractError(field);
  return value;
}

/** Read a string that the service may legitimately leave empty, such as an unset blog id. */
function readText(value: unknown, field: string): string {
  if (typeof value !== "string") throw contractError(field);
  return value;
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return readString(value, field);
}

function readCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw contractError(field);
  }
  return value;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw contractError(field);
  return value;
}

function readStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw contractError(field);
  return value.map((entry) => readString(entry, field));
}

export function readRemotePairingCode(body: unknown): RemotePairingCode {
  if (!isRecord(body)) throw contractError("pairing code");
  return {
    code: readString(body.code, "code"),
    expiresAt: readString(body.expires_at, "expires_at"),
  };
}

export function readAppReadiness(body: unknown): AppReadiness {
  if (!isRecord(body)) throw contractError("app readiness");
  const accessMode = body.access_mode;
  if (accessMode !== "local" && accessMode !== "lan") throw contractError("access_mode");
  const browserState = body.browser_state;
  if (
    typeof browserState !== "string" ||
    !SESSION_STATES.has(browserState as BrowserSessionState)
  ) {
    throw contractError("browser_state");
  }
  const browserLogin = body.browser_login;
  if (typeof browserLogin !== "string" || !LOGIN_STATES.has(browserLogin as BrowserLoginState)) {
    throw contractError("browser_login");
  }
  if (
    !Array.isArray(body.lan_addresses) ||
    !body.lan_addresses.every((item) => typeof item === "string")
  ) {
    throw contractError("lan_addresses");
  }
  if (
    !Array.isArray(body.blockers) ||
    !body.blockers.every(
      (item): item is ReadinessBlockerCode =>
        typeof item === "string" && READINESS_BLOCKERS.has(item as ReadinessBlockerCode),
    )
  ) {
    throw contractError("blockers");
  }
  return {
    accessMode,
    webAppAssetsReady: readBoolean(body.web_app_assets_ready, "web_app_assets_ready"),
    lanAddresses: body.lan_addresses,
    browserState: browserState as BrowserSessionState,
    browserLogin: browserLogin as BrowserLoginState,
    ownBlogConfigured: readBoolean(body.own_blog_configured, "own_blog_configured"),
    generationAvailable: readBoolean(body.generation_available, "generation_available"),
    automationConsent: readBoolean(body.automation_consent, "automation_consent"),
    safetyPolicyConfigured: readBoolean(body.safety_policy_configured, "safety_policy_configured"),
    blockers: body.blockers,
  };
}

export function readRemoteDevice(body: unknown): RemoteDevice {
  if (!isRecord(body)) throw contractError("remote device");
  return {
    id: readString(body.id, "id"),
    deviceName: readString(body.device_name, "device_name"),
    createdAt: readString(body.created_at, "created_at"),
    lastSeenAt: readString(body.last_seen_at, "last_seen_at"),
    expiresAt: readString(body.expires_at, "expires_at"),
  };
}

export function readServiceStatus(body: unknown): ServiceStatus {
  if (!isRecord(body)) throw contractError("status");
  if (body.status !== "ready" || body.database !== "ready") throw contractError("status");
  const environment = body.app_environment;
  const mode = body.generator_mode;
  if (environment !== "production" && environment !== "development" && environment !== "test") {
    throw contractError("app_environment");
  }
  if (mode !== "openai" && mode !== "fake") throw contractError("generator_mode");
  return {
    status: "ready",
    apiVersion: readString(body.api_version, "api_version"),
    appEnvironment: environment,
    database: "ready",
    generatorMode: mode,
    generatorModel: readString(body.generator_model, "generator_model"),
  };
}

export function readDiscoveryQueue(body: unknown): DiscoveryPost[] {
  if (!isRecord(body) || !Array.isArray(body.items)) throw contractError("items");
  return body.items.map(readDiscoveryPost);
}

export function readDiscoveryQueuePage(body: unknown): DiscoveryQueuePage {
  if (!isRecord(body) || !Array.isArray(body.items) || !isRecord(body.counts)) {
    throw contractError("discovery queue page");
  }
  return {
    items: body.items.map(readDiscoveryPost),
    counts: {
      neighbor: readCount(body.counts.neighbor, "neighbor count"),
      search: readCount(body.counts.search, "search count"),
      skipped: readCount(body.counts.skipped, "skipped count"),
      total: readCount(body.counts.total, "total count"),
    },
    nextCursor:
      body.next_cursor === null || body.next_cursor === undefined
        ? null
        : readString(body.next_cursor, "next_cursor"),
  };
}

function readDiscoveryPost(value: unknown): DiscoveryPost {
  if (!isRecord(value)) throw contractError("discovery post");
  const source = value.source;
  const state = value.state;
  if (typeof source !== "string" || !SOURCES.has(source as DiscoverySource)) {
    throw contractError("source");
  }
  if (typeof state !== "string" || !STATES.has(state as DiscoveryState)) {
    throw contractError("state");
  }
  return {
    id: readString(value.id, "id"),
    source: source as DiscoverySource,
    state: state as DiscoveryState,
    sourceUrl: readString(value.source_url, "source_url"),
    title: readString(value.title, "title"),
    publisherName: readNullableString(value.publisher_name, "publisher_name"),
    publisherBlogId: readNullableString(value.publisher_blog_id, "publisher_blog_id"),
    sourceLabel:
      value.source_label === undefined
        ? null
        : readNullableString(value.source_label, "source_label"),
    publishedAt: readNullableString(value.published_at, "published_at"),
    createdAt: readString(value.created_at, "created_at"),
    updatedAt: readString(value.updated_at, "updated_at"),
  };
}

export function readCommentRefinement(body: unknown): CommentRefinement {
  if (!isRecord(body)) throw contractError("comment refinement");
  const provider = body.provider;
  if (typeof provider !== "string" || !PROVIDERS.has(provider as LlmProviderName)) {
    throw contractError("provider");
  }
  return {
    text: readString(body.text, "text"),
    provider: provider as LlmProviderName,
    model: readString(body.model, "model"),
  };
}

function readRecommendationHistoryItem(value: unknown): RecommendationHistoryItem {
  if (!isRecord(value)) throw contractError("recommendation history item");
  const reviewStatus = value.review_status;
  if (typeof reviewStatus !== "string" || !REVIEW_STATUSES.has(reviewStatus as ReviewStatus)) {
    throw contractError("review_status");
  }
  return {
    id: readString(value.id, "id"),
    sourceUrl: readString(value.source_url, "source_url"),
    title: readString(value.title, "title"),
    reviewStatus: reviewStatus as ReviewStatus,
    comment: readNullableString(value.comment, "comment"),
    createdAt: readString(value.created_at, "created_at"),
    updatedAt: readNullableString(value.updated_at, "updated_at"),
    personalizationEligible: readBoolean(
      value.personalization_eligible,
      "personalization_eligible",
    ),
  };
}

export function readBrowserSession(body: unknown): BrowserSession {
  if (!isRecord(body)) throw contractError("session");
  const state = body.state;
  const login = body.login;
  if (typeof state !== "string" || !SESSION_STATES.has(state as BrowserSessionState)) {
    throw contractError("state");
  }
  if (typeof login !== "string" || !LOGIN_STATES.has(login as BrowserLoginState)) {
    throw contractError("login");
  }
  return {
    state: state as BrowserSessionState,
    login: login as BrowserLoginState,
    driver: readString(body.driver, "driver"),
    headless: readBoolean(body.headless, "headless"),
    profileDir: readString(body.profile_dir, "profile_dir"),
    openPages: readCount(body.open_pages, "open_pages"),
    detail: body.detail === undefined ? null : readNullableString(body.detail, "detail"),
  };
}

export function readArticleExtraction(body: unknown): ArticleExtraction {
  if (!isRecord(body)) throw contractError("extraction");
  const kind = body.selector_kind;
  if (typeof kind !== "string" || !SELECTOR_KINDS.has(kind)) throw contractError("selector_kind");
  const preview = body.preview;
  if (typeof preview !== "string") throw contractError("preview");
  return {
    sourceUrl: readString(body.source_url, "source_url"),
    title: readString(body.title, "title"),
    selectorKind: kind as ArticleExtraction["selectorKind"],
    originalLength: readCount(body.original_length, "original_length"),
    transmittedLength: readCount(body.transmitted_length, "transmitted_length"),
    truncated: readBoolean(body.truncated, "truncated"),
    preview,
  };
}

export function readRecommendation(body: unknown): Recommendation {
  if (!isRecord(body)) throw contractError("recommendation");
  const status = body.review_status;
  if (typeof status !== "string" || !REVIEW_STATUSES.has(status as ReviewStatus)) {
    throw contractError("review_status");
  }
  const candidates = body.candidates;
  if (!Array.isArray(candidates) || candidates.length !== 3) throw contractError("candidates");
  const topics = body.topics;
  if (!Array.isArray(topics)) throw contractError("topics");
  const warnings = body.quality_warnings;
  if (!Array.isArray(warnings)) throw contractError("quality_warnings");
  for (const warning of warnings) {
    if (typeof warning !== "string" || !QUALITY_WARNINGS.has(warning)) {
      throw contractError("quality_warnings");
    }
  }
  return {
    id: readString(body.id, "id"),
    sourceUrl: readString(body.source_url, "source_url"),
    title: readString(body.title, "title"),
    summary: readString(body.summary, "summary"),
    topics: topics.map((topic) => readString(topic, "topics")),
    candidates: candidates.map(readCandidate),
    selectedCandidateId: readNullableString(
      body.selected_candidate_id ?? null,
      "selected_candidate_id",
    ),
    editedComment:
      body.edited_comment === undefined || body.edited_comment === null
        ? null
        : readString(body.edited_comment, "edited_comment"),
    reviewStatus: status as ReviewStatus,
    relationshipLevel: readString(
      body.relationship_level,
      "relationship_level",
    ) as Recommendation["relationshipLevel"],
    speechStyle: readString(body.speech_style, "speech_style") as Recommendation["speechStyle"],
    commentLength: readString(
      body.comment_length,
      "comment_length",
    ) as Recommendation["commentLength"],
    commentMood: readString(body.comment_mood, "comment_mood") as Recommendation["commentMood"],
    qualityWarnings: warnings as Recommendation["qualityWarnings"],
  };
}

function readCandidate(value: unknown): CommentCandidate {
  if (!isRecord(value)) throw contractError("candidate");
  const tone = value.tone;
  if (typeof tone !== "string" || !TONES.has(tone as CandidateTone)) throw contractError("tone");
  return {
    id: readString(value.id, "candidate id"),
    tone: tone as CandidateTone,
    comment: readString(value.comment, "comment"),
    referencedDetail: readString(value.referenced_detail, "referenced_detail"),
  };
}

export function readCommentGeneration(body: unknown): CommentGeneration {
  if (!isRecord(body)) throw contractError("generation");
  return {
    attempt: readCount(body.attempt, "attempt"),
    extraction: readArticleExtraction(body.extraction),
    recommendation: readRecommendation(body.recommendation),
    replayed: readBoolean(body.replayed, "replayed"),
  };
}

export function readCommentFanout(body: unknown): CommentFanout {
  if (!isRecord(body) || !Array.isArray(body.items)) throw contractError("fanout generation");
  return {
    attempt: readCount(body.attempt, "attempt"),
    extraction: readArticleExtraction(body.extraction),
    items: body.items.map(readProviderOutcome),
  };
}

function readProviderOutcome(value: unknown): CommentFanout["items"][number] {
  if (!isRecord(value)) throw contractError("provider outcome");
  const provider = value.provider;
  const status = value.status;
  if (typeof provider !== "string" || !PROVIDERS.has(provider as LlmProviderName)) {
    throw contractError("provider");
  }
  if (status !== "succeeded" && status !== "failed" && status !== "indeterminate") {
    throw contractError("provider status");
  }
  return {
    provider: provider as LlmProviderName,
    model: readString(value.model, "model"),
    status,
    resultCode: readNullableString(value.result_code, "result_code"),
    replayed: readBoolean(value.replayed, "replayed"),
    retryAfter: value.retry_after === null ? null : readCount(value.retry_after, "retry_after"),
    recommendation: value.recommendation === null ? null : readRecommendation(value.recommendation),
  };
}

export function readAppSetting(body: unknown): AppSettingRecord {
  if (!isRecord(body)) throw contractError("setting");
  const payload = body.payload;
  if (!isRecord(payload)) throw contractError("payload");
  return {
    kind: readString(body.kind, "kind"),
    schemaVersion: readCount(body.schema_version, "schema_version"),
    payload,
    updatedAt:
      body.updated_at === null || body.updated_at === undefined
        ? null
        : readString(body.updated_at, "updated_at"),
  };
}

export function readEngagementRun(body: unknown): EngagementRun {
  if (!isRecord(body)) throw contractError("run");
  const source = body.source;
  const state = body.state;
  if (!SOURCES.has(source as DiscoverySource)) throw contractError("source");
  if (!RUN_STATES.has(state as EngagementRunState)) throw contractError("state");
  const steps = body.steps;
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 3) throw contractError("steps");
  return {
    id: readString(body.id, "id"),
    approvalId: readString(body.approval_id, "approval_id"),
    discoveryPostId: readString(body.discovery_post_id, "discovery_post_id"),
    recommendationId: readString(body.recommendation_id, "recommendation_id"),
    source: source as DiscoverySource,
    state: state as EngagementRunState,
    steps: steps.map(readEngagementStep),
    createdAt: readString(body.created_at, "created_at"),
    updatedAt: readString(body.updated_at, "updated_at"),
  };
}

export function readAutomationSession(body: unknown): AutomationSession {
  if (!isRecord(body)) throw contractError("session");
  const trigger = body.trigger;
  const state = body.state;
  if (!SESSION_TRIGGERS.has(trigger as SessionTrigger)) throw contractError("trigger");
  if (!BATCH_STATES.has(state as SessionState)) throw contractError("session state");
  const steps = body.approved_steps;
  const sources = body.sources;
  const postIds = body.post_ids;
  if (!Array.isArray(steps) || steps.length === 0) throw contractError("approved_steps");
  if (!Array.isArray(sources) || sources.length === 0) throw contractError("sources");
  return {
    id: readString(body.id, "id"),
    trigger: trigger as SessionTrigger,
    state: state as SessionState,
    approvedSteps: steps.map(readStepName),
    sources: sources.map(readSourceName),
    postIds: postIds === undefined ? [] : readStrings(postIds, "post_ids"),
    maxPosts: readCount(body.max_posts, "max_posts"),
    processedCount: readCount(body.processed_count, "processed_count"),
    abortReason: readNullableString(body.abort_reason ?? null, "abort_reason"),
    createdAt: readString(body.created_at, "created_at"),
    startedAt: readNullableString(body.started_at ?? null, "started_at"),
    finishedAt: readNullableString(body.finished_at ?? null, "finished_at"),
  };
}

function readStepName(value: unknown): EngagementStepName {
  if (typeof value !== "string" || !STEP_NAMES.has(value as EngagementStepName)) {
    throw contractError("step name");
  }
  return value as EngagementStepName;
}

function readSourceName(value: unknown): DiscoverySource {
  if (typeof value !== "string" || !SOURCES.has(value as DiscoverySource)) {
    throw contractError("source");
  }
  return value as DiscoverySource;
}

export function readAutoDiscoverySettings(body: unknown): AutoDiscoverySettings {
  if (!isRecord(body)) throw contractError("discovery settings");
  const status = body.last_status;
  if (!SYNC_HISTORY.has(status as AutoDiscoverySettings["lastStatus"])) {
    throw contractError("last_status");
  }
  const hour = readCount(body.hour, "hour");
  const minute = readCount(body.minute, "minute");
  if (hour > 23 || minute > 59) throw contractError("discovery time");
  return {
    ownBlogId: readText(body.own_blog_id, "own_blog_id"),
    enabled: readBoolean(body.enabled, "enabled"),
    timezone: readString(body.timezone, "timezone"),
    hour,
    minute,
    lastSyncedAt: readNullableString(body.last_synced_at ?? null, "last_synced_at"),
    lastStatus: status as AutoDiscoverySettings["lastStatus"],
    lastDetail: readText(body.last_detail, "last_detail"),
  };
}

export function readDiscoverySyncResult(body: unknown): DiscoverySyncResult {
  if (!isRecord(body)) throw contractError("sync result");
  const status = body.status;
  if (!SYNC_STATES.has(status as DiscoverySyncResult["status"])) throw contractError("status");
  const provider = body.search_provider;
  if (provider !== "naver_open_api" && provider !== "none") {
    throw contractError("search_provider");
  }
  return {
    neighborsAdded: readCount(body.neighbors_added, "neighbors_added"),
    neighborPostsAdded: readCount(body.neighbor_posts_added, "neighbor_posts_added"),
    searchPostsAdded: readCount(body.search_posts_added, "search_posts_added"),
    searchProvider: provider,
    status: status as DiscoverySyncResult["status"],
    detail: readText(body.detail, "detail"),
  };
}

export function readSavedSearch(value: unknown): SavedSearch {
  if (!isRecord(value)) throw contractError("search");
  const terms = value.excluded_terms;
  if (!Array.isArray(terms)) throw contractError("excluded_terms");
  const freshness = readCount(value.freshness_days, "freshness_days");
  if (freshness < 1 || freshness > 90) throw contractError("freshness_days");
  return {
    id: readString(value.id, "id"),
    query: readString(value.query, "query"),
    excludedTerms: terms.map((term) => readString(term, "excluded term")),
    freshnessDays: freshness,
    enabled: readBoolean(value.enabled, "enabled"),
    createdAt: readString(value.created_at, "created_at"),
  };
}

export function readDiscoveryNeighbor(value: unknown): DiscoveryNeighbor {
  if (!isRecord(value)) throw contractError("neighbor");
  const feedStatus = value.feed_status;
  if (!NEIGHBOR_FEED_STATUSES.has(feedStatus as string)) throw contractError("feed_status");
  return {
    id: readString(value.id, "neighbor id"),
    name: readString(value.name, "neighbor name"),
    blogUrl: readString(value.blog_url, "neighbor blog_url"),
    blogId: readString(value.blog_id, "neighbor blog_id"),
    enabled: readBoolean(value.enabled, "neighbor enabled"),
    feedStatus: feedStatus as DiscoveryNeighbor["feedStatus"],
    lastCheckedAt: readNullableString(value.last_checked_at ?? null, "last_checked_at"),
    createdAt: readString(value.created_at, "neighbor created_at"),
  };
}

export function readDiscoverySearchRefresh(body: unknown): DiscoverySearchRefresh {
  if (!isRecord(body) || body.provider !== "naver_open_api") {
    throw contractError("search refresh");
  }
  return {
    importedCount: readCount(body.imported_count, "imported_count"),
    provider: "naver_open_api",
    detail: readText(body.detail, "detail"),
  };
}

export function readDigestSettings(body: unknown): DigestSettings {
  if (!isRecord(body)) throw contractError("digest settings");
  const hour = readCount(body.hour, "digest hour");
  const minute = readCount(body.minute, "digest minute");
  if (hour > 23 || minute > 59) throw contractError("digest time");
  return {
    timezone: readString(body.timezone, "digest timezone"),
    hour,
    minute,
    emailEnabled: readBoolean(body.email_enabled, "email_enabled"),
    smtpConfigured: readBoolean(body.smtp_configured, "smtp_configured"),
  };
}

export function readScheduleStatus(body: unknown): ScheduleStatus {
  if (!isRecord(body)) throw contractError("schedule");
  const mode = body.mode;
  if (!SESSION_TRIGGERS.has(mode as SessionTrigger)) throw contractError("mode");
  const hour = readCount(body.hour, "hour");
  const minute = readCount(body.minute, "minute");
  if (hour > 23 || minute > 59) throw contractError("schedule time");
  return {
    mode: mode as ScheduleStatus["mode"],
    hour,
    minute,
    maxPosts: readCount(body.max_posts, "max_posts"),
    enabled: readBoolean(body.enabled, "enabled"),
    blockingReason: readNullableString(body.blocking_reason ?? null, "blocking_reason"),
  };
}

export function readSafetyStatus(body: unknown): SafetyStatus {
  if (!isRecord(body) || !Array.isArray(body.actions) || !Array.isArray(body.allowed_hours)) {
    throw contractError("safety status");
  }
  const allowedHours = body.allowed_hours.map((value) => readCount(value, "allowed_hours"));
  if (allowedHours.some((hour) => hour > 23)) throw contractError("allowed_hours");
  return {
    localDate: readString(body.local_date, "local_date"),
    allowedNow: readBoolean(body.allowed_now, "allowed_now"),
    blockingReason: readNullableString(body.blocking_reason ?? null, "blocking_reason"),
    allowedHours,
    minIntervalSeconds: readCount(body.min_interval_seconds, "min_interval_seconds"),
    consecutiveFailures: readCount(body.consecutive_failures, "consecutive_failures"),
    maxConsecutiveFailures: readCount(body.max_consecutive_failures, "max_consecutive_failures"),
    actions: body.actions.map(readSafetyActionStatus),
  };
}

function readSafetyActionStatus(value: unknown): SafetyStatus["actions"][number] {
  if (!isRecord(value)) throw contractError("safety action");
  const name = readStepName(value.name);
  const cap = readCount(value.cap, "cap");
  const used = readCount(value.used, "used");
  const remaining = readCount(value.remaining, "remaining");
  if (remaining !== Math.max(cap - used, 0)) throw contractError("remaining");
  return { name, cap, used, remaining };
}

function readEngagementStep(value: unknown): EngagementStep {
  if (!isRecord(value)) throw contractError("step");
  const name = value.name;
  const state = value.state;
  if (!STEP_NAMES.has(name as EngagementStepName)) throw contractError("step name");
  if (!STEP_STATES.has(state as EngagementStepState)) throw contractError("step state");
  const resultCode = readNullableString(value.result_code ?? null, "result_code");
  if (resultCode !== null && !RESULT_CODE.test(resultCode)) throw contractError("result_code");
  const position = readCount(value.position, "position");
  if (position > 2) throw contractError("position");
  return {
    name: name as EngagementStepName,
    position,
    state: state as EngagementStepState,
    resultCode,
    updatedAt: readString(value.updated_at, "updated_at"),
  };
}

function readItems<T>(body: unknown, read: (value: unknown) => T): T[] {
  if (!isRecord(body) || !Array.isArray(body.items)) throw contractError("items");
  return body.items.map(read);
}

export function readLlmProvider(value: unknown): LlmProviderStatus {
  if (!isRecord(value)) throw contractError("provider");
  const provider = value.provider;
  if (!PROVIDERS.has(provider as LlmProviderName)) throw contractError("provider");
  return {
    provider: provider as LlmProviderName,
    configured: readBoolean(value.configured, "configured"),
    model: readString(value.model, "model"),
  };
}

export function readBlogCategory(value: unknown): BlogCategory {
  if (!isRecord(value)) throw contractError("category");
  return {
    categoryNo: readCount(value.category_no, "category_no"),
    name: readString(value.name, "name"),
    postCount: value.post_count === null ? null : readCount(value.post_count, "post_count"),
    syncedAt: value.synced_at === null ? null : readString(value.synced_at, "synced_at"),
  };
}

function readBlock(value: unknown): BodyBlock {
  if (!isRecord(value)) throw contractError("block");
  const kind = value.type;
  if (!BLOCK_KINDS.has(kind as string)) throw contractError("block type");
  const block: BodyBlock = { type: kind as BodyBlock["type"] };
  if (typeof value.text === "string") block.text = value.text;
  if (typeof value.image_id === "string") block.image_id = value.image_id;
  if (typeof value.caption === "string") block.caption = value.caption;
  return block;
}

export function readPostDraft(body: unknown): PostDraft {
  if (!isRecord(body)) throw contractError("draft");
  const status = body.status;
  if (!DRAFT_STATUSES.has(status as string)) throw contractError("status");
  if (!Array.isArray(body.revisions) || !Array.isArray(body.images) || !Array.isArray(body.tags)) {
    throw contractError("draft collections");
  }
  return {
    id: readString(body.id, "id"),
    title: readString(body.title, "title"),
    categoryNo: body.category_no === null ? null : readCount(body.category_no, "category_no"),
    status: status as PostDraft["status"],
    useImageVision: readBoolean(body.use_image_vision, "use_image_vision"),
    seedText: typeof body.seed_text === "string" ? body.seed_text : "",
    revisions: body.revisions.map((value) => {
      if (!isRecord(value)) throw contractError("revision");
      const kind = value.kind;
      if (!REVISION_KINDS.has(kind as string)) throw contractError("revision kind");
      if (!Array.isArray(value.blocks)) throw contractError("blocks");
      return {
        id: readString(value.id, "id"),
        roundNo: readCount(value.round_no, "round_no"),
        kind: kind as PostDraft["revisions"][number]["kind"],
        provider: value.provider === null ? null : readString(value.provider, "provider"),
        model: value.model === null ? null : readString(value.model, "model"),
        title: readString(value.title, "title"),
        summary: typeof value.summary === "string" ? value.summary : "",
        isActive: readBoolean(value.is_active, "is_active"),
        blocks: value.blocks.map(readBlock),
        createdAt: value.created_at === null ? null : readString(value.created_at, "created_at"),
      };
    }),
    images: body.images.map((value) => {
      if (!isRecord(value)) throw contractError("image");
      return {
        id: readString(value.id, "id"),
        ordinal: readCount(value.ordinal, "ordinal"),
        originalFilename: readString(value.original_filename, "original_filename"),
        byteSize: readCount(value.byte_size, "byte_size"),
        mime: readString(value.mime, "mime"),
        altText: typeof value.alt_text === "string" ? value.alt_text : "",
      };
    }),
    tags: body.tags.map((value) => {
      if (!isRecord(value)) throw contractError("tag");
      const source = value.source;
      if (!TAG_SOURCES.has(source as string)) throw contractError("tag source");
      return {
        tag: readString(value.tag, "tag"),
        ordinal: readCount(value.ordinal, "ordinal"),
        source: source as PostDraft["tags"][number]["source"],
        selected: readBoolean(value.selected, "selected"),
      };
    }),
    createdAt: body.created_at === null ? null : readString(body.created_at, "created_at"),
    updatedAt: body.updated_at === null ? null : readString(body.updated_at, "updated_at"),
  };
}

export function readPublishRun(body: unknown): PublishRun {
  if (!isRecord(body)) throw contractError("run");
  const state = body.state;
  if (!RUN_STATES.has(state as EngagementRunState)) throw contractError("state");
  if (!Array.isArray(body.steps) || body.steps.length !== 5) throw contractError("steps");
  return {
    id: readString(body.id, "id"),
    draftId: readString(body.draft_id, "draft_id"),
    revisionId: readString(body.revision_id, "revision_id"),
    state: state as EngagementRunState,
    resultCode: body.result_code === null ? null : readString(body.result_code, "result_code"),
    steps: body.steps.map(readPublishStep),
    createdAt: body.created_at === null ? null : readString(body.created_at, "created_at"),
    updatedAt: body.updated_at === null ? null : readString(body.updated_at, "updated_at"),
  };
}

function readPublishStep(value: unknown): PublishStep {
  if (!isRecord(value)) throw contractError("step");
  const name = value.name;
  const state = value.state;
  if (!PUBLISH_STEPS.has(name as PublishStepName)) throw contractError("step name");
  if (!STEP_STATES.has(state as EngagementStepState)) throw contractError("step state");
  return {
    name: name as PublishStepName,
    position: readCount(value.position, "position"),
    state: state as EngagementStepState,
    resultCode: value.result_code === null ? null : readString(value.result_code, "result_code"),
    updatedAt: value.updated_at === null ? null : readString(value.updated_at, "updated_at"),
  };
}
