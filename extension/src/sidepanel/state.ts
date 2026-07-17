import type { CaptureFailure, CapturedPostPreview } from "../extraction/types";

export type PanelState =
  | { kind: "extracting" }
  | { failure: CaptureFailure; kind: "error" }
  | { kind: "preview"; preview: CapturedPostPreview };

export interface PanelView {
  onRetry(listener: () => void): void;
  render(state: PanelState): void;
}
