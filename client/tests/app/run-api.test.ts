import { describe, expect, it, vi } from "vitest";

import { LocalApiClient } from "../../src/app/api/client";

const RUN = {
  id: "33333333-3333-4333-8333-333333333333",
  approval_id: "44444444-4444-4444-8444-444444444444",
  discovery_post_id: "11111111-1111-4111-8111-111111111111",
  recommendation_id: "22222222-2222-4222-8222-222222222222",
  source: "neighbor",
  state: "running",
  steps: [
    {
      name: "like",
      position: 0,
      state: "skipped",
      result_code: "already_liked",
      updated_at: "2026-07-31T00:00:00Z",
    },
    {
      name: "comment",
      position: 1,
      state: "pending",
      result_code: null,
      updated_at: "2026-07-31T00:00:00Z",
    },
  ],
  created_at: "2026-07-31T00:00:00Z",
  updated_at: "2026-07-31T00:00:00Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(handler: typeof fetch): LocalApiClient {
  return new LocalApiClient({ fetch: handler });
}

describe("engagement run transport", () => {
  it("starts a run with the approved identifiers", async () => {
    const handler = vi.fn(async () => jsonResponse(RUN, 202));
    const client = clientWith(handler as never);

    const started = await client.startEngagementRun(RUN.discovery_post_id, RUN.recommendation_id);

    expect(started.id).toBe(RUN.id);
    expect(started.steps[0]).toEqual({
      name: "like",
      position: 0,
      resultCode: "already_liked",
      state: "skipped",
      updatedAt: "2026-07-31T00:00:00Z",
    });
    const call = handler.mock.calls[0] as unknown[];
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      discovery_post_id: RUN.discovery_post_id,
      recommendation_id: RUN.recommendation_id,
    });
  });

  it("reads one stored run", async () => {
    const handler = vi.fn(async () => jsonResponse(RUN));
    const client = clientWith(handler as never);

    const stored = await client.engagementRun(RUN.id);

    expect(stored.state).toBe("running");
    expect((handler.mock.calls[0] as unknown[] | undefined)?.[0]).toBe(
      `/api/v1/engagement-runs/${RUN.id}`,
    );
  });

  it("posts only the confirmed manual steps", async () => {
    const handler = vi.fn(async () => jsonResponse(RUN));
    const client = clientWith(handler as never);

    await client.completeEngagementManually(RUN.id, ["comment"]);

    const call = handler.mock.calls[0] as unknown[];
    expect(call[0]).toBe(`/api/v1/engagement-runs/${RUN.id}/manual-completion`);
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      completed_steps: ["comment"],
    });
  });

  it("builds the documented stream path", () => {
    expect(clientWith(vi.fn() as never).engagementRunEventsUrl(RUN.id)).toBe(
      `/api/v1/automation/engagement-runs/${RUN.id}/events`,
    );
  });

  it.each([
    ["source", { ...RUN, source: "cafe" }],
    ["state", { ...RUN, state: "queued" }],
    ["steps", { ...RUN, steps: [RUN.steps[0]] }],
    ["step name", { ...RUN, steps: [{ ...RUN.steps[0], name: "share" }, RUN.steps[1]] }],
    ["step state", { ...RUN, steps: [{ ...RUN.steps[0], state: "done" }, RUN.steps[1]] }],
    [
      "result code",
      { ...RUN, steps: [{ ...RUN.steps[0], result_code: "Already Liked" }, RUN.steps[1]] },
    ],
    ["position", { ...RUN, steps: [{ ...RUN.steps[0], position: 3 }, RUN.steps[1]] }],
  ])("rejects a response whose %s violates the contract", async (_field, body) => {
    const client = clientWith(vi.fn(async () => jsonResponse(body)) as never);

    await expect(client.engagementRun(RUN.id)).rejects.toThrow(/계약/u);
  });

  it("rejects a response that is not an object", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse([RUN])) as never);

    await expect(client.engagementRun(RUN.id)).rejects.toThrow(/계약/u);
  });
});
