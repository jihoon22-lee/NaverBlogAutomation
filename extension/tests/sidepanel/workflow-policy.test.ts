import { describe, expect, it } from "vitest";

import { ApiClientError } from "../../src/api/client";
import {
  apiFailure,
  generationRetryDelay,
  registryStateForGenerationError,
  replacementFailure,
} from "../../src/sidepanel/workflow-policy";

function failure(
  code: string,
  status: number | null,
  options: { replayed?: boolean; retry?: number } = {},
): ApiClientError {
  return new ApiClientError("safe", {
    problem:
      status === null
        ? null
        : {
            code,
            detail: "safe",
            requestId: "00000000-0000-4000-8000-000000000001",
            status,
            title: "safe",
            type: "about:blank",
          },
    retryAfterSeconds: options.retry ?? null,
    status,
    ...(options.replayed === undefined ? {} : { replayed: options.replayed }),
  });
}

describe("generation recovery policy", () => {
  it("polls the same key for active, rate-limited, timeout, network, and first 503 outcomes", () => {
    expect(generationRetryDelay(failure("generation_in_progress", 409))).toBe(1_000);
    expect(generationRetryDelay(failure("generation_rate_limited", 429, { retry: 12 }))).toBe(
      12_000,
    );
    expect(generationRetryDelay(failure("generation_timeout", 504))).toBe(1_000);
    expect(generationRetryDelay(failure("network", null))).toBe(1_000);
    expect(generationRetryDelay(failure("generation_unavailable", 503))).toBe(1_000);
  });

  it("does not poll terminal, replayed, indeterminate, or idempotency conflicts", () => {
    expect(generationRetryDelay(failure("generation_refused", 502))).toBeNull();
    expect(
      generationRetryDelay(failure("generation_unavailable", 503, { replayed: true })),
    ).toBeNull();
    expect(generationRetryDelay(failure("generation_indeterminate", 409))).toBeNull();
    expect(generationRetryDelay(failure("idempotency_conflict", 409))).toBeNull();
  });

  it("maps persistent states conservatively", () => {
    expect(registryStateForGenerationError(failure("generation_indeterminate", 409))).toBe(
      "indeterminate",
    );
    expect(registryStateForGenerationError(failure("generation_invalid", 502))).toBe(
      "terminal_failure",
    );
    expect(registryStateForGenerationError(failure("generation_unavailable", 503))).toBe("active");
    expect(registryStateForGenerationError(failure("invalid_request", 422))).toBe("released");
    expect(replacementFailure("indeterminate").action).toBe("replace");
    expect(replacementFailure("terminal_failure").code).toBe("terminal_generation_failure");
  });

  it("keeps unknown client errors non-polling and creates safe UI failures", () => {
    expect(generationRetryDelay(new Error("unknown"))).toBeNull();
    expect(generationRetryDelay(failure("invalid_request", 422))).toBeNull();
    expect(generationRetryDelay(failure("unexpected_gateway", 502))).toBe(1_000);
    expect(apiFailure(failure("generation_rate_limited", 429, { retry: 3 })).message).toContain(
      "3초",
    );
    expect(apiFailure(new Error("private")).code).toBe("workflow_failed");
  });
});
