import type { RecommendationHistoryItem, ServiceStatus } from "../api/types";

export type HistoryState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      busyId?: string;
      items: readonly RecommendationHistoryItem[];
      kind: "ready";
      notice?: string;
      service: ServiceStatus;
    };

export interface HistoryActions {
  copy(id: string): void;
  delete(id: string): void;
  refresh(): void;
}

export interface HistoryView {
  bind(actions: HistoryActions): void;
  copyText(value: string): Promise<boolean>;
  render(state: HistoryState): void;
}
