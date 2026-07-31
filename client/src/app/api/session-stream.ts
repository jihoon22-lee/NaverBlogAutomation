/**
 * Progress stream for one session batch.
 *
 * The service closes the stream deliberately once the batch reaches a terminal state, so the caller
 * must close the source when it sees a terminal event; otherwise `EventSource` would reconnect to a
 * finished batch forever. Keepalives arrive as SSE comments and stay invisible here.
 */

import type { RunStreamEvent } from "./types";
import type { RunStreamFactory } from "./run-stream";

/** Every event name the session stream can deliver. */
export const SESSION_STREAM_EVENTS = [
  "session_started",
  "post_completed",
  "session_completed",
  "session_aborted",
  "session_cancelled",
  "session_snapshot",
  "stream_deadline",
] as const;

/** Events after which no further progress arrives. */
export const TERMINAL_SESSION_EVENTS = new Set<string>([
  "session_completed",
  "session_aborted",
  "session_cancelled",
  "session_snapshot",
  "stream_deadline",
]);

/** Subscribe with the platform `EventSource`, decoding each named event's JSON payload. */
export const sessionEventSourceStream: RunStreamFactory = (url, handlers) => {
  const source = new EventSource(url);
  for (const name of SESSION_STREAM_EVENTS) {
    source.addEventListener(name, (event) => {
      handlers.onEvent({
        event: name,
        payload: decodeSessionEvent((event as MessageEvent).data),
      });
    });
  }
  source.addEventListener("error", () => handlers.onError());
  return source;
};

/** Decode one payload, treating malformed data as empty rather than throwing at the caller. */
export function decodeSessionEvent(data: unknown): RunStreamEvent["payload"] {
  if (typeof data !== "string" || data.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
