import { ApiClientError } from "../api/client";
import type { RegistryState } from "../idempotency/registry";
import type { WorkflowFailure } from "./state";

const DEFAULT_RETRY_MS = 1_000;

export function generationRetryDelay(error: unknown): number | null {
  if (!(error instanceof ApiClientError)) {
    return null;
  }
  const code = error.problem?.code;
  if (
    code === "generation_refused" ||
    code === "generation_invalid" ||
    code === "generation_indeterminate" ||
    code === "idempotency_conflict" ||
    error.replayed
  ) {
    return null;
  }
  if (code === "generation_rate_limited") {
    return Math.max(DEFAULT_RETRY_MS, (error.retryAfterSeconds ?? 1) * 1_000);
  }
  if (
    code === "generation_in_progress" ||
    code === "generation_timeout" ||
    code === "generation_unavailable" ||
    error.status === null ||
    (error.status !== null && error.status >= 500)
  ) {
    return DEFAULT_RETRY_MS;
  }
  return null;
}

export function registryStateForGenerationError(error: unknown): RegistryState {
  if (error instanceof ApiClientError) {
    const code = error.problem?.code;
    if (code === "generation_indeterminate") {
      return "indeterminate";
    }
    if (code === "generation_refused" || code === "generation_invalid" || error.replayed) {
      return "terminal_failure";
    }
    if (
      code === "invalid_request" ||
      code === "payload_too_large" ||
      code === "unsupported_source_url"
    ) {
      return "released";
    }
  }
  return "active";
}

export function replacementFailure(state: "indeterminate" | "terminal_failure"): WorkflowFailure {
  return state === "indeterminate"
    ? workflowFailure(
        "generation_indeterminate",
        "이전 provider 요청의 결과를 알 수 없습니다. 새 요청은 중복 생성 가능성을 이해한 뒤 명시적으로 확인해야 합니다.",
        "추천 결과를 확인할 수 없습니다",
        "replace",
      )
    : workflowFailure(
        "terminal_generation_failure",
        "같은 key의 실패 결과가 보존되어 재요청되지 않습니다. 새 시도를 원하면 명시적으로 확인해 주세요.",
        "추천 댓글을 만들지 못했습니다",
        "replace",
      );
}

export function workflowFailure(
  code: string,
  message: string,
  title: string,
  action: WorkflowFailure["action"],
): WorkflowFailure {
  return { action, code, message, title };
}

export function apiFailure(error: unknown): WorkflowFailure {
  if (error instanceof ApiClientError) {
    const retry = error.retryAfterSeconds;
    return workflowFailure(
      error.problem?.code ?? "api_unavailable",
      retry === null
        ? error.message
        : `${error.message} ${retry}초 이후 현재 글을 다시 읽어 재시도해 주세요.`,
      "Local API 요청을 완료하지 못했습니다",
      "retry",
    );
  }
  return workflowFailure(
    "workflow_failed",
    "추천 workflow를 완료하지 못했습니다. 현재 글을 다시 읽어 주세요.",
    "작업을 완료하지 못했습니다",
    "retry",
  );
}
