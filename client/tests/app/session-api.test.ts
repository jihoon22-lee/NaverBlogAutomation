/** Session batch and schedule transport: request shape and response validation. */

import { describe, expect, it, vi } from "vitest";

import {
  LocalApiClient,
  readAutomationSession,
  readScheduleStatus,
} from "../../src/app/api/client";

const SESSION_BODY = {
  id: "11111111-1111-4111-8111-111111111111",
  trigger: "session",
  state: "running",
  approved_steps: ["like", "comment"],
  sources: ["neighbor"],
  max_posts: 3,
  processed_count: 1,
  abort_reason: null,
  created_at: "2026-08-01T00:00:00Z",
  started_at: "2026-08-01T00:00:01Z",
  finished_at: null,
};

const SCHEDULE_BODY = {
  mode: "schedule",
  hour: 9,
  minute: 30,
  max_posts: 3,
  enabled: true,
  blocking_reason: null,
};

function client(
  body: unknown,
  status = 200,
): { api: LocalApiClient; fetch: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(async () => ({
    ok: status < 400,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  return { api: new LocalApiClient({ fetch: fetchMock as never }), fetch: fetchMock };
}

describe("readAutomationSession", () => {
  it("maps every documented field", () => {
    const session = readAutomationSession(SESSION_BODY);

    expect(session).toEqual({
      id: SESSION_BODY.id,
      trigger: "session",
      state: "running",
      approvedSteps: ["like", "comment"],
      sources: ["neighbor"],
      maxPosts: 3,
      processedCount: 1,
      abortReason: null,
      createdAt: SESSION_BODY.created_at,
      startedAt: SESSION_BODY.started_at,
      finishedAt: null,
    });
  });

  it("keeps an abort reason when the service reports one", () => {
    const session = readAutomationSession({
      ...SESSION_BODY,
      state: "aborted",
      abort_reason: "daily_cap_reached",
    });

    expect(session.abortReason).toBe("daily_cap_reached");
  });

  it("rejects an unknown state", () => {
    expect(() => readAutomationSession({ ...SESSION_BODY, state: "paused" })).toThrow();
  });

  it("rejects an unknown trigger", () => {
    expect(() => readAutomationSession({ ...SESSION_BODY, trigger: "cron" })).toThrow();
  });

  it("rejects an unknown step name", () => {
    expect(() => readAutomationSession({ ...SESSION_BODY, approved_steps: ["share"] })).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() => readAutomationSession({ ...SESSION_BODY, sources: ["feed"] })).toThrow();
  });

  it("rejects an empty step list", () => {
    expect(() => readAutomationSession({ ...SESSION_BODY, approved_steps: [] })).toThrow();
  });

  it("rejects a body that is not an object", () => {
    expect(() => readAutomationSession("session")).toThrow();
  });
});

describe("readScheduleStatus", () => {
  it("maps every documented field", () => {
    expect(readScheduleStatus(SCHEDULE_BODY)).toEqual({
      mode: "schedule",
      hour: 9,
      minute: 30,
      maxPosts: 3,
      enabled: true,
      blockingReason: null,
    });
  });

  it("keeps the blocking reason when unattended mode is off", () => {
    const status = readScheduleStatus({
      ...SCHEDULE_BODY,
      enabled: false,
      blocking_reason: "consent_missing",
    });

    expect(status.blockingReason).toBe("consent_missing");
  });

  it("rejects an hour outside a day", () => {
    expect(() => readScheduleStatus({ ...SCHEDULE_BODY, hour: 24 })).toThrow();
  });

  it("rejects a minute outside an hour", () => {
    expect(() => readScheduleStatus({ ...SCHEDULE_BODY, minute: 60 })).toThrow();
  });

  it("rejects an unknown mode", () => {
    expect(() => readScheduleStatus({ ...SCHEDULE_BODY, mode: "cron" })).toThrow();
  });
});

describe("session requests", () => {
  it("sends the approval in snake_case", async () => {
    const { api, fetch } = client(SESSION_BODY, 202);

    await api.approveSession({
      approvedSteps: ["like", "comment"],
      maxPosts: 4,
      sources: ["neighbor"],
    });

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      approved_steps: ["like", "comment"],
      max_posts: 4,
      sources: ["neighbor"],
    });
  });

  it("asks for the newest batches with a limit", async () => {
    const { api, fetch } = client({ items: [SESSION_BODY] });

    const sessions = await api.sessions(10);

    expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/v1/automation/sessions?limit=10");
    expect(sessions).toHaveLength(1);
  });

  it("omits the limit when the caller does not choose one", async () => {
    const { api, fetch } = client({ items: [] });

    await api.sessions();

    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/sessions$/);
  });

  it("cancels one batch by id", async () => {
    const { api, fetch } = client({ ...SESSION_BODY, state: "cancelled" });

    const session = await api.cancelSession(SESSION_BODY.id);

    expect(String(fetch.mock.calls[0]?.[0])).toContain(`/sessions/${SESSION_BODY.id}/cancel`);
    expect(session.state).toBe("cancelled");
  });

  it("reads one batch by id", async () => {
    const { api } = client(SESSION_BODY);

    expect((await api.session(SESSION_BODY.id)).id).toBe(SESSION_BODY.id);
  });

  it("builds the progress stream url on the same origin", () => {
    const { api } = client(SESSION_BODY);

    expect(api.sessionEventsUrl(SESSION_BODY.id)).toContain(
      `/api/v1/automation/sessions/${SESSION_BODY.id}/events`,
    );
  });

  it("reads the schedule status", async () => {
    const { api } = client(SCHEDULE_BODY);

    expect((await api.schedule()).enabled).toBe(true);
  });
});
