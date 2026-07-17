import type { Recommendation } from "../api/types";
import type { CaptureFailure, CapturedPostPreview } from "../extraction/types";

export type WorkflowFailureAction = "cleanup" | "replace" | "retry" | null;

export interface WorkflowFailure {
  action: WorkflowFailureAction;
  code: string;
  message: string;
  title: string;
}

export interface ReviewPresentation {
  copied: boolean;
  editedComment: string;
  notice?: string;
  recommendation: Recommendation;
  selectedCandidateId: string | null;
}

export type PanelState =
  | { kind: "extracting" }
  | { failure: CaptureFailure | WorkflowFailure; kind: "error" }
  | { kind: "preview"; preview: CapturedPostPreview }
  | { canCancel: boolean; kind: "generating"; message: string }
  | ({ kind: "review" } & ReviewPresentation)
  | ({ kind: "saving" } & ReviewPresentation)
  | ({ kind: "approved" } & ReviewPresentation)
  | ({ kind: "completed" } & ReviewPresentation);

export interface PanelActions {
  approve(): void;
  cancel(): void;
  cleanup(): void;
  complete(): void;
  copy(): void;
  edit(value: string): void;
  generate(): void;
  replace(): void;
  retry(): void;
  select(candidateId: string): void;
}

export interface PanelView {
  bind(actions: PanelActions): void;
  clearSensitiveContent(): void;
  copyText(value: string): Promise<boolean>;
  render(state: PanelState): void;
}
