import type {
  ApiResult,
  CandidateTone,
  CommentLength,
  CommentMood,
  CommentCandidate,
  CreateRecommendationRequest,
  ProblemDetails,
  QualityWarning,
  Recommendation,
  RelationshipLevel,
  ReviewRecommendationRequest,
  ReviewStatus,
  SpeechStyle,
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
const QUALITY_WARNINGS = new Set<QualityWarning>([
  "candidate_roles_blurred",
  "candidates_too_similar",
  "length_target_missed",
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
