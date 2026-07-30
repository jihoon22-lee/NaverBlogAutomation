/**
 * Same-origin client for the local API.
 *
 * The app is served by the same FastAPI process, so requests use relative paths and need no CORS
 * relaxation. Every response is validated before it reaches the views: an unexpected shape is a
 * contract error, not something to render.
 */

import type {
  ArticleExtraction,
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
