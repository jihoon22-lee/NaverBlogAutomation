import {
  MAX_BODY_CODE_POINTS,
  MAX_TITLE_CODE_POINTS,
  boundCodePoints,
  normalizeRequestText,
} from "./normalize";
import { parseSupportedNaverUrl } from "./source-url";
import type { ActiveTab, CaptureResult, FrameExecution } from "./types";

const MIN_BODY_CODE_POINTS = 20;

export function chooseCapturedPost(
  tab: ActiveTab,
  frames: readonly FrameExecution[],
): CaptureResult {
  const tabUrl = parseSupportedNaverUrl(tab.url);
  if (tabUrl === null) {
    return { failure: { code: "unsupported_url" }, ok: false };
  }

  const candidates = frames
    .filter(
      (frame): frame is FrameExecution & { result: NonNullable<FrameExecution["result"]> } =>
        frame.result !== null && parseSupportedNaverUrl(frame.result.frameUrl) !== null,
    )
    .map((frame) => {
      const normalizedBody = normalizeRequestText(frame.result.body);
      return {
        body: normalizedBody,
        bodyLength: Array.from(normalizedBody).length,
        frame,
      };
    })
    .filter((candidate) => candidate.bodyLength > 0)
    .sort(
      (left, right) =>
        right.frame.result.selectorConfidence - left.frame.result.selectorConfidence ||
        right.bodyLength - left.bodyLength ||
        left.frame.frameId - right.frame.frameId,
    );

  if (candidates.length === 0) {
    return { failure: { code: "empty_article" }, ok: false };
  }
  const selected = candidates[0];
  if (selected === undefined || selected.bodyLength < MIN_BODY_CODE_POINTS) {
    return { failure: { code: "short_article" }, ok: false };
  }

  const boundedBody = boundCodePoints(selected.body, MAX_BODY_CODE_POINTS);
  const normalizedTitle = normalizeRequestText(selected.frame.result.title || tab.title);
  const boundedTitle = boundCodePoints(normalizedTitle, MAX_TITLE_CODE_POINTS).text;
  if (boundedTitle.length === 0) {
    return { failure: { code: "extraction_failed" }, ok: false };
  }
  const canonicalUrl =
    selected.frame.result.canonicalUrl === null
      ? null
      : parseSupportedNaverUrl(selected.frame.result.canonicalUrl);
  const documentIdentity =
    selected.frame.documentId === undefined ? {} : { documentId: selected.frame.documentId };

  return {
    ok: true,
    preview: {
      body: boundedBody.text,
      frameId: selected.frame.frameId,
      originalLength: Math.max(selected.frame.result.originalLength, boundedBody.originalLength),
      sourceUrl: canonicalUrl ?? tabUrl,
      tabId: tab.id,
      title: boundedTitle,
      transmittedLength: Array.from(boundedBody.text).length,
      truncated:
        boundedBody.truncated || selected.frame.result.originalLength > boundedBody.originalLength,
      ...documentIdentity,
    },
  };
}
