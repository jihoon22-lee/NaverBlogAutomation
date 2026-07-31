/**
 * Progress stream for one engagement run.
 *
 * The browser's `EventSource` reconnects on its own after a drop, which is useful while a run is in
 * flight and wrong once it finished: the service closes the stream deliberately, so the caller must
 * close the source when it sees a terminal event. The factory shape keeps that policy testable
 * without a live socket.
 */

import type { RunStreamEvent } from "./types";

/** Every event name the run stream can deliver. Keepalives arrive as comments and stay invisible. */
export const RUN_STREAM_EVENTS = [
  "run_started",
  "step_completed",
  "run_finished",
  "run_failed",
  "run_skipped",
  "run_snapshot",
  "stream_deadline",
] as const;

/** Events after which no further progress arrives. */
export const TERMINAL_RUN_EVENTS = new Set<string>([
  "run_finished",
  "run_failed",
  "run_skipped",
  "run_snapshot",
  "stream_deadline",
]);

export interface RunStreamHandlers {
  onEvent(event: RunStreamEvent): void;
  onError(): void;
}

export interface RunStreamSource {
  close(): void;
}

export type RunStreamFactory = (url: string, handlers: RunStreamHandlers) => RunStreamSource;

/** Subscribe with the platform `EventSource`, decoding each named event's JSON payload. */
export const eventSourceStream: RunStreamFactory = (url, handlers) => {
  const source = new EventSource(url);
  for (const name of RUN_STREAM_EVENTS) {
    source.addEventListener(name, (event) => {
      handlers.onEvent({ event: name, payload: decode((event as MessageEvent).data) });
    });
  }
  source.addEventListener("error", () => handlers.onError());
  return source;
};

/** Decode one event payload, treating malformed data as an empty payload rather than throwing. */
export function decode(data: unknown): Record<string, unknown> {
  if (typeof data !== "string" || data.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
