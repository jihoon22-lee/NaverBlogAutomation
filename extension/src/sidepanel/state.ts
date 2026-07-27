import type { DiscoveryPost, EngagementRun, Recommendation } from "../api/types";
import type { CaptureFailure, CapturedPostPreview } from "../extraction/types";
import type { GenerationPreferences } from "../preferences/model";

export type WorkflowFailureAction = "cleanup" | "replace" | "retry" | null;

export interface WorkflowFailure {
  action: WorkflowFailureAction;
  code: string;
  message: string;
  title: string;
}

export interface ReviewPresentation {
  copied: boolean;
  discoveryPost?: DiscoveryPost | null;
  editedComment: string;
  engagementRun?: EngagementRun | null;
  neighborMessage?: string;
  notice?: string;
  recommendation: Recommendation;
  selectedCandidateId: string | null;
}

export type PanelState =
  | { kind: "extracting" }
  | { failure: CaptureFailure | WorkflowFailure; kind: "error" }
  | {
      kind: "preview";
      closingPhrase: string;
      preferenceNotice?: string;
      preferences: GenerationPreferences;
      preview: CapturedPostPreview;
    }
  | { canCancel: boolean; kind: "generating"; message: string }
  | ({ kind: "review" } & ReviewPresentation)
  | ({ kind: "saving" } & ReviewPresentation)
  | ({ kind: "engaging" } & ReviewPresentation)
  | ({ kind: "approved" } & ReviewPresentation)
  | ({ kind: "completed" } & ReviewPresentation);

export interface PanelActions {
  approve(): void;
  cancel(): void;
  changeOptions(): void;
  cleanup(): void;
  complete(): void;
  copy(): void;
  changeCommentLength(value: string): void;
  changeCommentMood(value: string): void;
  changePersonalizationMode(value: string): void;
  changeClosingPhrase(value: string): void;
  changeRelationship(value: string): void;
  changeSpeechStyle(value: string): void;
  edit(value: string): void;
  engage(): void;
  generate(): void;
  changeNeighborMessage(value: string): void;
  regenerate(): void;
  replace(): void;
  retry(): void;
  refill(): void;
  savePreferences(): void;
  select(candidateId: string): void;
  useCandidate(candidateId: string): void;
  useEdited(): void;
}

export interface PanelView {
  bind(actions: PanelActions): void;
  clearSensitiveContent(): void;
  copyText(value: string): Promise<boolean>;
  render(state: PanelState): void;
}
