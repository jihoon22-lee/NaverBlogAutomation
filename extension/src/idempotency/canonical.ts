import type { CreateRecommendationRequest } from "../api/types";
import { preferencesFromRequest, requestPreferenceFields } from "../preferences/model";

const MAX_BODY_CODE_POINTS = 100_000;

export class CanonicalPayloadError extends Error {}

export function normalizePythonWhitespace(value: string): string {
  assertNoLoneSurrogates(value);
  const normalized: string[] = [];
  let pendingSpace = false;
  for (const point of value) {
    if (isPythonWhitespace(point)) {
      pendingSpace = normalized.length > 0;
    } else {
      if (pendingSpace) {
        normalized.push(" ");
        pendingSpace = false;
      }
      normalized.push(point);
    }
  }
  return normalized.join("");
}

function isPythonWhitespace(point: string): boolean {
  const code = point.codePointAt(0);
  return (
    code !== undefined &&
    ((code >= 0x09 && code <= 0x0d) ||
      (code >= 0x1c && code <= 0x20) ||
      code === 0x85 ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000)
  );
}

export function canonicalizeRequest(
  payload: CreateRecommendationRequest,
): CreateRecommendationRequest {
  const sourceUrl = normalizePythonWhitespace(payload.source_url);
  const title = normalizePythonWhitespace(payload.title);
  const body = normalizePythonWhitespace(payload.body);
  if (sourceUrl.length === 0 || title.length === 0 || Array.from(body).length < 20) {
    throw new CanonicalPayloadError("정규화된 요청 값이 API 최소 길이를 충족하지 않습니다.");
  }
  if (
    Array.from(sourceUrl).length > 2_048 ||
    Array.from(title).length > 300 ||
    Array.from(body).length > MAX_BODY_CODE_POINTS
  ) {
    throw new CanonicalPayloadError("정규화된 요청 값이 API 최대 길이를 초과했습니다.");
  }
  const preferences = preferencesFromRequest(payload);
  if (preferences === null) {
    throw new CanonicalPayloadError("댓글 생성 옵션 조합이 올바르지 않습니다.");
  }
  return {
    body,
    ...requestPreferenceFields(preferences),
    source_url: sourceUrl,
    title,
  };
}

export function canonicalRequestJson(payload: CreateRecommendationRequest): string {
  const normalized = canonicalizeRequest(payload);
  return JSON.stringify({
    body: normalized.body,
    source_url: normalized.source_url,
    title: normalized.title,
  });
}

export async function requestDigest(payload: CreateRecommendationRequest): Promise<string> {
  const normalized = canonicalizeRequest(payload);
  const postHash = await sha256(canonicalRequestJson(normalized));
  const preferences = preferencesFromRequest(normalized);
  if (preferences === null) {
    throw new CanonicalPayloadError("댓글 생성 옵션 조합이 올바르지 않습니다.");
  }
  return sha256(
    JSON.stringify({
      comment_length: preferences.commentLength,
      comment_mood: preferences.commentMood,
      personalization_mode: preferences.personalizationMode,
      post_hash: postHash,
      relationship_level: preferences.relationshipLevel,
      schema: "generation-policy-v3",
      speech_style: preferences.speechStyle,
    }),
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertNoLoneSurrogates(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      throw new CanonicalPayloadError("요청 값에 올바르지 않은 Unicode surrogate가 있습니다.");
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalPayloadError("요청 값에 올바르지 않은 Unicode surrogate가 있습니다.");
    }
  }
}
