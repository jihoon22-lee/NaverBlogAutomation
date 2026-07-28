import { ApiClientError, LocalApiClient } from "../api/client";
import type {
  CreateRecommendationRequest,
  DiscoveryPost,
  EngagementRun,
  EngagementStepName,
  Recommendation,
} from "../api/types";
import { BrowserCaptureError, type TabCaptureGateway } from "../browser/tab-capture-gateway";
import {
  ChromeCommentInputGateway,
  type CommentInputGateway,
  type CommentInputResult,
} from "../browser/comment-input-gateway";
import { chooseCapturedPost } from "../extraction/rank-captures";
import { parseSupportedNaverUrl, sameSupportedNaverPost } from "../extraction/source-url";
import type { CaptureFailure, CapturedPostPreview } from "../extraction/types";
import {
  CanonicalPayloadError,
  canonicalizeRequest,
  requestDigest,
} from "../idempotency/canonical";
import {
  IdempotencyRegistry,
  RegistryFullError,
  RegistryQuarantinedError,
  type RegistryEntry,
} from "../idempotency/registry";
import {
  DEFAULT_GENERATION_PREFERENCES,
  appendClosingPhrase,
  isCommentLength,
  isCommentMood,
  isPersonalizationMode,
  isRelationshipLevel,
  isSpeechStyle,
  normalizeClosingPhrase,
  requestPreferenceFields,
  samePreferences,
  type GenerationPreferences,
} from "../preferences/model";
import { CommentLengthPreferenceStore } from "../preferences/store";
import type { EngagementApprovalToken } from "../engagement/approval-session";
import type {
  EngagementExecutionRequest,
  EngagementExecutionResult,
} from "../engagement/run-controller";
import { DEFAULT_MUTUAL_NEIGHBOR_MESSAGE } from "../engagement/message-settings";
import type { PanelView, ReviewPresentation, WorkflowFailure } from "./state";
import {
  apiFailure,
  generationRetryDelay,
  registryStateForGenerationError,
  replacementFailure,
  workflowFailure,
} from "./workflow-policy";

const MAX_POLL_MS = 60_000;

export interface WorkflowDependencies {
  api?: LocalApiClient;
  approval?: {
    cancelPendingApproval(): void;
    requestApproval(details: {
      comment: string;
      neighborMessage?: string;
      sourceUrl: string;
      steps: readonly ("comment" | "like" | "mutual_neighbor")[];
      title: string;
    }): Promise<EngagementApprovalToken | null>;
  };
  commentInput?: CommentInputGateway;
  digest?: typeof requestDigest;
  now?: () => number;
  registry?: IdempotencyRegistry;
  lengthStore?: CommentLengthPreferenceStore;
  neighborMessage?: string;
  engagement?: {
    execute(request: EngagementExecutionRequest): Promise<EngagementExecutionResult>;
  };
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

class StaleOperation extends Error {}
class PollingStopped extends Error {}
class ResponseProvenanceMismatch extends Error {}
type GenerationPhase = "preflight" | "restore" | "submission";

interface ReplacementIntent {
  digest: string;
  state: "indeterminate" | "terminal_failure";
}

interface RegenerationIntent {
  activeTabId: number | null;
  digest: string;
  preferences: GenerationPreferences;
  recommendationId: string;
  sourceUrl: string;
}

export class SidePanelController {
  readonly #api: LocalApiClient;
  readonly #approval: NonNullable<WorkflowDependencies["approval"]> | null;
  readonly #commentInput: CommentInputGateway;
  readonly #digest: typeof requestDigest;
  readonly #gateway: TabCaptureGateway;
  readonly #lengthStore: CommentLengthPreferenceStore;
  readonly #engagement: NonNullable<WorkflowDependencies["engagement"]> | null;
  readonly #now: () => number;
  readonly #registry: IdempotencyRegistry;
  readonly #view: PanelView;
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  #abort: AbortController | null = null;
  #activeTabId: number | null = null;
  #busy = false;
  #copied = false;
  #closingPhrase = "";
  #digestValue: string | null = null;
  #discoveryPost: DiscoveryPost | null = null;
  #editedComment = "";
  #engagementActive = false;
  #engagementRun: EngagementRun | null = null;
  #neighborMessage = DEFAULT_MUTUAL_NEIGHBOR_MESSAGE;
  #operation = 0;
  #preview: CapturedPostPreview | null = null;
  #preferenceNotice: string | undefined;
  #preferences: GenerationPreferences = { ...DEFAULT_GENERATION_PREFERENCES };
  #recommendation: Recommendation | null = null;
  #regenerationIntent: RegenerationIntent | null = null;
  #replacementIntent: ReplacementIntent | null = null;
  #savedPreferences: GenerationPreferences = { ...DEFAULT_GENERATION_PREFERENCES };
  #savedClosingPhrase = "";
  #savedNeighborMessage = DEFAULT_MUTUAL_NEIGHBOR_MESSAGE;
  #selectedCandidateId: string | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(
    gateway: TabCaptureGateway,
    view: PanelView,
    dependencies: WorkflowDependencies = {},
  ) {
    this.#gateway = gateway;
    this.#approval = dependencies.approval ?? null;
    this.#commentInput = dependencies.commentInput ?? new ChromeCommentInputGateway();
    this.#lengthStore = dependencies.lengthStore ?? new CommentLengthPreferenceStore();
    this.#savedNeighborMessage = boundNeighborMessage(
      dependencies.neighborMessage ?? DEFAULT_MUTUAL_NEIGHBOR_MESSAGE,
    );
    this.#neighborMessage = this.#savedNeighborMessage;
    this.#engagement = dependencies.engagement ?? null;
    this.#view = view;
    this.#api = dependencies.api ?? new LocalApiClient();
    this.#digest = dependencies.digest ?? requestDigest;
    this.#now = dependencies.now ?? Date.now;
    this.#registry = dependencies.registry ?? new IdempotencyRegistry();
    this.#wait = dependencies.wait ?? waitFor;
    this.#view.bind({
      approve: () => void this.approve(),
      cancel: () => void this.cancel(),
      changeOptions: () => void this.changeOptions(),
      cleanup: () => void this.cleanupRegistry(),
      complete: () => void this.complete(),
      copy: () => void this.copy(),
      changeCommentLength: (value) => this.changeCommentLength(value),
      changeCommentMood: (value) => this.changeCommentMood(value),
      changePersonalizationMode: (value) => this.changePersonalizationMode(value),
      changeClosingPhrase: (value) => this.changeClosingPhrase(value),
      changeRelationship: (value) => this.changeRelationship(value),
      changeSpeechStyle: (value) => this.changeSpeechStyle(value),
      edit: (value) => this.edit(value),
      engage: () => void this.engage(),
      generate: () => void this.generate(),
      manualComplete: (completedSteps) => void this.manualComplete(completedSteps),
      changeNeighborMessage: (value) => this.changeNeighborMessage(value),
      regenerate: () => void this.regenerate(),
      replace: () => void this.confirmReplacement(),
      retry: () => void this.captureActivePost(),
      refill: () => void this.refill(),
      savePreferences: () => void this.savePreferences(),
      select: (candidateId) => this.select(candidateId),
      useCandidate: (candidateId) => void this.useCandidate(candidateId),
      useEdited: () => void this.useEdited(),
    });
  }

  start(): void {
    this.#unsubscribe = this.#gateway.subscribeToInvalidation((event) => {
      if (this.#engagementActive) return;
      if (event.kind === "updated" && event.tabId !== this.#activeTabId) {
        return;
      }
      this.#invalidate();
      if (event.kind === "activated") {
        this.#activeTabId = event.tabId;
      }
      this.#renderFailure(captureFailure("stale_page"));
    });
    void this.#initialize();
  }

  dispose(): void {
    this.#invalidate();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  async captureActivePost(): Promise<void> {
    this.#discoveryPost = null;
    this.#engagementRun = null;
    this.#replacementIntent = null;
    this.#regenerationIntent = null;
    this.#preferences = { ...this.#savedPreferences };
    this.#closingPhrase = this.#savedClosingPhrase;
    this.#neighborMessage = this.#savedNeighborMessage;
    this.#preferenceNotice = undefined;
    await this.#captureActivePost();
  }

  async captureDiscoveryPost(post: DiscoveryPost, tabId: number): Promise<void> {
    this.#discoveryPost = post;
    this.#engagementRun = null;
    this.#replacementIntent = null;
    this.#regenerationIntent = null;
    this.#preferences = { ...this.#savedPreferences };
    this.#closingPhrase = this.#savedClosingPhrase;
    this.#neighborMessage = this.#savedNeighborMessage;
    this.#preferenceNotice = undefined;
    await this.#captureActivePost();
    if (
      this.#activeTabId !== tabId ||
      (!sameOptionalPost(this.#recommendation?.sourceUrl, post.sourceUrl) &&
        !sameOptionalPost(this.#preview?.sourceUrl, post.sourceUrl))
    ) {
      this.#discoveryPost = null;
      if (this.#preview !== null) {
        this.#preferenceNotice =
          "열린 글이 선택한 대기열 항목과 달라 자동 실행 연결을 해제했습니다. 댓글 추천과 수동 사용은 계속할 수 있습니다.";
        this.#renderPreview();
      }
    }
  }

  async #captureActivePost(): Promise<void> {
    const operation = this.#beginOperation();
    this.#view.render({ kind: "extracting" });
    try {
      const result = await this.#extract(operation);
      this.#assertCurrent(operation);
      if ("failure" in result) {
        this.#releaseBody();
        this.#renderFailure(result.failure);
        return;
      }
      this.#preview = result.preview;
      this.#recommendation = null;
      this.#digestValue = null;
      this.#selectedCandidateId = null;
      this.#editedComment = "";
      this.#renderPreview();
    } catch (error) {
      if (operation !== this.#operation || error instanceof StaleOperation) {
        return;
      }
      this.#releaseBody();
      const code = error instanceof BrowserCaptureError ? error.code : "extraction_failed";
      this.#renderFailure(captureFailure(code));
    }
  }

  changeRelationship(value: string): void {
    if (this.#busy || this.#preview === null || !isRelationshipLevel(value)) return;
    this.#preferences = {
      ...this.#preferences,
      relationshipLevel: value,
      ...(value === "close" ? {} : { speechStyle: "honorific" }),
    };
    this.#renderPreview();
  }

  changeSpeechStyle(value: string): void {
    if (
      this.#busy ||
      this.#preview === null ||
      !isSpeechStyle(value) ||
      (value === "banmal" && this.#preferences.relationshipLevel !== "close")
    ) {
      return;
    }
    this.#preferences = { ...this.#preferences, speechStyle: value };
    this.#renderPreview();
  }

  changeCommentLength(value: string): void {
    if (this.#busy || this.#preview === null || !isCommentLength(value)) return;
    this.#preferences = { ...this.#preferences, commentLength: value };
    this.#preferenceNotice = undefined;
    this.#renderPreview();
  }

  changeCommentMood(value: string): void {
    if (this.#busy || this.#preview === null || !isCommentMood(value)) return;
    this.#preferences = { ...this.#preferences, commentMood: value };
    this.#preferenceNotice = undefined;
    this.#renderPreview();
  }

  changePersonalizationMode(value: string): void {
    if (this.#busy || this.#preview === null || !isPersonalizationMode(value)) return;
    this.#preferences = { ...this.#preferences, personalizationMode: value };
    this.#preferenceNotice = undefined;
    this.#renderPreview();
  }

  changeClosingPhrase(value: string): void {
    if (this.#busy || this.#preview === null) return;
    this.#closingPhrase = normalizeClosingPhrase(value);
    this.#preferenceNotice = undefined;
  }

  async savePreferences(): Promise<void> {
    if (this.#busy || this.#preview === null) return;
    const snapshot = { ...this.#preferences };
    const closingPhrase = this.#closingPhrase;
    try {
      await this.#lengthStore.save({ ...snapshot, closingPhrase });
      if (
        this.#preview === null ||
        !samePreferences(this.#preferences, snapshot) ||
        this.#closingPhrase !== closingPhrase
      ) {
        return;
      }
      this.#savedPreferences = { ...snapshot };
      this.#savedClosingPhrase = closingPhrase;
      this.#preferenceNotice = "현재 설정을 다음 글의 기본값으로 저장했습니다.";
      this.#renderPreview();
    } catch {
      if (
        this.#preview === null ||
        !samePreferences(this.#preferences, snapshot) ||
        this.#closingPhrase !== closingPhrase
      ) {
        return;
      }
      this.#preferenceNotice =
        "기본 설정을 저장하지 못했지만, 이번 추천에는 현재 선택을 적용합니다.";
      this.#renderPreview();
    }
  }

  async generate(): Promise<void> {
    if (this.#busy || this.#preview === null) {
      return;
    }
    const operation = this.#beginOperation();
    this.#busy = true;
    this.#view.render({
      canCancel: true,
      kind: "generating",
      message: "로컬 API를 확인하고 있습니다.",
    });
    let payload: CreateRecommendationRequest | null = null;
    const preferences: GenerationPreferences = Object.freeze({ ...this.#preferences });
    let phase: GenerationPhase = "preflight";
    try {
      payload = canonicalizeRequest({
        body: this.#preview.body,
        ...requestPreferenceFields(preferences),
        source_url: this.#preview.sourceUrl,
        title: this.#preview.title,
      });
      this.#releaseBody();
      await this.#api.health(this.#signal());
      this.#assertCurrent(operation);
      const digest = await this.#digest(payload);
      this.#assertCurrent(operation);
      this.#digestValue = digest;
      const replacement = this.#replacementIntent;
      const regeneration = this.#regenerationIntent;
      const entry =
        replacement?.digest === digest
          ? await this.#registry.replace(digest, replacement.state)
          : regeneration?.digest === digest &&
              samePreferences(regeneration.preferences, preferences)
            ? await this.#registry.regenerateKnown(digest, regeneration.recommendationId)
            : await this.#registry.getOrCreate(digest);
      this.#assertCurrent(operation);
      this.#replacementIntent = null;
      this.#regenerationIntent = null;

      if (entry.recommendationId !== undefined) {
        phase = "restore";
        payload = null;
        const existing = await this.#api.getRecommendation(entry.recommendationId, this.#signal());
        this.#assertCurrent(operation);
        this.#assertRecommendationPreferences(existing, preferences, true);
        await this.#registry.transition(
          digest,
          existing.reviewStatus === "completed" ? "completed" : "reviewing",
          existing.id,
        );
        this.#assertCurrent(operation);
        this.#showRecommendation(existing);
        return;
      }
      if (entry.state === "indeterminate" || entry.state === "terminal_failure") {
        payload = null;
        this.#replacementIntent = { digest, state: entry.state };
        this.#renderFailure(replacementFailure(entry.state));
        return;
      }

      this.#view.render({
        canCancel: true,
        kind: "generating",
        message: "추천 댓글을 만들고 있습니다. 이 작업은 자동으로 게시하지 않습니다.",
      });
      phase = "submission";
      const result = await this.#createWithPolling(payload, digest, entry, operation, preferences);
      payload = null;
      this.#assertCurrent(operation);
      this.#assertRecommendationPreferences(result.value, preferences, false);
      await this.#registry.transition(digest, "reviewing", result.value.id);
      this.#assertCurrent(operation);
      this.#showRecommendation(result.value);
    } catch (error) {
      payload = null;
      if (operation !== this.#operation || error instanceof StaleOperation) {
        return;
      }
      await this.#handleWorkflowError(error, operation, phase);
    } finally {
      if (operation === this.#operation) {
        this.#busy = false;
      }
    }
  }

  select(candidateId: string): void {
    if (this.#busy || this.#recommendation?.reviewStatus !== "drafted") {
      return;
    }
    const candidate = this.#recommendation.candidates.find((item) => item.id === candidateId);
    if (candidate === undefined) {
      return;
    }
    this.#selectedCandidateId = candidate.id;
    this.#editedComment = appendClosingPhrase(candidate.comment, this.#closingPhrase);
    this.#copied = false;
    this.#renderReview();
  }

  edit(value: string): void {
    if (!this.#busy && this.#recommendation?.reviewStatus === "drafted") {
      this.#editedComment = Array.from(value).slice(0, 500).join("");
    }
  }

  changeNeighborMessage(value: string): void {
    if (this.#busy) return;
    this.#neighborMessage = boundNeighborMessage(value);
  }

  setNeighborMessageDefault(value: string): void {
    this.#savedNeighborMessage = boundNeighborMessage(value);
  }

  async engage(): Promise<void> {
    const recommendation = this.#recommendation;
    const discoveryPost = this.#discoveryPost;
    const tabId = this.#activeTabId;
    if (
      this.#busy ||
      recommendation === null ||
      (recommendation.reviewStatus !== "approved" && recommendation.reviewStatus !== "completed") ||
      discoveryPost === null ||
      tabId === null ||
      this.#approval === null ||
      this.#engagement === null ||
      !sameSupportedNaverPost(recommendation.sourceUrl, discoveryPost.sourceUrl)
    ) {
      this.#renderReview(
        "탐색 대기열에서 연 글과 승인된 댓글이 함께 있어야 자동 실행할 수 있습니다.",
      );
      return;
    }
    let existingRun: EngagementRun | null;
    try {
      existingRun = await this.#api.getEngagementRunForPost(discoveryPost.id, this.#signal());
    } catch {
      this.#renderReview(
        "이 글의 이전 교류 실행 상태를 확인하지 못했습니다. 최근 작업을 새로고침한 뒤 다시 시도해 주세요.",
      );
      return;
    }
    if (existingRun !== null && existingRun.recommendationId !== recommendation.id) {
      this.#engagementRun = existingRun;
      this.#renderReview(
        "이 글은 다른 추천 댓글과 연결되어 있어 자동 실행하지 않았습니다. 현재 글을 다시 열어 추천을 새로 생성해 주세요.",
      );
      return;
    }
    if (existingRun === null && recommendation.reviewStatus === "completed") {
      this.#renderReview("이 댓글은 이미 수동 완료로 기록되어 새 자동 실행을 시작하지 않았습니다.");
      return;
    }
    this.#engagementRun = existingRun;
    if (
      this.#engagementRun?.state === "succeeded" ||
      this.#engagementRun?.state === "unconfirmed"
    ) {
      this.#renderReview("이미 완료했거나 결과 확인이 필요한 실행은 다시 시작하지 않습니다.");
      return;
    }
    const comment = approvedComment(recommendation);
    if (comment === "") {
      this.#renderReview("등록할 승인 댓글을 확인하지 못했습니다.");
      return;
    }
    const steps =
      discoveryPost.source === "neighbor"
        ? (["like", "comment"] as const)
        : (["like", "comment", "mutual_neighbor"] as const);
    const message = this.#neighborMessage.trim();
    if (discoveryPost.source === "search" && message === "") {
      this.#renderReview("서로이웃 신청 메시지를 입력해 주세요.");
      return;
    }
    const operation = this.#operation;
    const token = await this.#approval.requestApproval({
      comment,
      ...(discoveryPost.source === "search" ? { neighborMessage: message } : {}),
      sourceUrl: recommendation.sourceUrl,
      steps,
      title: recommendation.title,
    });
    if (operation !== this.#operation) return;
    if (token === null) {
      this.#renderReview("자동 실행 동의와 이 글의 최종 확인이 필요합니다.");
      return;
    }
    this.#busy = true;
    this.#engagementActive = true;
    this.#view.render({ kind: "engaging", ...this.#presentation() });
    try {
      const result = await this.#engagement.execute({
        discoveryPost,
        recommendation,
        tabId,
        tokenId: token.id,
      });
      if (operation !== this.#operation) return;
      this.#engagementRun = result.run;
      if (result.run?.steps.some((step) => step.name === "comment" && step.state === "succeeded")) {
        const updated = await this.#api.getRecommendation(recommendation.id);
        if (operation !== this.#operation) return;
        this.#showRecommendation(updated, engagementNotice(result));
      } else {
        this.#renderReview(engagementNotice(result));
      }
      this.#dispatchEngagementUpdate();
    } catch {
      if (operation === this.#operation) {
        this.#renderReview(
          "교류 결과를 확인하지 못했습니다. 자동으로 다시 실행하지 말고 최근 작업 상태를 확인해 주세요.",
        );
      }
    } finally {
      this.#engagementActive = false;
      if (operation === this.#operation) this.#busy = false;
    }
  }

  async useCandidate(candidateId: string): Promise<void> {
    this.select(candidateId);
    await this.#approveSelected(true);
  }

  async approve(): Promise<void> {
    await this.#approveSelected(false);
  }

  async useEdited(): Promise<void> {
    await this.#approveSelected(true);
  }

  async #approveSelected(fillAfterApproval: boolean): Promise<void> {
    const recommendation = this.#recommendation;
    if (this.#busy || recommendation === null || recommendation.reviewStatus !== "drafted") {
      return;
    }
    if (this.#selectedCandidateId === null) {
      this.#renderReview("승인할 댓글 후보를 먼저 선택해 주세요.");
      return;
    }
    const edited = this.#editedComment.trim();
    if (edited.length === 0) {
      this.#renderReview("댓글 내용을 비워 둘 수 없습니다.");
      return;
    }
    const operation = this.#beginOperation();
    this.#busy = true;
    this.#view.render({ kind: "saving", ...this.#presentation() });
    try {
      const updated = await this.#api.reviewRecommendation(
        recommendation.id,
        {
          edited_comment: edited,
          review_status: "approved",
          selected_candidate_id: this.#selectedCandidateId,
        },
        this.#signal(),
      );
      this.#assertCurrent(operation);
      if (this.#digestValue !== null) {
        await this.#registry.transition(this.#digestValue, "reviewing", updated.id);
        this.#assertCurrent(operation);
      }
      this.#showRecommendation(updated);
      if (fillAfterApproval) {
        await this.#fillApprovedComment(updated, operation);
      }
    } catch (error) {
      if (operation !== this.#operation) {
        return;
      }
      if (error instanceof ApiClientError && error.problem?.code === "review_conflict") {
        await this.#refreshAfterConflict(recommendation.id, operation);
      } else if (!(error instanceof StaleOperation) && !isAbort(error)) {
        this.#renderFailure(apiFailure(error));
      }
    } finally {
      if (operation === this.#operation) {
        this.#busy = false;
      }
    }
  }

  async #fillApprovedComment(recommendation: Recommendation, operation: number): Promise<void> {
    const tabId = this.#activeTabId;
    const candidate = recommendation.candidates.find(
      (item) => item.id === recommendation.selectedCandidateId,
    );
    const value = recommendation.editedComment ?? candidate?.comment;
    if (tabId === null || value === undefined) return;
    const result = await this.#commentInput.fill(tabId, value);
    this.#assertCurrent(operation);
    this.#renderReview(commentInputNotice(result));
  }

  async copy(): Promise<void> {
    const recommendation = this.#recommendation;
    if (recommendation === null || recommendation.reviewStatus === "drafted") {
      return;
    }
    const candidate = recommendation.candidates.find(
      (item) => item.id === recommendation.selectedCandidateId,
    );
    const value = recommendation.editedComment ?? candidate?.comment;
    if (value === undefined) {
      return;
    }
    const operation = this.#operation;
    const copied = await this.#view.copyText(value);
    if (operation !== this.#operation) {
      return;
    }
    this.#copied = copied;
    this.#renderReview(
      copied
        ? "클립보드에 복사했습니다. 블로그 댓글 등록은 직접 진행해 주세요."
        : "자동 복사에 실패했습니다. 편집 영역의 댓글을 직접 선택해 복사해 주세요.",
    );
  }

  async refill(): Promise<void> {
    const recommendation = this.#recommendation;
    if (this.#busy || recommendation === null || recommendation.reviewStatus !== "approved") {
      return;
    }
    const operation = this.#beginOperation();
    this.#busy = true;
    try {
      await this.#fillApprovedComment(recommendation, operation);
    } catch (error) {
      if (operation !== this.#operation || error instanceof StaleOperation) return;
      this.#renderReview("댓글 입력을 다시 시도하지 못했습니다. 복사해서 붙여넣어 주세요.");
    } finally {
      if (operation === this.#operation) this.#busy = false;
    }
  }

  async complete(): Promise<void> {
    const recommendation = this.#recommendation;
    if (this.#busy || recommendation === null || recommendation.reviewStatus !== "approved") {
      return;
    }
    const operation = this.#beginOperation();
    this.#busy = true;
    this.#view.render({ kind: "saving", ...this.#presentation() });
    try {
      const updated = await this.#api.reviewRecommendation(
        recommendation.id,
        { review_status: "completed" },
        this.#signal(),
      );
      this.#assertCurrent(operation);
      if (this.#discoveryPost !== null) {
        await this.#api.updateDiscoveryPostState(
          this.#discoveryPost.id,
          "completed",
          this.#signal(),
        );
        this.#assertCurrent(operation);
      }
      if (this.#digestValue !== null) {
        await this.#registry.transition(this.#digestValue, "completed", updated.id);
        this.#assertCurrent(operation);
      }
      this.#showRecommendation(updated);
      this.#dispatchEngagementUpdate();
    } catch (error) {
      if (operation !== this.#operation) {
        return;
      }
      if (error instanceof ApiClientError && error.problem?.code === "review_conflict") {
        await this.#refreshAfterConflict(recommendation.id, operation);
      } else if (!(error instanceof StaleOperation) && !isAbort(error)) {
        this.#renderFailure(apiFailure(error));
      }
    } finally {
      if (operation === this.#operation) {
        this.#busy = false;
      }
    }
  }

  async manualComplete(completedSteps: readonly EngagementStepName[]): Promise<void> {
    const recommendation = this.#recommendation;
    const run = this.#engagementRun;
    if (
      this.#busy ||
      recommendation === null ||
      run === null ||
      run.state !== "failed" ||
      !completedSteps.includes("comment")
    ) {
      return;
    }
    const operation = this.#beginOperation();
    this.#busy = true;
    this.#view.render({ kind: "saving", ...this.#presentation() });
    try {
      this.#engagementRun = await this.#api.completeEngagementManually(
        run.id,
        completedSteps,
        this.#signal(),
      );
      this.#assertCurrent(operation);
      const updated = await this.#api.getRecommendation(recommendation.id, this.#signal());
      this.#assertCurrent(operation);
      this.#showRecommendation(
        updated,
        this.#engagementRun.state === "succeeded"
          ? "직접 완료한 단계를 기록하고 오늘의 작업에서 정리했습니다."
          : "댓글 등록 수동 완료를 기록했습니다. 남은 서로이웃 신청은 다시 확인·승인하면 이어서 실행합니다.",
      );
      this.#dispatchEngagementUpdate();
    } catch (error) {
      if (operation !== this.#operation || error instanceof StaleOperation) return;
      this.#renderReview(
        error instanceof ApiClientError &&
          error.problem?.code === "engagement_manual_completion_conflict"
          ? "확인되지 않은 실행 결과가 있어 수동 완료로 바꾸지 않았습니다. 최근 작업에서 결과를 먼저 확인해 주세요."
          : "수동 처리 결과를 저장하지 못했습니다. 실제 동작을 다시 실행하지 말고 최근 작업 상태를 확인해 주세요.",
      );
    } finally {
      if (operation === this.#operation) this.#busy = false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.#busy) {
      return;
    }
    const digest = this.#digestValue;
    this.#invalidate();
    const operation = this.#operation;
    if (digest !== null) {
      try {
        await this.#registry.transition(digest, "indeterminate");
        this.#assertCurrent(operation);
      } catch (error) {
        if (operation !== this.#operation || error instanceof StaleOperation) {
          return;
        }
        this.#renderFailure(registryFailure());
        return;
      }
      this.#digestValue = digest;
      this.#renderFailure(replacementFailure("indeterminate"));
      return;
    }
    this.#renderFailure(
      workflowFailure("cancelled", "작업을 취소했습니다.", "현재 글 다시 읽기", "retry"),
    );
  }

  async confirmReplacement(): Promise<void> {
    if (this.#digestValue === null) {
      return;
    }
    const existing = await this.#registry.find(this.#digestValue).catch(() => null);
    if (
      existing === null ||
      (existing.state !== "indeterminate" && existing.state !== "terminal_failure")
    ) {
      this.#renderFailure(registryFailure());
      return;
    }
    this.#replacementIntent = { digest: this.#digestValue, state: existing.state };
    await this.#captureActivePost();
  }

  async regenerate(): Promise<void> {
    await this.#prepareRegeneration(true);
  }

  async changeOptions(): Promise<void> {
    await this.#prepareRegeneration(false);
  }

  async #prepareRegeneration(direct: boolean): Promise<void> {
    const recommendation = this.#recommendation;
    const digest = this.#digestValue;
    if (this.#busy || recommendation === null || digest === null) return;
    const preferences: GenerationPreferences = Object.freeze({
      commentLength: recommendation.commentLength,
      commentMood: recommendation.commentMood,
      personalizationMode: recommendation.personalizationMode,
      relationshipLevel: recommendation.relationshipLevel,
      speechStyle: recommendation.speechStyle,
    });
    const intent: RegenerationIntent = {
      activeTabId: this.#activeTabId,
      digest,
      preferences,
      recommendationId: recommendation.id,
      sourceUrl: recommendation.sourceUrl,
    };
    this.#regenerationIntent = intent;
    const operation = this.#beginOperation();
    this.#busy = true;
    this.#view.render({ kind: "extracting" });
    try {
      const result = await this.#extract(operation);
      this.#assertCurrent(operation);
      if (
        "failure" in result ||
        result.preview.sourceUrl !== intent.sourceUrl ||
        this.#activeTabId !== intent.activeTabId
      ) {
        this.#regenerationIntent = null;
        this.#renderFailure("failure" in result ? result.failure : captureFailure("stale_page"));
        return;
      }
      this.#preview = result.preview;
      this.#recommendation = null;
      this.#selectedCandidateId = null;
      this.#editedComment = "";
      this.#preferences = { ...preferences };
      this.#preferenceNotice = undefined;
      if (!direct) {
        this.#renderPreview();
        return;
      }
      const payload = canonicalizeRequest({
        body: result.preview.body,
        ...requestPreferenceFields(preferences),
        source_url: result.preview.sourceUrl,
        title: result.preview.title,
      });
      const currentDigest = await this.#digest(payload);
      this.#assertCurrent(operation);
      if (currentDigest !== intent.digest) {
        this.#regenerationIntent = null;
        this.#preferenceNotice =
          "글 내용이 달라져 자동 재생성을 멈췄습니다. Preview를 확인한 뒤 생성해 주세요.";
        this.#renderPreview();
        return;
      }
      this.#busy = false;
      await this.generate();
    } catch (error) {
      if (operation !== this.#operation || error instanceof StaleOperation) return;
      this.#regenerationIntent = null;
      const code = error instanceof BrowserCaptureError ? error.code : "extraction_failed";
      this.#renderFailure(captureFailure(code));
    } finally {
      if (operation === this.#operation) this.#busy = false;
    }
  }

  async cleanupRegistry(): Promise<void> {
    const operation = this.#beginOperation();
    this.#view.render({
      canCancel: false,
      kind: "generating",
      message: "retry registry를 정리하고 있습니다.",
    });
    try {
      await this.#registry.cleanupAll();
      this.#assertCurrent(operation);
      await this.captureActivePost();
    } catch (error) {
      if (operation !== this.#operation) {
        return;
      }
      if (!(error instanceof StaleOperation)) {
        this.#renderFailure(registryFailure());
      }
    }
  }

  async #createWithPolling(
    initialPayload: CreateRecommendationRequest,
    digest: string,
    entry: RegistryEntry,
    operation: number,
    preferences: GenerationPreferences,
  ) {
    const deadline = this.#now() + MAX_POLL_MS;
    let payload: CreateRecommendationRequest | null = initialPayload;
    while (true) {
      this.#assertCurrent(operation);
      const currentPayload = payload;
      if (currentPayload === null) {
        throw new PollingStopped();
      }
      const request = this.#api.createRecommendation(
        currentPayload,
        entry.idempotencyKey,
        this.#signal(),
      );
      payload = null;
      try {
        const result = await request;
        this.#assertCurrent(operation);
        return result;
      } catch (error) {
        this.#assertCurrent(operation);
        const retry = generationRetryDelay(error);
        if (retry === null || this.#now() + retry > deadline) {
          throw retry === null ? error : new PollingStopped();
        }
        this.#view.render({
          canCancel: true,
          kind: "generating",
          message:
            error instanceof ApiClientError && error.problem?.code === "generation_rate_limited"
              ? `${Math.ceil(retry / 1_000)}초 뒤 다시 확인합니다.`
              : "이미 시작된 추천 작업의 결과를 확인하고 있습니다.",
        });
        await this.#wait(retry, this.#signal());
        this.#assertCurrent(operation);
        payload = await this.#recaptureMatchingPayload(digest, operation, preferences);
        this.#assertCurrent(operation);
      }
    }
  }

  async #recaptureMatchingPayload(
    digest: string,
    operation: number,
    preferences: GenerationPreferences,
  ): Promise<CreateRecommendationRequest> {
    const result = await this.#extract(operation);
    this.#assertCurrent(operation);
    if ("failure" in result) {
      throw new PollingStopped();
    }
    const payload = canonicalizeRequest({
      body: result.preview.body,
      ...requestPreferenceFields(preferences),
      source_url: result.preview.sourceUrl,
      title: result.preview.title,
    });
    const currentDigest = await this.#digest(payload);
    this.#assertCurrent(operation);
    if (currentDigest !== digest) {
      throw new PollingStopped();
    }
    return payload;
  }

  async #refreshAfterConflict(id: string, operation: number): Promise<void> {
    try {
      const latest = await this.#api.getRecommendation(id, this.#signal());
      this.#assertCurrent(operation);
      if (this.#digestValue !== null) {
        await this.#registry.transition(
          this.#digestValue,
          latest.reviewStatus === "completed" ? "completed" : "reviewing",
          latest.id,
        );
        this.#assertCurrent(operation);
      }
      this.#showRecommendation(
        latest,
        "다른 검토 상태가 확인되어 최신 내용을 불러왔습니다. 변경 내용을 다시 확인해 주세요.",
      );
    } catch (error) {
      if (operation !== this.#operation) {
        return;
      }
      if (!(error instanceof StaleOperation) && !isAbort(error)) {
        this.#renderFailure(
          error instanceof RegistryQuarantinedError ? registryFailure() : apiFailure(error),
        );
      }
    }
  }

  async #handleWorkflowError(
    error: unknown,
    operation: number,
    phase: GenerationPhase,
  ): Promise<void> {
    this.#releaseBody();
    if (error instanceof ResponseProvenanceMismatch) {
      if (phase === "restore") {
        this.#renderFailure(registryFailure());
        return;
      }
      const digest = this.#digestValue;
      if (digest !== null) {
        try {
          await this.#registry.transition(digest, "indeterminate");
          this.#assertCurrent(operation);
          this.#replacementIntent = { digest, state: "indeterminate" };
        } catch (registryError) {
          if (operation !== this.#operation || registryError instanceof StaleOperation) return;
          this.#renderFailure(registryFailure());
          return;
        }
      }
      this.#renderFailure(replacementFailure("indeterminate"));
      return;
    }
    if (error instanceof RegistryQuarantinedError || error instanceof RegistryFullError) {
      this.#renderFailure(registryFailure(error instanceof RegistryFullError));
      return;
    }
    if (error instanceof CanonicalPayloadError) {
      this.#renderFailure(
        workflowFailure("invalid_payload", error.message, "요청을 만들 수 없습니다", "retry"),
      );
      return;
    }
    if (phase === "preflight" || phase === "restore") {
      this.#renderFailure(apiFailure(error));
      return;
    }
    const digest = this.#digestValue;
    if (error instanceof ApiClientError && error.problem?.code === "idempotency_conflict") {
      this.#renderFailure(registryFailure());
      return;
    }
    if (digest !== null) {
      const state = registryStateForGenerationError(error);
      try {
        await this.#registry.transition(digest, state);
        this.#assertCurrent(operation);
        if (state === "indeterminate" || state === "terminal_failure") {
          this.#replacementIntent = { digest, state };
        }
      } catch (registryError) {
        if (operation !== this.#operation || registryError instanceof StaleOperation) {
          return;
        }
        this.#renderFailure(registryFailure());
        return;
      }
    }
    if (error instanceof PollingStopped) {
      this.#renderFailure(
        workflowFailure(
          "polling_stopped",
          "60초 안에 결과를 확인하지 못했습니다. 현재 글을 다시 읽으면 같은 key로 결과를 확인합니다.",
          "결과 확인이 필요합니다",
          "retry",
        ),
      );
      return;
    }
    if (error instanceof ApiClientError) {
      const code = error.problem?.code;
      if (
        code === "generation_indeterminate" ||
        error.status === null ||
        code === "idempotency_conflict"
      ) {
        this.#renderFailure(replacementFailure("indeterminate"));
        return;
      }
      if (code === "generation_refused" || code === "generation_invalid" || error.replayed) {
        this.#renderFailure(replacementFailure("terminal_failure"));
        return;
      }
      this.#renderFailure(apiFailure(error));
      return;
    }
    this.#renderFailure(apiFailure(error));
  }

  async #extract(
    operation: number,
  ): Promise<{ failure: CaptureFailure } | { preview: CapturedPostPreview }> {
    const before = await this.#gateway.getActiveTab();
    this.#assertCurrent(operation);
    this.#activeTabId = before.id;
    if (parseSupportedNaverUrl(before.url) === null) {
      return { failure: { code: "unsupported_url" } };
    }
    const frames = await this.#gateway.captureAllFrames(before.id);
    this.#assertCurrent(operation);
    const after = await this.#gateway.getActiveTab();
    this.#assertCurrent(operation);
    if (before.id !== after.id || before.url !== after.url) {
      return { failure: { code: "stale_page" } };
    }
    const captured = chooseCapturedPost(before, frames);
    return captured.ok ? { preview: captured.preview } : { failure: captured.failure };
  }

  #showRecommendation(recommendation: Recommendation, notice?: string): void {
    this.#recommendation = recommendation;
    this.#preferences = {
      commentLength: recommendation.commentLength,
      commentMood: recommendation.commentMood,
      personalizationMode: recommendation.personalizationMode,
      relationshipLevel: recommendation.relationshipLevel,
      speechStyle: recommendation.speechStyle,
    };
    this.#selectedCandidateId = recommendation.selectedCandidateId;
    const selected = recommendation.candidates.find(
      (candidate) => candidate.id === recommendation.selectedCandidateId,
    );
    this.#editedComment = recommendation.editedComment ?? selected?.comment ?? "";
    this.#copied = false;
    const kind =
      recommendation.reviewStatus === "completed"
        ? "completed"
        : recommendation.reviewStatus === "approved"
          ? "approved"
          : "review";
    this.#view.render({ kind, ...this.#presentation(notice) });
  }

  #renderReview(notice?: string): void {
    const recommendation = this.#recommendation;
    if (recommendation === null) {
      return;
    }
    const kind =
      recommendation.reviewStatus === "completed"
        ? "completed"
        : recommendation.reviewStatus === "approved"
          ? "approved"
          : "review";
    this.#view.render({ kind, ...this.#presentation(notice) });
  }

  #presentation(notice?: string): ReviewPresentation {
    const recommendation = this.#recommendation;
    if (recommendation === null) {
      throw new Error("Recommendation is not available");
    }
    return {
      copied: this.#copied,
      discoveryPost: this.#discoveryPost,
      editedComment: this.#editedComment,
      engagementRun: this.#engagementRun,
      neighborMessage: this.#neighborMessage,
      recommendation,
      selectedCandidateId: this.#selectedCandidateId,
      ...(notice === undefined ? {} : { notice }),
    };
  }

  async #initialize(): Promise<void> {
    const lifecycle = this.#operation;
    try {
      const stored = await this.#lengthStore.load();
      this.#assertCurrent(lifecycle);
      const { closingPhrase, ...generationPreferences } = stored;
      this.#savedPreferences = { ...generationPreferences };
      this.#preferences = { ...generationPreferences };
      this.#savedClosingPhrase = closingPhrase;
      this.#closingPhrase = closingPhrase;
      await this.#captureActivePost();
    } catch (error) {
      if (error instanceof StaleOperation || lifecycle !== this.#operation) return;
      this.#renderFailure(
        workflowFailure(
          "storage_unavailable",
          "기본 댓글 설정을 안전하게 초기화하지 못했습니다. Browser storage를 확인해 주세요.",
          "Extension storage를 준비하지 못했습니다",
          null,
        ),
      );
    }
  }

  #renderPreview(): void {
    if (this.#preview === null) return;
    this.#view.render({
      closingPhrase: this.#closingPhrase,
      kind: "preview",
      ...(this.#preferenceNotice === undefined ? {} : { preferenceNotice: this.#preferenceNotice }),
      preferences: { ...this.#preferences },
      preview: this.#preview,
    });
  }

  #assertRecommendationPreferences(
    recommendation: Recommendation,
    expected: GenerationPreferences,
    restored: boolean,
  ): void {
    const actual: GenerationPreferences = {
      commentLength: recommendation.commentLength,
      commentMood: recommendation.commentMood,
      personalizationMode: recommendation.personalizationMode,
      relationshipLevel: recommendation.relationshipLevel,
      speechStyle: recommendation.speechStyle,
    };
    if (!samePreferences(actual, expected)) {
      if (restored) throw new RegistryQuarantinedError();
      throw new ResponseProvenanceMismatch();
    }
  }

  #beginOperation(): number {
    this.#abort?.abort();
    this.#abort = new AbortController();
    return ++this.#operation;
  }

  #invalidate(): void {
    this.#approval?.cancelPendingApproval();
    this.#operation += 1;
    this.#abort?.abort();
    this.#abort = null;
    this.#busy = false;
    this.#digestValue = null;
    this.#replacementIntent = null;
    this.#regenerationIntent = null;
    this.#discoveryPost = null;
    this.#engagementRun = null;
    this.#releaseAllContent();
    this.#view.clearSensitiveContent();
  }

  #signal(): AbortSignal {
    if (this.#abort === null) {
      throw new StaleOperation();
    }
    return this.#abort.signal;
  }

  #assertCurrent(operation: number): void {
    if (operation !== this.#operation) {
      throw new StaleOperation();
    }
  }

  #releaseBody(): void {
    this.#preview = null;
  }

  #dispatchEngagementUpdate(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("engagement-run-updated"));
    window.dispatchEvent(new CustomEvent("discovery-post-updated"));
  }

  #releaseAllContent(): void {
    this.#preview = null;
    this.#recommendation = null;
    this.#selectedCandidateId = null;
    this.#editedComment = "";
    this.#copied = false;
  }

  #renderFailure(failure: CaptureFailure | WorkflowFailure): void {
    this.#releaseAllContent();
    this.#view.render({ failure, kind: "error" });
  }
}

function commentInputNotice(result: CommentInputResult): string {
  return {
    ambiguous:
      "댓글 입력란이 여러 개 보여 자동으로 선택하지 않았습니다. 승인된 댓글을 복사해 직접 붙여넣어 주세요.",
    filled: "네이버 댓글 입력란에 초안을 넣었습니다. 내용을 확인한 뒤 직접 등록해 주세요.",
    not_found:
      "댓글 입력란과 댓글쓰기 버튼을 찾지 못했습니다. 로그인·댓글 허용 상태를 확인하거나 복사해 주세요.",
    open_failed:
      "댓글 쓰기를 열었지만 입력란을 확인하지 못했습니다. 로그인·댓글 허용 상태를 확인하거나 복사해 주세요.",
    occupied:
      "댓글 입력란에 기존 내용이 있어 덮어쓰지 않았습니다. 기존 내용을 확인하거나 승인된 댓글을 복사해 주세요.",
    permission_denied:
      "현재 페이지에 댓글을 넣을 권한이 없습니다. toolbar 아이콘을 다시 누르거나 댓글을 복사해 주세요.",
    stale_page:
      "현재 탭이 바뀌어 댓글을 넣지 않았습니다. 원래 글로 돌아가거나 댓글을 복사해 주세요.",
  }[result];
}

function approvedComment(recommendation: Recommendation): string {
  const selected = recommendation.candidates.find(
    (candidate) => candidate.id === recommendation.selectedCandidateId,
  );
  return recommendation.editedComment ?? selected?.comment ?? "";
}

function boundNeighborMessage(value: string): string {
  return Array.from(value).slice(0, 500).join("");
}

function sameOptionalPost(value: string | undefined, expected: string): boolean {
  return value !== undefined && sameSupportedNaverPost(value, expected);
}

function engagementNotice(result: EngagementExecutionResult): string {
  if (result.status === "completed") {
    return "이 글의 승인된 교류를 완료했습니다. 결과를 확인한 뒤 다음 글로 이동하세요.";
  }
  if (result.status === "unconfirmed") {
    return "외부 동작의 완료 여부를 확인하지 못했습니다. 중복 방지를 위해 자동 재시도하지 않습니다.";
  }
  if (result.status === "rejected") {
    return "이 글의 실행 승인이 유효하지 않아 아무 작업도 실행하지 않았습니다.";
  }
  const conflicts: Record<string, string> = {
    engagement_approval_bound:
      "이 승인 확인은 다른 실행에 이미 사용되어 새 동작을 시작하지 않았습니다. 다시 확인해 주세요.",
    engagement_post_recommendation_mismatch:
      "이 글은 다른 추천 댓글과 연결되어 있어 자동 실행하지 않았습니다. 글을 다시 열어 새 추천을 생성해 주세요.",
    engagement_publisher_missing:
      "신규 이웃 후보의 블로그 정보를 확인하지 못해 서로이웃 신청을 시작하지 않았습니다.",
    engagement_recommendation_not_approved:
      "완료로 기록된 댓글은 새 자동 실행에 사용하지 않습니다. 직접 처리 기록을 확인하거나 새 추천을 생성해 주세요.",
    engagement_source_mismatch:
      "현재 열린 글과 승인 댓글이 달라 자동 실행하지 않았습니다. 같은 글을 다시 열어 주세요.",
  };
  if (result.code in conflicts) return conflicts[result.code] as string;
  return `교류가 중단되었습니다 (${result.code}). 성공한 단계는 다시 실행하지 않습니다.`;
}

function captureFailure(code: CaptureFailure["code"]): CaptureFailure {
  return { code };
}

function registryFailure(full = false): WorkflowFailure {
  return workflowFailure(
    full ? "registry_full" : "registry_invalid",
    full
      ? "보호 중인 retry 작업이 20개입니다. 새 요청 전에 registry 정리를 명시적으로 확인해 주세요."
      : "retry registry를 안전하게 읽지 못했습니다. 자동 재시도를 중단했습니다.",
    "Retry registry 확인이 필요합니다",
    "cleanup",
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
