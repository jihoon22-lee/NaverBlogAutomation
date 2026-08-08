/** Session stream: event decoding and terminal event policy. */

import { describe, expect, it, vi } from "vitest";

import {
  SESSION_STREAM_EVENTS,
  TERMINAL_SESSION_EVENTS,
  decodeSessionEvent,
  sessionEventSourceStream,
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

  it("forwards browser session events and stream errors", () => {
    const listeners = new Map<string, (event: Event) => void>();
    const addEventListener = vi.fn((name: string, handler: (event: Event) => void) => {
      listeners.set(name, handler);
    });
    class BrowserEventSource {
      readonly addEventListener = addEventListener;
      readonly close = vi.fn();
    }
    vi.stubGlobal("EventSource", BrowserEventSource);
    const onEvent = vi.fn();
    const onError = vi.fn();

    const subscribed = sessionEventSourceStream("/events", { onEvent, onError });
    listeners.get("post_completed")?.({ data: '{"post_id":"one"}' } as MessageEvent);
    listeners.get("error")?.(new Event("error"));

    expect(subscribed).toBeInstanceOf(BrowserEventSource);
    expect(onEvent).toHaveBeenCalledWith({ event: "post_completed", payload: { post_id: "one" } });
    expect(onError).toHaveBeenCalledOnce();
    expect(addEventListener).toHaveBeenCalledTimes(8);
    vi.unstubAllGlobals();
  });
});
