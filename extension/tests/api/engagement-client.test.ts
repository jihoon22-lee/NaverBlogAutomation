import { describe, expect, it, vi } from "vitest";

import { ApiClientError, LocalApiClient } from "../../src/api/client";

const run = {
  id: "00000000-0000-4000-8000-000000000001",
  approval_id: "00000000-0000-4000-8000-000000000002",
  discovery_post_id: "00000000-0000-4000-8000-000000000003",
  recommendation_id: "00000000-0000-4000-8000-000000000004",
  source: "search",
  state: "running",
  steps: [
    {
      name: "like",
      position: 0,
      state: "succeeded",
      result_code: "clicked",
      updated_at: "2026-07-28T00:00:01Z",
    },
    {
      name: "comment",
      position: 1,
      state: "pending",
      result_code: null,
      updated_at: "2026-07-28T00:00:00Z",
    },
    {
      name: "mutual_neighbor",
      position: 2,
      state: "pending",
      result_code: null,
      updated_at: "2026-07-28T00:00:00Z",
    },
  ],
  created_at: "2026-07-28T00:00:00Z",
  updated_at: "2026-07-28T00:00:01Z",
};

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function notFound(): Response {
  return json(
    {
      code: "engagement_run_not_found",
      detail: "Synthetic safe detail.",
      request_id: "00000000-0000-4000-8000-000000000099",
      status: 404,
      title: "Not found",
      type: "about:blank",
    },
    404,
    { "content-type": "application/problem+json" },
  );
}

describe("LocalApiClient engagement API", () => {
  it("starts, resumes, lists, reads, and transitions a typed run", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(run, 201, { "Engagement-Replayed": "false" }))
      .mockResolvedValueOnce(json(run, 200, { "Engagement-Replayed": "true" }))
      .mockResolvedValueOnce(json({ items: [run] }))
      .mockResolvedValueOnce(json(run))
      .mockResolvedValueOnce(json(run));
    const client = new LocalApiClient(fetch);
    const input = {
      approvalId: run.approval_id,
      discoveryPostId: run.discovery_post_id,
      recommendationId: run.recommendation_id,
    };

    await expect(client.startEngagementRun(input)).resolves.toMatchObject({
      replayed: false,
      value: { id: run.id, source: "search" },
    });
    await expect(client.startEngagementRun(input)).resolves.toMatchObject({ replayed: true });
    await expect(client.listEngagementRuns()).resolves.toHaveLength(1);
    await expect(client.getEngagementRunForPost(run.discovery_post_id)).resolves.toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({ name: "like", resultCode: "clicked" }),
      ]),
    });
    await expect(
      client.transitionEngagementStep(run.id, "comment", { state: "running" }),
    ).resolves.toMatchObject({ id: run.id });

    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        approval_id: run.approval_id,
        discovery_post_id: run.discovery_post_id,
        recommendation_id: run.recommendation_id,
      }),
    );
    expect(fetch.mock.calls[4]?.[0]).toContain(`/steps/comment`);
  });

  it("returns null only for the explicit by-post not-found problem", async () => {
    await expect(
      new LocalApiClient(
        vi.fn<typeof fetch>().mockResolvedValue(notFound()),
      ).getEngagementRunForPost(run.discovery_post_id),
    ).resolves.toBeNull();

    await expect(
      new LocalApiClient(
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
      ).getEngagementRunForPost(run.discovery_post_id),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it("records user-confirmed steps for a failed run", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        ...run,
        state: "succeeded",
        steps: run.steps.map((step) =>
          step.name === "comment"
            ? { ...step, result_code: "manual_confirmed", state: "succeeded" }
            : step,
        ),
      }),
    );

    await expect(
      new LocalApiClient(fetch).completeEngagementManually(run.id, ["like", "comment"]),
    ).resolves.toMatchObject({ id: run.id, state: "succeeded" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/v1/engagement-runs/${run.id}/manual-completion`),
      expect.objectContaining({
        body: JSON.stringify({ completed_steps: ["like", "comment"] }),
        method: "POST",
      }),
    );
  });

  it("rejects malformed order, terminal results, and out-of-range limits", async () => {
    const malformed = {
      ...run,
      steps: [
        { ...run.steps[1], state: "succeeded", result_code: null },
        run.steps[0],
        run.steps[2],
      ],
    };
    await expect(
      new LocalApiClient(vi.fn<typeof fetch>().mockResolvedValue(json(malformed))).getEngagementRun(
        run.id,
      ),
    ).rejects.toBeInstanceOf(ApiClientError);
    await expect(new LocalApiClient().listEngagementRuns(0)).rejects.toBeInstanceOf(RangeError);
  });
});
