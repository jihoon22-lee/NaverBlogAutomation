import type {
  ApiResult,
  AutomaticDiscoverySettings,
  AutomaticDiscoverySyncResult,
  DiscoverySearchRefreshResult,
  CandidateTone,
  CommentLength,
  CommentMood,
  PersonalizationMode,
  CommentCandidate,
  CreateRecommendationRequest,
  ProblemDetails,
  QualityWarning,
  Recommendation,
  RecommendationHistoryItem,
  RelationshipLevel,
  ReviewRecommendationRequest,
  ReviewStatus,
  ServiceStatus,
  SpeechStyle,
  DigestSettings,
  DiscoveryNeighbor,
  DiscoveryPost,
  DiscoverySearch,
  DiscoverySource,
  DiscoveryState,
  EngagementRun,
  EngagementStepName,
  EngagementStepState,
} from "./types";
import { LOCAL_API_ORIGIN } from "../config";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROBLEM_CODE = /^[a-z][a-z0-9_]*$/u;
const TONES = new Set<CandidateTone>(["curious", "supportive", "warm"]);
const REVIEW_STATUSES = new Set<ReviewStatus>(["approved", "completed", "drafted"]);
const RELATIONSHIP_LEVELS = new Set<RelationshipLevel>(["close", "friendly", "new", "polite"]);
const SPEECH_STYLES = new Set<SpeechStyle>(["banmal", "honorific"]);
const COMMENT_LENGTHS = new Set<CommentLength>(["long", "medium", "short"]);
const COMMENT_MOODS = new Set<CommentMood>(["calm", "lively", "warm"]);
const PERSONALIZATION_MODES = new Set<PersonalizationMode>(["completed_examples", "off"]);
const QUALITY_WARNINGS = new Set<QualityWarning>([
  "candidate_roles_blurred",
  "candidates_too_similar",
  "length_target_missed",
]);
const ENGAGEMENT_STEP_NAMES = new Set<EngagementStepName>(["like", "comment", "mutual_neighbor"]);
const ENGAGEMENT_STEP_STATES = new Set<EngagementStepState>([
  "pending",
  "running",
  "succeeded",
  "skipped",
  "failed",
  "unconfirmed",
]);

type Fetch = typeof fetch;

export class ApiClientError extends Error {
  readonly problem: ProblemDetails | null;
  readonly replayed: boolean;
  readonly retryAfterSeconds: number | null;
  readonly status: number | null;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      problem?: ProblemDetails | null;
      replayed?: boolean;
      retryAfterSeconds?: number | null;
      status?: number | null;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiClientError";
    this.problem = options.problem ?? null;
    this.replayed = options.replayed ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.status = options.status ?? null;
  }
}

export class LocalApiClient {
  readonly #fetch: Fetch;

  constructor(fetchImplementation: Fetch = fetch) {
    this.#fetch = fetchImplementation;
  }

  async health(signal?: AbortSignal): Promise<void> {
    const response = await this.#request("/health", { method: "GET", ...withSignal(signal) });
    if (response.status !== 200) {
      throw invalidResponse(response.status);
    }
    const value = await readJson(response);
    if (!isRecord(value) || value.status !== "ok" || !onlyKeys(value, ["status"])) {
      throw invalidResponse(response.status);
    }
  }

  async status(signal?: AbortSignal): Promise<ServiceStatus> {
    const response = await this.#request("/api/v1/status", {
      method: "GET",
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    const parsed = parseServiceStatus(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async listRecommendations(
    limit = 20,
    signal?: AbortSignal,
  ): Promise<readonly RecommendationHistoryItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError("History limit must be between 1 and 50");
    }
    const response = await this.#request(`/api/v1/recommendations?limit=${limit}`, {
      method: "GET",
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    const parsed = parseRecommendationHistory(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async deleteRecommendation(id: string, signal?: AbortSignal): Promise<void> {
    const response = await this.#request(`/api/v1/recommendations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      ...withSignal(signal),
    });
    if (response.status !== 204) throw invalidResponse(response.status);
  }

  async clearPersonalizationExamples(signal?: AbortSignal): Promise<void> {
    const response = await this.#request("/api/v1/personalization/examples", {
      method: "DELETE",
      ...withSignal(signal),
    });
    if (response.status !== 204) throw invalidResponse(response.status);
  }

  async listDiscoveryNeighbors(signal?: AbortSignal): Promise<readonly DiscoveryNeighbor[]> {
    const response = await this.#request("/api/v1/discovery/neighbors", {
      method: "GET",
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    return discoveryNeighbors(await readJson(response));
  }

  async saveDiscoveryNeighbor(
    value: { name: string; blogUrl: string; blogId: string; enabled?: boolean },
    signal?: AbortSignal,
  ): Promise<DiscoveryNeighbor> {
    const response = await this.#request("/api/v1/discovery/neighbors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: value.name,
        blog_url: value.blogUrl,
        blog_id: value.blogId,
        enabled: value.enabled ?? true,
      }),
      ...withSignal(signal),
    });
    if (response.status !== 201) throw invalidResponse(response.status);
    const parsed = parseDiscoveryNeighbor(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async listDiscoverySearches(signal?: AbortSignal): Promise<readonly DiscoverySearch[]> {
    const response = await this.#request("/api/v1/discovery/searches", {
      method: "GET",
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    return discoverySearches(await readJson(response));
  }

  async saveDiscoverySearch(
    value: {
      query: string;
      excludedTerms?: readonly string[];
      freshnessDays?: number;
      enabled?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<DiscoverySearch> {
    const response = await this.#request("/api/v1/discovery/searches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: value.query,
        excluded_terms: value.excludedTerms ?? [],
        freshness_days: value.freshnessDays ?? 14,
        enabled: value.enabled ?? true,
      }),
      ...withSignal(signal),
    });
    if (response.status !== 201) throw invalidResponse(response.status);
    const parsed = parseDiscoverySearch(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async deleteDiscoverySearch(id: string, signal?: AbortSignal): Promise<void> {
    const response = await this.#request(`/api/v1/discovery/searches/${encodeURIComponent(id)}`, {
      method: "DELETE",
      ...withSignal(signal),
    });
    if (response.status !== 204) throw invalidResponse(response.status);
  }

  async importDiscoveryPosts(
    source: DiscoverySource,
    ownerId: string,
    posts: readonly {
      sourceUrl: string;
      title: string;
      publisherName?: string | null;
      publisherBlogId?: string | null;
      publishedAt?: string | null;
    }[],
    signal?: AbortSignal,
  ): Promise<number> {
    const payload = {
      source,
      ...(source === "neighbor" ? { neighbor_id: ownerId } : { search_id: ownerId }),
      posts: posts.slice(0, 50).map((post) => ({
        source_url: post.sourceUrl,
        title: post.title,
        publisher_name: post.publisherName ?? null,
        publisher_blog_id: post.publisherBlogId ?? null,
        published_at: post.publishedAt ?? null,
      })),
    };
    const response = await this.#request("/api/v1/discovery/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    const value = await readJson(response);
    if (
      !isRecord(value) ||
      !isInteger(value.imported_count) ||
      value.imported_count < 0 ||
      value.imported_count > 50 ||
      !onlyKeys(value, ["imported_count"])
    )
      throw invalidResponse(response.status);
    return value.imported_count;
  }

  async listDiscoveryQueue(
    source: DiscoverySource,
    signal?: AbortSignal,
  ): Promise<readonly DiscoveryPost[]> {
    const response = await this.#request(`/api/v1/discovery/queue?source=${source}`, {
      method: "GET",
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    return discoveryPosts(await readJson(response));
  }

  async updateDiscoveryPostState(
    id: string,
    state: DiscoveryState,
    signal?: AbortSignal,
  ): Promise<DiscoveryPost> {
    const response = await this.#request(`/api/v1/discovery/queue/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    const parsed = parseDiscoveryPost(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async refreshDiscoverySearch(
    id: string,
    signal?: AbortSignal,
  ): Promise<DiscoverySearchRefreshResult> {
    const response = await this.#request(
      `/api/v1/discovery/searches/${encodeURIComponent(id)}/refresh`,
      { method: "POST", ...withSignal(signal) },
    );
    if (response.status !== 200) throw invalidResponse(response.status);
    const parsed = parseDiscoverySearchRefresh(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async refreshDiscoveryNeighbors(signal?: AbortSignal): Promise<number> {
    const response = await this.#request("/api/v1/discovery/refresh-neighbors", {
      method: "POST",
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    const value = await readJson(response);
    if (
      !isRecord(value) ||
      !isInteger(value.imported_count) ||
      !onlyKeys(value, ["imported_count"])
    )
      throw invalidResponse(response.status);
    return value.imported_count;
  }

  async automaticDiscoverySettings(signal?: AbortSignal): Promise<AutomaticDiscoverySettings> {
    const response = await this.#request("/api/v1/discovery/automation-settings", {
      method: "GET",
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    const parsed = parseAutomaticDiscoverySettings(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async saveAutomaticDiscoverySettings(
    settings: Omit<AutomaticDiscoverySettings, "lastSyncedAt" | "lastStatus" | "lastDetail">,
    signal?: AbortSignal,
  ): Promise<AutomaticDiscoverySettings> {
    const response = await this.#request("/api/v1/discovery/automation-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        own_blog_id: settings.ownBlogId,
        enabled: settings.enabled,
        timezone: settings.timezone,
        hour: settings.hour,
        minute: settings.minute,
      }),
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    const parsed = parseAutomaticDiscoverySettings(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async syncAutomaticDiscovery(signal?: AbortSignal): Promise<AutomaticDiscoverySyncResult> {
    const response = await this.#request("/api/v1/discovery/sync", {
      method: "POST",
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    const parsed = parseAutomaticDiscoverySync(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async digestSettings(signal?: AbortSignal): Promise<DigestSettings> {
    const response = await this.#request("/api/v1/discovery/digest-settings", {
      method: "GET",
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    const parsed = parseDigestSettings(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async saveDigestSettings(
    settings: Omit<DigestSettings, "smtpConfigured">,
    signal?: AbortSignal,
  ): Promise<DigestSettings> {
    const response = await this.#request("/api/v1/discovery/digest-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timezone: settings.timezone,
        hour: settings.hour,
        minute: settings.minute,
        email_enabled: settings.emailEnabled,
      }),
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    const parsed = parseDigestSettings(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async listEngagementRuns(limit = 20, signal?: AbortSignal): Promise<readonly EngagementRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError("Engagement history limit must be between 1 and 50");
    }
    const response = await this.#request(`/api/v1/engagement-runs?limit=${limit}`, {
      method: "GET",
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    return engagementRuns(await readJson(response));
  }

  async startEngagementRun(
    value: { approvalId: string; discoveryPostId: string; recommendationId: string },
    signal?: AbortSignal,
  ): Promise<ApiResult<EngagementRun>> {
    const response = await this.#request("/api/v1/engagement-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approval_id: value.approvalId,
        discovery_post_id: value.discoveryPostId,
        recommendation_id: value.recommendationId,
      }),
      ...withSignal(signal),
    });
    if (response.status !== 200 && response.status !== 201) {
      throw invalidResponse(response.status);
    }
    const parsed = parseEngagementRun(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return {
      replayed: readBooleanHeader(response, "Engagement-Replayed"),
      value: parsed,
    };
  }

  async completeEngagementManually(
    runId: string,
    completedSteps: readonly EngagementStepName[],
    signal?: AbortSignal,
  ): Promise<EngagementRun> {
    const response = await this.#request(
      `/api/v1/engagement-runs/${encodeURIComponent(runId)}/manual-completion`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          completed_steps: completedSteps,
        }),
        ...withSignal(signal),
      },
    );
    if (response.status !== 200) throw invalidResponse(response.status);
    const parsed = parseEngagementRun(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async getEngagementRun(id: string, signal?: AbortSignal): Promise<EngagementRun> {
    const response = await this.#request(`/api/v1/engagement-runs/${encodeURIComponent(id)}`, {
      method: "GET",
      ...withSignal(signal),
    });
    if (response.status !== 200) throw invalidResponse(response.status);
    const parsed = parseEngagementRun(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async getEngagementRunForPost(
    postId: string,
    signal?: AbortSignal,
  ): Promise<EngagementRun | null> {
    try {
      const response = await this.#request(
        `/api/v1/engagement-runs/by-post/${encodeURIComponent(postId)}`,
        { method: "GET", ...withSignal(signal) },
      );
      if (response.status !== 200) throw invalidResponse(response.status);
      const parsed = parseEngagementRun(await readJson(response));
      if (parsed === null) throw invalidResponse(response.status);
      return parsed;
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        error.status === 404 &&
        error.problem?.code === "engagement_run_not_found"
      ) {
        return null;
      }
      throw error;
    }
  }

  async transitionEngagementStep(
    runId: string,
    stepName: EngagementStepName,
    value:
      | { state: "running"; resultCode?: null }
      | {
          state: Exclude<EngagementStepState, "pending" | "running">;
          resultCode: string;
        },
    signal?: AbortSignal,
  ): Promise<EngagementRun> {
    const response = await this.#request(
      `/api/v1/engagement-runs/${encodeURIComponent(runId)}/steps/${stepName}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: value.state,
          result_code: value.resultCode ?? null,
        }),
        ...withSignal(signal),
      },
    );
    if (response.status !== 200) throw invalidResponse(response.status);
    const parsed = parseEngagementRun(await readJson(response));
    if (parsed === null) throw invalidResponse(response.status);
    return parsed;
  }

  async createRecommendation(
    payload: CreateRecommendationRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<Recommendation>> {
    const response = await this.#request("/api/v1/recommendations", {
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      method: "POST",
      ...withSignal(signal),
    });
    if (response.status !== 200 && response.status !== 201) {
      throw invalidResponse(response.status);
    }
    return {
      replayed: readBooleanHeader(response, "Idempotency-Replayed"),
      value: await recommendation(response),
    };
  }

  async getRecommendation(id: string, signal?: AbortSignal): Promise<Recommendation> {
    const response = await this.#request(`/api/v1/recommendations/${encodeURIComponent(id)}`, {
      method: "GET",
      ...withSignal(signal),
    });
    if (response.status !== 200) {
      throw invalidResponse(response.status);
    }
    return recommendation(response);
  }

  async reviewRecommendation(
    id: string,
    payload: ReviewRecommendationRequest,
    signal?: AbortSignal,
  ): Promise<Recommendation> {
    const response = await this.#request(`/api/v1/recommendations/${encodeURIComponent(id)}`, {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      ...withSignal(signal),
    });
    if (response.status !== 200) {
      throw invalidResponse(response.status);
    }
    return recommendation(response);
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch.call(globalThis, `${LOCAL_API_ORIGIN}${path}`, {
        ...init,
        cache: "no-store",
        credentials: "omit",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new ApiClientError("로컬 API에 연결하지 못했습니다.", { cause: error });
    }
    if (response.ok) {
      return response;
    }
    const replayed = readBooleanHeader(response, "Idempotency-Replayed");
    const retryAfterSeconds = readRetryAfter(response);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/problem+json") {
      throw new ApiClientError("로컬 API가 올바르지 않은 오류 응답을 반환했습니다.", {
        replayed,
        retryAfterSeconds,
        status: response.status,
      });
    }
    const value = await readJson(response);
    const problem = parseProblem(value);
    if (problem === null || problem.status !== response.status) {
      throw invalidResponse(response.status, replayed, retryAfterSeconds);
    }
    throw new ApiClientError(problem.detail, {
      problem,
      replayed,
      retryAfterSeconds,
      status: response.status,
    });
  }
}

function invalidResponse(
  status: number,
  replayed = false,
  retryAfterSeconds: number | null = null,
): ApiClientError {
  return new ApiClientError("로컬 API 응답 형식을 확인할 수 없습니다.", {
    replayed,
    retryAfterSeconds,
    status,
  });
}

function withSignal(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new ApiClientError("로컬 API가 JSON이 아닌 응답을 반환했습니다.", {
      cause: error,
      status: response.status,
    });
  }
}

function readBooleanHeader(response: Response, name: string): boolean {
  return response.headers.get(name)?.toLowerCase() === "true";
}

function readRetryAfter(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (value === null || !/^\d+$/u.test(value)) {
    return null;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= maximum
    ? value
    : null;
}

function nullableString(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
): string | null | undefined {
  const value = record[key];
  if (value === null || value === undefined) {
    return value;
  }
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= maximum
    ? value
    : undefined;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function discoveryNeighbors(value: unknown): readonly DiscoveryNeighbor[] {
  if (!isRecord(value) || !onlyKeys(value, ["items"]) || !Array.isArray(value.items)) {
    throw new ApiClientError("로컬 API 응답 형식을 확인할 수 없습니다.");
  }
  const items = value.items.map(parseDiscoveryNeighbor);
  if (items.some((item) => item === null))
    throw new ApiClientError("로컬 API 응답 형식을 확인할 수 없습니다.");
  return items as DiscoveryNeighbor[];
}

function parseDiscoveryNeighbor(value: unknown): DiscoveryNeighbor | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "id",
      "name",
      "blog_url",
      "blog_id",
      "enabled",
      "feed_status",
      "last_checked_at",
      "created_at",
    ])
  )
    return null;
  const id = requiredString(value, "id", 36);
  const name = requiredString(value, "name", 120);
  const blogUrl = requiredString(value, "blog_url", 2_048);
  const blogId = requiredString(value, "blog_id", 100);
  const lastCheckedAt = nullableString(value, "last_checked_at", 100);
  const createdAt = requiredString(value, "created_at", 100);
  const feedStatus = value.feed_status;
  if (
    id === null ||
    !UUID.test(id) ||
    name === null ||
    blogUrl === null ||
    blogId === null ||
    lastCheckedAt === undefined ||
    createdAt === null ||
    Number.isNaN(Date.parse(createdAt)) ||
    (lastCheckedAt !== null && Number.isNaN(Date.parse(lastCheckedAt))) ||
    typeof value.enabled !== "boolean" ||
    !["ready", "unavailable", "unknown"].includes(String(feedStatus))
  )
    return null;
  return {
    id,
    name,
    blogUrl,
    blogId,
    enabled: value.enabled,
    feedStatus: feedStatus as DiscoveryNeighbor["feedStatus"],
    lastCheckedAt,
    createdAt,
  };
}

function discoverySearches(value: unknown): readonly DiscoverySearch[] {
  if (!isRecord(value) || !onlyKeys(value, ["items"]) || !Array.isArray(value.items))
    throw new ApiClientError("로컬 API 응답 형식을 확인할 수 없습니다.");
  const items = value.items.map(parseDiscoverySearch);
  if (items.some((item) => item === null))
    throw new ApiClientError("로컬 API 응답 형식을 확인할 수 없습니다.");
  return items as DiscoverySearch[];
}

function parseDiscoverySearch(value: unknown): DiscoverySearch | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["id", "query", "excluded_terms", "freshness_days", "enabled", "created_at"])
  )
    return null;
  const id = requiredString(value, "id", 36);
  const query = requiredString(value, "query", 120);
  const createdAt = requiredString(value, "created_at", 100);
  if (
    id === null ||
    !UUID.test(id) ||
    query === null ||
    createdAt === null ||
    Number.isNaN(Date.parse(createdAt)) ||
    !Array.isArray(value.excluded_terms) ||
    !value.excluded_terms.every(
      (term) => typeof term === "string" && term.length > 0 && Array.from(term).length <= 60,
    ) ||
    !isInteger(value.freshness_days) ||
    value.freshness_days < 1 ||
    value.freshness_days > 90 ||
    typeof value.enabled !== "boolean"
  )
    return null;
  return {
    id,
    query,
    excludedTerms: value.excluded_terms as string[],
    freshnessDays: value.freshness_days,
    enabled: value.enabled,
    createdAt,
  };
}

function discoveryPosts(value: unknown): readonly DiscoveryPost[] {
  if (!isRecord(value) || !onlyKeys(value, ["items"]) || !Array.isArray(value.items))
    throw new ApiClientError("로컬 API 응답 형식을 확인할 수 없습니다.");
  const items = value.items.map(parseDiscoveryPost);
  if (items.some((item) => item === null))
    throw new ApiClientError("로컬 API 응답 형식을 확인할 수 없습니다.");
  return items as DiscoveryPost[];
}

function parseDiscoveryPost(value: unknown): DiscoveryPost | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "id",
      "source",
      "state",
      "source_url",
      "title",
      "publisher_name",
      "publisher_blog_id",
      "published_at",
      "neighbor_id",
      "search_id",
      "created_at",
      "updated_at",
    ])
  )
    return null;
  const id = requiredString(value, "id", 36);
  const sourceUrl = requiredString(value, "source_url", 2_048);
  const title = requiredString(value, "title", 300);
  const publisherName = nullableString(value, "publisher_name", 120);
  const publisherBlogId = nullableString(value, "publisher_blog_id", 100);
  const publishedAt = nullableString(value, "published_at", 100);
  const neighborId = nullableString(value, "neighbor_id", 36);
  const searchId = nullableString(value, "search_id", 36);
  const createdAt = requiredString(value, "created_at", 100);
  const updatedAt = requiredString(value, "updated_at", 100);
  if (
    id === null ||
    !UUID.test(id) ||
    sourceUrl === null ||
    title === null ||
    publisherName === undefined ||
    publisherBlogId === undefined ||
    publishedAt === undefined ||
    neighborId === undefined ||
    searchId === undefined ||
    createdAt === null ||
    updatedAt === null ||
    Number.isNaN(Date.parse(createdAt)) ||
    Number.isNaN(Date.parse(updatedAt)) ||
    (publishedAt !== null && Number.isNaN(Date.parse(publishedAt))) ||
    (neighborId !== null && !UUID.test(neighborId)) ||
    (searchId !== null && !UUID.test(searchId)) ||
    (value.source !== "neighbor" && value.source !== "search") ||
    !["queued", "opened", "completed", "skipped", "unavailable"].includes(String(value.state))
  )
    return null;
  return {
    id,
    source: value.source,
    state: value.state as DiscoveryState,
    sourceUrl,
    title,
    publisherName,
    publisherBlogId,
    publishedAt,
    neighborId,
    searchId,
    createdAt,
    updatedAt,
  };
}

function engagementRuns(value: unknown): readonly EngagementRun[] {
  if (!isRecord(value) || !onlyKeys(value, ["items"]) || !Array.isArray(value.items)) {
    throw new ApiClientError("로컬 API 응답 형식을 확인할 수 없습니다.");
  }
  const items = value.items.map(parseEngagementRun);
  if (items.some((item) => item === null)) {
    throw new ApiClientError("로컬 API 응답 형식을 확인할 수 없습니다.");
  }
  return items as EngagementRun[];
}

function parseEngagementRun(value: unknown): EngagementRun | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "id",
      "approval_id",
      "discovery_post_id",
      "recommendation_id",
      "source",
      "state",
      "steps",
      "created_at",
      "updated_at",
    ]) ||
    !Array.isArray(value.steps) ||
    value.steps.length < 2 ||
    value.steps.length > 3
  ) {
    return null;
  }
  const ids = ["id", "approval_id", "discovery_post_id", "recommendation_id"].map((key) =>
    requiredString(value, key, 36),
  );
  const createdAt = requiredString(value, "created_at", 100);
  const updatedAt = requiredString(value, "updated_at", 100);
  const steps = value.steps.map(parseEngagementStep);
  if (
    ids.some((id) => id === null || !UUID.test(id)) ||
    createdAt === null ||
    updatedAt === null ||
    Number.isNaN(Date.parse(createdAt)) ||
    Number.isNaN(Date.parse(updatedAt)) ||
    (value.source !== "neighbor" && value.source !== "search") ||
    !["running", "succeeded", "failed", "unconfirmed"].includes(String(value.state)) ||
    steps.some((step) => step === null) ||
    !validEngagementStepSequence(value.source, steps)
  ) {
    return null;
  }
  const [id, approvalId, discoveryPostId, recommendationId] = ids as [
    string,
    string,
    string,
    string,
  ];
  return {
    id,
    approvalId,
    discoveryPostId,
    recommendationId,
    source: value.source,
    state: value.state as EngagementRun["state"],
    steps: steps as EngagementRun["steps"],
    createdAt,
    updatedAt,
  };
}

function parseEngagementStep(value: unknown): EngagementRun["steps"][number] | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["name", "position", "state", "result_code", "updated_at"])
  ) {
    return null;
  }
  const name = value.name;
  const state = value.state;
  const updatedAt = requiredString(value, "updated_at", 100);
  const resultCode = value.result_code;
  const terminal = ["succeeded", "skipped", "failed", "unconfirmed"].includes(String(state));
  if (
    typeof name !== "string" ||
    !ENGAGEMENT_STEP_NAMES.has(name as EngagementStepName) ||
    typeof state !== "string" ||
    !ENGAGEMENT_STEP_STATES.has(state as EngagementStepState) ||
    !isInteger(value.position) ||
    value.position < 0 ||
    value.position > 2 ||
    updatedAt === null ||
    Number.isNaN(Date.parse(updatedAt)) ||
    (terminal
      ? typeof resultCode !== "string" || !PROBLEM_CODE.test(resultCode)
      : resultCode !== null)
  ) {
    return null;
  }
  return {
    name: name as EngagementStepName,
    position: value.position,
    state: state as EngagementStepState,
    resultCode: resultCode as string | null,
    updatedAt,
  };
}

function validEngagementStepSequence(
  source: unknown,
  steps: readonly (EngagementRun["steps"][number] | null)[],
): boolean {
  const expected =
    source === "neighbor" ? ["like", "comment"] : ["like", "comment", "mutual_neighbor"];
  return (
    steps.length === expected.length &&
    steps.every(
      (step, position) =>
        step !== null && step.name === expected[position] && step.position === position,
    )
  );
}

function parseDigestSettings(value: unknown): DigestSettings | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["timezone", "hour", "minute", "email_enabled", "smtp_configured"])
  )
    return null;
  const timezone = requiredString(value, "timezone", 64);
  if (
    timezone === null ||
    !isInteger(value.hour) ||
    !isInteger(value.minute) ||
    value.hour < 0 ||
    value.hour > 23 ||
    value.minute < 0 ||
    value.minute > 59 ||
    typeof value.email_enabled !== "boolean" ||
    typeof value.smtp_configured !== "boolean"
  )
    return null;
  return {
    timezone,
    hour: value.hour,
    minute: value.minute,
    emailEnabled: value.email_enabled,
    smtpConfigured: value.smtp_configured,
  };
}

function parseAutomaticDiscoverySettings(value: unknown): AutomaticDiscoverySettings | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "own_blog_id",
      "enabled",
      "timezone",
      "hour",
      "minute",
      "last_synced_at",
      "last_status",
      "last_detail",
    ])
  )
    return null;
  const ownBlogId =
    typeof value.own_blog_id === "string" && value.own_blog_id.length <= 100
      ? value.own_blog_id
      : null;
  const timezone = requiredString(value, "timezone", 64);
  const lastSyncedAt = nullableString(value, "last_synced_at", 100);
  const lastDetail =
    typeof value.last_detail === "string" && value.last_detail.length <= 300
      ? value.last_detail
      : null;
  if (
    ownBlogId === null ||
    timezone === null ||
    lastSyncedAt === undefined ||
    lastDetail === null ||
    !isInteger(value.hour) ||
    !isInteger(value.minute) ||
    value.hour < 0 ||
    value.hour > 23 ||
    value.minute < 0 ||
    value.minute > 59 ||
    typeof value.enabled !== "boolean" ||
    !["never", "success", "partial", "failed"].includes(String(value.last_status)) ||
    (lastSyncedAt !== null && Number.isNaN(Date.parse(lastSyncedAt)))
  )
    return null;
  return {
    ownBlogId,
    enabled: value.enabled,
    timezone,
    hour: value.hour,
    minute: value.minute,
    lastSyncedAt,
    lastStatus: value.last_status as AutomaticDiscoverySettings["lastStatus"],
    lastDetail,
  };
}

function parseAutomaticDiscoverySync(value: unknown): AutomaticDiscoverySyncResult | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "neighbors_added",
      "neighbor_posts_added",
      "search_posts_added",
      "search_provider",
      "status",
      "detail",
    ]) ||
    !isInteger(value.neighbors_added) ||
    !isInteger(value.neighbor_posts_added) ||
    !isInteger(value.search_posts_added) ||
    value.neighbors_added < 0 ||
    value.neighbor_posts_added < 0 ||
    value.search_posts_added < 0 ||
    !["naver_open_api", "none"].includes(String(value.search_provider)) ||
    !["success", "partial", "failed"].includes(String(value.status)) ||
    typeof value.detail !== "string" ||
    value.detail.length > 300
  )
    return null;
  return {
    neighborsAdded: value.neighbors_added,
    neighborPostsAdded: value.neighbor_posts_added,
    searchPostsAdded: value.search_posts_added,
    searchProvider: value.search_provider as AutomaticDiscoverySyncResult["searchProvider"],
    status: value.status as AutomaticDiscoverySyncResult["status"],
    detail: value.detail,
  };
}

function parseDiscoverySearchRefresh(value: unknown): DiscoverySearchRefreshResult | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["imported_count", "provider", "detail"]) ||
    !isInteger(value.imported_count) ||
    value.imported_count < 0 ||
    value.imported_count > 50 ||
    value.provider !== "naver_open_api" ||
    typeof value.detail !== "string" ||
    value.detail.length > 300
  )
    return null;
  return {
    importedCount: value.imported_count,
    provider: value.provider,
    detail: value.detail,
  };
}

function parseProblem(value: unknown): ProblemDetails | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["code", "detail", "errors", "request_id", "status", "title", "type"])
  ) {
    return null;
  }
  const type = requiredString(value, "type", 2_048);
  const title = requiredString(value, "title", 200);
  const detail = requiredString(value, "detail", 1_000);
  const code = requiredString(value, "code", 200);
  const requestId = requiredString(value, "request_id", 36);
  const status = value.status;
  const errors = value.errors;
  if (
    type === null ||
    title === null ||
    detail === null ||
    code === null ||
    !PROBLEM_CODE.test(code) ||
    requestId === null ||
    !UUID.test(requestId) ||
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 400 ||
    status > 599 ||
    (errors !== undefined &&
      (!Array.isArray(errors) ||
        !errors.every(
          (item) =>
            isRecord(item) &&
            onlyKeys(item, ["field", "message"]) &&
            requiredString(item, "field", 500) !== null &&
            requiredString(item, "message", 1_000) !== null,
        )))
  ) {
    return null;
  }
  return { code, detail, requestId, status, title, type };
}

function parseServiceStatus(value: unknown): ServiceStatus | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "api_version",
      "app_environment",
      "database",
      "generator_mode",
      "generator_model",
      "status",
    ])
  ) {
    return null;
  }
  const apiVersion = requiredString(value, "api_version", 100);
  const generatorModel = requiredString(value, "generator_model", 300);
  if (
    apiVersion === null ||
    generatorModel === null ||
    value.status !== "ready" ||
    value.database !== "ready" ||
    !["development", "production", "test"].includes(String(value.app_environment)) ||
    !["fake", "openai"].includes(String(value.generator_mode))
  ) {
    return null;
  }
  return {
    apiVersion,
    appEnvironment: value.app_environment as ServiceStatus["appEnvironment"],
    database: "ready",
    generatorMode: value.generator_mode as ServiceStatus["generatorMode"],
    generatorModel,
    status: "ready",
  };
}

function parseRecommendationHistory(value: unknown): RecommendationHistoryItem[] | null {
  if (!isRecord(value) || !onlyKeys(value, ["items"]) || !Array.isArray(value.items)) return null;
  if (value.items.length > 50) return null;
  const parsed = value.items.map(parseRecommendationHistoryItem);
  return parsed.some((item) => item === null) ? null : (parsed as RecommendationHistoryItem[]);
}

function parseRecommendationHistoryItem(value: unknown): RecommendationHistoryItem | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "comment",
      "created_at",
      "id",
      "review_status",
      "source_url",
      "title",
      "updated_at",
      "personalization_eligible",
    ])
  ) {
    return null;
  }
  const id = requiredString(value, "id", 36);
  const sourceUrl = requiredString(value, "source_url", 2_048);
  const title = requiredString(value, "title", 300);
  const comment = nullableString(value, "comment", 500);
  const createdAt = requiredString(value, "created_at", 100);
  const updatedAt = nullableString(value, "updated_at", 100);
  const reviewStatus = value.review_status;
  const personalizationEligible = value.personalization_eligible;
  if (
    id === null ||
    !UUID.test(id) ||
    sourceUrl === null ||
    title === null ||
    comment === undefined ||
    createdAt === null ||
    Number.isNaN(Date.parse(createdAt)) ||
    updatedAt === undefined ||
    (updatedAt !== null && Number.isNaN(Date.parse(updatedAt))) ||
    typeof reviewStatus !== "string" ||
    !REVIEW_STATUSES.has(reviewStatus as ReviewStatus) ||
    typeof personalizationEligible !== "boolean"
  ) {
    return null;
  }
  return {
    comment,
    createdAt,
    id,
    reviewStatus: reviewStatus as ReviewStatus,
    sourceUrl,
    title,
    updatedAt,
    personalizationEligible,
  };
}

async function recommendation(response: Response): Promise<Recommendation> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    throw invalidResponse(response.status);
  }
  const parsed = parseRecommendation(await readJson(response));
  if (parsed === null) {
    throw invalidResponse(response.status);
  }
  return parsed;
}

function parseRecommendation(value: unknown): Recommendation | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "candidates",
      "comment_length",
      "comment_mood",
      "created_at",
      "edited_comment",
      "id",
      "relationship_level",
      "quality_warnings",
      "personalization_applied",
      "personalization_mode",
      "personalization_sample_count",
      "personalization_eligible",
      "review_status",
      "selected_candidate_id",
      "source_url",
      "speech_style",
      "summary",
      "title",
      "topics",
      "updated_at",
    ])
  ) {
    return null;
  }
  const id = requiredString(value, "id", 36);
  const sourceUrl = requiredString(value, "source_url", 2_048);
  const title = requiredString(value, "title", 300);
  const summary = requiredString(value, "summary", 800);
  const createdAt = requiredString(value, "created_at", 100);
  const updatedAt = nullableString(value, "updated_at", 100);
  const selectedCandidateId = nullableString(value, "selected_candidate_id", 36);
  const editedComment = nullableString(value, "edited_comment", 500);
  const reviewStatus = value.review_status;
  const preferences = parseGenerationPreferences(value);
  const qualityWarnings = parseQualityWarnings(value.quality_warnings);
  const personalizationApplied = value.personalization_applied;
  const personalizationMode = value.personalization_mode;
  const personalizationSampleCount = value.personalization_sample_count;
  const personalizationEligible = value.personalization_eligible;
  if (
    id === null ||
    !UUID.test(id) ||
    sourceUrl === null ||
    title === null ||
    summary === null ||
    createdAt === null ||
    Number.isNaN(Date.parse(createdAt)) ||
    updatedAt === undefined ||
    (updatedAt !== null && Number.isNaN(Date.parse(updatedAt))) ||
    selectedCandidateId === undefined ||
    (selectedCandidateId !== null && !UUID.test(selectedCandidateId)) ||
    editedComment === undefined ||
    typeof reviewStatus !== "string" ||
    !REVIEW_STATUSES.has(reviewStatus as ReviewStatus) ||
    preferences === null ||
    qualityWarnings === null ||
    typeof personalizationApplied !== "boolean" ||
    typeof personalizationMode !== "string" ||
    !PERSONALIZATION_MODES.has(personalizationMode as PersonalizationMode) ||
    typeof personalizationSampleCount !== "number" ||
    !Number.isInteger(personalizationSampleCount) ||
    personalizationSampleCount < 0 ||
    personalizationSampleCount > 5 ||
    typeof personalizationEligible !== "boolean" ||
    !Array.isArray(value.topics) ||
    value.topics.length < 1 ||
    value.topics.length > 5 ||
    !value.topics.every(
      (topic) => typeof topic === "string" && topic.length > 0 && Array.from(topic).length <= 80,
    ) ||
    new Set(value.topics).size !== value.topics.length ||
    !Array.isArray(value.candidates) ||
    value.candidates.length !== 3
  ) {
    return null;
  }
  const candidates = value.candidates.map(parseCandidate);
  if (candidates.some((candidate) => candidate === null)) {
    return null;
  }
  const safeCandidates = candidates as CommentCandidate[];
  if (
    new Set(safeCandidates.map((candidate) => candidate.id)).size !== 3 ||
    new Set(safeCandidates.map((candidate) => candidate.tone)).size !== 3
  ) {
    return null;
  }
  if (
    selectedCandidateId !== null &&
    !safeCandidates.some((candidate) => candidate.id === selectedCandidateId)
  ) {
    return null;
  }
  return {
    candidates: safeCandidates,
    createdAt,
    editedComment,
    id,
    reviewStatus: reviewStatus as ReviewStatus,
    selectedCandidateId,
    sourceUrl,
    summary,
    title,
    topics: value.topics as string[],
    updatedAt,
    relationshipLevel: preferences.relationshipLevel,
    speechStyle: preferences.speechStyle,
    commentLength: preferences.commentLength,
    commentMood: preferences.commentMood,
    qualityWarnings,
    personalizationApplied,
    personalizationMode: personalizationMode as PersonalizationMode,
    personalizationSampleCount,
    personalizationEligible,
  };
}

function parseGenerationPreferences(value: Record<string, unknown>): {
  commentLength: CommentLength;
  commentMood: CommentMood;
  relationshipLevel: RelationshipLevel;
  speechStyle: SpeechStyle;
} | null {
  const keys = ["comment_length", "relationship_level", "speech_style"] as const;
  const present = keys.filter((key) => Object.hasOwn(value, key));
  const commentMood = parseCommentMood(value.comment_mood);
  if (commentMood === null) return null;
  if (present.length === 0) {
    return {
      commentLength: "medium",
      commentMood,
      relationshipLevel: "friendly",
      speechStyle: "honorific",
    };
  }
  if (present.length !== keys.length) {
    return null;
  }
  const commentLength = value.comment_length;
  const relationshipLevel = value.relationship_level;
  const speechStyle = value.speech_style;
  if (
    typeof commentLength !== "string" ||
    !COMMENT_LENGTHS.has(commentLength as CommentLength) ||
    commentMood === null ||
    typeof relationshipLevel !== "string" ||
    !RELATIONSHIP_LEVELS.has(relationshipLevel as RelationshipLevel) ||
    typeof speechStyle !== "string" ||
    !SPEECH_STYLES.has(speechStyle as SpeechStyle) ||
    (speechStyle === "banmal" && relationshipLevel !== "close")
  ) {
    return null;
  }
  return {
    commentLength: commentLength as CommentLength,
    commentMood,
    relationshipLevel: relationshipLevel as RelationshipLevel,
    speechStyle: speechStyle as SpeechStyle,
  };
}

function parseCommentMood(value: unknown): CommentMood | null {
  if (value === undefined) return "warm";
  return typeof value === "string" && COMMENT_MOODS.has(value as CommentMood)
    ? (value as CommentMood)
    : null;
}

function parseQualityWarnings(value: unknown): QualityWarning[] | null {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    new Set(value).size !== value.length ||
    !value.every(
      (warning) => typeof warning === "string" && QUALITY_WARNINGS.has(warning as QualityWarning),
    )
  ) {
    return null;
  }
  return value as QualityWarning[];
}

function parseCandidate(value: unknown): CommentCandidate | null {
  if (!isRecord(value) || !onlyKeys(value, ["comment", "id", "referenced_detail", "tone"])) {
    return null;
  }
  const id = requiredString(value, "id", 36);
  const comment = requiredString(value, "comment", 500);
  const referencedDetail = requiredString(value, "referenced_detail", 300);
  const tone = value.tone;
  if (
    id === null ||
    !UUID.test(id) ||
    comment === null ||
    referencedDetail === null ||
    typeof tone !== "string" ||
    !TONES.has(tone as CandidateTone)
  ) {
    return null;
  }
  return { comment, id, referencedDetail, tone: tone as CandidateTone };
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
