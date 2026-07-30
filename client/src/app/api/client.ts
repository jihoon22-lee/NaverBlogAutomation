/**
 * Same-origin client for the local API.
 *
 * The app is served by the same FastAPI process, so requests use relative paths and need no CORS
 * relaxation. Every response is validated before it reaches the views: an unexpected shape is a
 * contract error, not something to render.
 */

import type {
  AppSettingRecord,
  ArticleExtraction,
  CandidateTone,
  CommentCandidate,
  CommentGeneration,
  GenerationOptions,
  Recommendation,
  ReviewStatus,
  BrowserLoginState,
  BrowserSession,
  BrowserSessionState,
  DiscoveryPost,
  DiscoverySource,
  DiscoveryState,
  ProblemDetails,
  ServiceStatus,
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
    const body = await this.#request("GET", `/api/v1/discovery/queue?source=${source}`);
    return readDiscoveryQueue(body);
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

  async reviewRecommendation(
    id: string,
    patch: {
      editedComment?: string;
      reviewStatus?: ReviewStatus;
      selectedCandidateId?: string;
    },
  ): Promise<Recommendation> {
    const payload: Record<string, unknown> = {};
    if (patch.selectedCandidateId !== undefined) {
      payload.selected_candidate_id = patch.selectedCandidateId;
    }
    if (patch.editedComment !== undefined) payload.edited_comment = patch.editedComment;
    if (patch.reviewStatus !== undefined) payload.review_status = patch.reviewStatus;
    const body = await this.#request("PATCH", `/api/v1/recommendations/${id}`, payload);
    return readRecommendation(body);
  }

  async appSetting(kind: string): Promise<AppSettingRecord> {
    return readAppSetting(await this.#request("GET", `/api/v1/settings/${kind}`));
  }

  async saveAppSetting(kind: string, payload: Record<string, unknown>): Promise<AppSettingRecord> {
    return readAppSetting(await this.#request("PUT", `/api/v1/settings/${kind}`, { payload }));
  }

  async #request(method: string, path: string, payload?: unknown): Promise<unknown> {
    const init: RequestInit =
      payload === undefined
        ? { method }
        : {
            method,
            headers: { "Content-Type": "application/json" },
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
    try {
      return await response.json();
    } catch {
      throw new ApiError("응답을 해석할 수 없습니다.", { status: response.status });
    }
  }
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
    publishedAt: readNullableString(value.published_at, "published_at"),
    createdAt: readString(value.created_at, "created_at"),
    updatedAt: readString(value.updated_at, "updated_at"),
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
    version: readCount(body.version, "version"),
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
