/** Session stream: event decoding and terminal event policy. */

import { describe, expect, it } from "vitest";

import {
  SESSION_STREAM_EVENTS,
  TERMINAL_SESSION_EVENTS,
  decodeSessionEvent,
} from "../../src/app/api/session-stream";

describe("decodeSessionEvent", () => {
  it("decodes one JSON payload", () => {
    expect(decodeSessionEvent('{"state":"running"}')).toEqual({ state: "running" });
  });

  it("treats malformed data as empty rather than throwing", () => {
    expect(decodeSessionEvent("{oops")).toEqual({});
  });

  it("treats a non-object payload as empty", () => {
    expect(decodeSessionEvent("[1,2]")).toEqual({});
    expect(decodeSessionEvent('"text"')).toEqual({});
  });

  it("treats missing data as empty", () => {
    expect(decodeSessionEvent(undefined)).toEqual({});
    expect(decodeSessionEvent("")).toEqual({});
  });
});

describe("session stream events", () => {
  it("names every event the service publishes", () => {
    expect([...SESSION_STREAM_EVENTS]).toEqual([
      "session_started",
      "post_completed",
      "session_completed",
      "session_aborted",
      "session_cancelled",
      "session_snapshot",
      "stream_deadline",
    ]);
  });

  it("treats every ending as terminal so the source is closed", () => {
    for (const name of ["session_completed", "session_aborted", "session_cancelled"]) {
      expect(TERMINAL_SESSION_EVENTS.has(name)).toBe(true);
    }
  });

  it("does not treat progress as terminal", () => {
    expect(TERMINAL_SESSION_EVENTS.has("post_completed")).toBe(false);
    expect(TERMINAL_SESSION_EVENTS.has("session_started")).toBe(false);
  });
});
