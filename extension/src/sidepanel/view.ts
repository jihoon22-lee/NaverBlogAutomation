import { PREVIEW_CODE_POINTS, boundCodePoints } from "../extraction/normalize";
import type { CaptureFailureCode } from "../extraction/types";
import { MAX_CLOSING_PHRASE_CODE_POINTS } from "../preferences/model";
import type { PanelActions, PanelState, PanelView, ReviewPresentation } from "./state";

const FAILURE_MESSAGES: Record<CaptureFailureCode, string> = {
  empty_article: "본문 영역을 찾지 못했습니다. 페이지 로딩을 확인한 뒤 다시 시도해 주세요.",
  extraction_failed: "페이지 구조가 예상과 달라 본문을 확인하지 못했습니다.",
  no_active_tab: "네이버 글 탭을 열고, 위의 ‘네이버 접근 허용’을 선택한 뒤 다시 시도해 주세요.",
  permission_denied:
    "이 페이지를 읽을 권한이 없습니다. 네이버 블로그 탭에서 확장 아이콘을 다시 눌러 주세요.",
  short_article: "추출된 본문이 너무 짧습니다. 글이 완전히 로드되었는지 확인해 주세요.",
  stale_page: "탭 또는 페이지가 변경되었습니다. 현재 글을 다시 읽어 주세요.",
  unsupported_url: "지원되는 HTTPS 네이버 블로그 글에서만 본문을 읽을 수 있습니다.",
};

function requireElement<T extends Element>(document: Document, selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing Side Panel element: ${selector}`);
  }
  return element;
}

export class DomPanelView implements PanelView {
  readonly #app: HTMLElement;
  readonly #bodyPreview: HTMLElement;
  readonly #cancelButton: HTMLButtonElement;
  readonly #candidateList: HTMLFieldSetElement;
  readonly #changeOptionsButton: HTMLButtonElement;
  readonly #characterCount: HTMLElement;
  readonly #cleanupButton: HTMLButtonElement;
  readonly #completeButton: HTMLButtonElement;
  readonly #copyButton: HTMLButtonElement;
  readonly #document: Document;
  readonly #editCount: HTMLElement;
  readonly #editSection: HTMLElement;
  readonly #editedUseButton: HTMLButtonElement;
  readonly #editedComment: HTMLTextAreaElement;
  readonly #engagementRunButton: HTMLButtonElement;
  readonly #engagementRunPanel: HTMLElement;
  readonly #engagementStepResults: HTMLElement;
  readonly #errorMessage: HTMLElement;
  readonly #errorPanel: HTMLElement;
  readonly #errorTitle: HTMLElement;
  readonly #generateButton: HTMLButtonElement;
  readonly #generatedCommentLength: HTMLElement;
  readonly #generatedCommentMood: HTMLElement;
  readonly #generatedRelationship: HTMLElement;
  readonly #generatedSpeechStyle: HTMLElement;
  readonly #commentLengthOptions: HTMLFieldSetElement;
  readonly #commentMoodOptions: HTMLFieldSetElement;
  readonly #closingPhrase: HTMLInputElement;
  readonly #closingPhraseCount: HTMLElement;
  readonly #preferenceNotice: HTMLElement;
  readonly #preferenceSummary: HTMLElement;
  readonly #personalizationMode: HTMLInputElement;
  readonly #personalizationResultNotice: HTMLElement;
  readonly #neighborMessage: HTMLTextAreaElement;
  readonly #neighborMessageField: HTMLElement;
  readonly #relationshipOptions: HTMLFieldSetElement;
  readonly #regenerateButton: HTMLButtonElement;
  readonly #speechStyleOptions: HTMLFieldSetElement;
  readonly #savePreferencesButton: HTMLButtonElement;
  readonly #postTitle: HTMLElement;
  readonly #postUrl: HTMLElement;
  readonly #previewPanel: HTMLElement;
  readonly #previewTitle: HTMLElement;
  readonly #progressMessage: HTMLElement;
  readonly #progressPanel: HTMLElement;
  readonly #qualityWarningList: HTMLElement;
  readonly #qualityWarningPanel: HTMLElement;
  readonly #replaceButton: HTMLButtonElement;
  readonly #resultTitle: HTMLElement;
  readonly #retryButton: HTMLButtonElement;
  readonly #retryFillButton: HTMLButtonElement;
  readonly #reviewNotice: HTMLElement;
  readonly #reviewPanel: HTMLElement;
  readonly #reviewStatus: HTMLElement;
  readonly #status: HTMLElement;
  readonly #summary: HTMLElement;
  readonly #topics: HTMLElement;
  readonly #truncationNotice: HTMLElement;
  #currentKind: PanelState["kind"] | null = null;

  constructor(document: Document) {
    this.#document = document;
    this.#app = requireElement(document, "#app");
    this.#changeOptionsButton = requireElement(document, "#change-options-button");
    this.#bodyPreview = requireElement(document, "#body-preview");
    this.#cancelButton = requireElement(document, "#cancel-button");
    this.#candidateList = requireElement(document, "#candidate-list");
    this.#characterCount = requireElement(document, "#character-count");
    this.#cleanupButton = requireElement(document, "#cleanup-button");
    this.#completeButton = requireElement(document, "#complete-button");
    this.#copyButton = requireElement(document, "#copy-button");
    this.#editCount = requireElement(document, "#edit-count");
    this.#editSection = requireElement(document, "#edit-section");
    this.#editedComment = requireElement(document, "#edited-comment");
    this.#editedUseButton = requireElement(document, "#edited-use-button");
    this.#engagementRunButton = requireElement(document, "#engagement-run-button");
    this.#engagementRunPanel = requireElement(document, "#engagement-run-panel");
    this.#engagementStepResults = requireElement(document, "#engagement-step-results");
    this.#errorMessage = requireElement(document, "#error-message");
    this.#errorPanel = requireElement(document, "#error-panel");
    this.#errorTitle = requireElement(document, "#error-title");
    this.#generateButton = requireElement(document, "#generate-button");
    this.#generatedCommentLength = requireElement(document, "#generated-comment-length");
    this.#generatedCommentMood = requireElement(document, "#generated-comment-mood");
    this.#generatedRelationship = requireElement(document, "#generated-relationship");
    this.#generatedSpeechStyle = requireElement(document, "#generated-speech-style");
    this.#commentLengthOptions = requireElement(document, "#comment-length-options");
    this.#commentMoodOptions = requireElement(document, "#comment-mood-options");
    this.#closingPhrase = requireElement(document, "#closing-phrase");
    this.#closingPhraseCount = requireElement(document, "#closing-phrase-count");
    this.#preferenceNotice = requireElement(document, "#preference-notice");
    this.#preferenceSummary = requireElement(document, "#preference-summary");
    this.#personalizationMode = requireElement(document, "#personalization-mode");
    this.#personalizationResultNotice = requireElement(document, "#personalization-result-notice");
    this.#neighborMessage = requireElement(document, "#neighbor-message");
    this.#neighborMessageField = requireElement(document, "#neighbor-message-field");
    this.#relationshipOptions = requireElement(document, "#relationship-options");
    this.#regenerateButton = requireElement(document, "#regenerate-button");
    this.#speechStyleOptions = requireElement(document, "#speech-style-options");
    this.#savePreferencesButton = requireElement(document, "#save-preferences-button");
    this.#postTitle = requireElement(document, "#post-title");
    this.#postUrl = requireElement(document, "#post-url");
    this.#previewPanel = requireElement(document, "#preview-panel");
    this.#previewTitle = requireElement(document, "#preview-title");
    this.#progressMessage = requireElement(document, "#progress-message");
    this.#progressPanel = requireElement(document, "#progress-panel");
    this.#qualityWarningList = requireElement(document, "#quality-warning-list");
    this.#qualityWarningPanel = requireElement(document, "#quality-warning-panel");
    this.#replaceButton = requireElement(document, "#replace-button");
    this.#resultTitle = requireElement(document, "#result-title");
    this.#retryButton = requireElement(document, "#retry-button");
    this.#retryFillButton = requireElement(document, "#retry-fill-button");
    this.#reviewNotice = requireElement(document, "#review-notice");
    this.#reviewPanel = requireElement(document, "#review-panel");
    this.#reviewStatus = requireElement(document, "#review-status");
    this.#status = requireElement(document, "#status");
    this.#summary = requireElement(document, "#summary");
    this.#topics = requireElement(document, "#topics");
    this.#truncationNotice = requireElement(document, "#truncation-notice");
  }

  bind(actions: PanelActions): void {
    this.#retryButton.addEventListener("click", actions.retry);
    this.#generateButton.addEventListener("click", actions.generate);
    this.#cancelButton.addEventListener("click", actions.cancel);
    this.#changeOptionsButton.addEventListener("click", actions.changeOptions);
    this.#editedUseButton.addEventListener("click", actions.useEdited);
    this.#copyButton.addEventListener("click", actions.copy);
    this.#retryFillButton.addEventListener("click", actions.refill);
    this.#completeButton.addEventListener("click", actions.complete);
    this.#engagementRunButton.addEventListener("click", actions.engage);
    this.#neighborMessage.addEventListener("input", () => {
      const bounded = Array.from(this.#neighborMessage.value).slice(0, 500).join("");
      if (bounded !== this.#neighborMessage.value) this.#neighborMessage.value = bounded;
      actions.changeNeighborMessage(this.#neighborMessage.value);
    });
    this.#relationshipOptions.addEventListener("change", (event) => {
      const input = this.#radioInput(event, "relationship");
      if (input !== null) actions.changeRelationship(input.value);
    });
    this.#speechStyleOptions.addEventListener("change", (event) => {
      const input = this.#radioInput(event, "speech-style");
      if (input !== null) actions.changeSpeechStyle(input.value);
    });
    this.#commentLengthOptions.addEventListener("change", (event) => {
      const input = this.#radioInput(event, "comment-length");
      if (input !== null) actions.changeCommentLength(input.value);
    });
    this.#commentMoodOptions.addEventListener("change", (event) => {
      const input = this.#radioInput(event, "comment-mood");
      if (input !== null) actions.changeCommentMood(input.value);
    });
    this.#personalizationMode.addEventListener("change", () => {
      actions.changePersonalizationMode(
        this.#personalizationMode.checked ? "completed_examples" : "off",
      );
    });
    this.#closingPhrase.addEventListener("input", () => {
      const bounded = Array.from(this.#closingPhrase.value)
        .slice(0, MAX_CLOSING_PHRASE_CODE_POINTS)
        .join("");
      if (bounded !== this.#closingPhrase.value) this.#closingPhrase.value = bounded;
      this.#closingPhraseCount.textContent = `${Array.from(this.#closingPhrase.value).length.toLocaleString("ko-KR")} / 50자`;
      actions.changeClosingPhrase(this.#closingPhrase.value);
    });
    this.#regenerateButton.addEventListener("click", actions.regenerate);
    this.#savePreferencesButton.addEventListener("click", actions.savePreferences);
    this.#editedComment.addEventListener("input", () => {
      this.#editCount.textContent = `${Array.from(this.#editedComment.value).length.toLocaleString("ko-KR")} / 500자`;
      actions.edit(this.#editedComment.value);
    });
    this.#candidateList.addEventListener("change", (event) => {
      const input = event.target;
      const Input = this.#document.defaultView?.HTMLInputElement;
      if (Input !== undefined && input instanceof Input && input.name === "candidate") {
        actions.select(input.value);
      }
    });
    this.#candidateList.addEventListener("click", (event) => {
      const target = event.target;
      const Button = this.#document.defaultView?.HTMLButtonElement;
      if (Button !== undefined && target instanceof Button) {
        const candidateId = target.dataset.useCandidate;
        if (candidateId !== undefined) actions.useCandidate(candidateId);
      }
    });
    this.#replaceButton.addEventListener("click", () => {
      if (
        this.#document.defaultView?.confirm(
          "이전 provider 결과가 존재할 수 있습니다. 중복 생성 가능성을 이해하고 새 key로 시도할까요?",
        ) === true
      ) {
        actions.replace();
      }
    });
    this.#cleanupButton.addEventListener("click", () => {
      if (
        this.#document.defaultView?.confirm(
          "저장된 retry metadata를 삭제하면 이전 작업을 자동 복구할 수 없습니다. 정리할까요?",
        ) === true
      ) {
        actions.cleanup();
      }
    });
  }

  async copyText(value: string): Promise<boolean> {
    try {
      const clipboard = this.#document.defaultView?.navigator.clipboard;
      if (clipboard === undefined) {
        throw new Error("Clipboard API unavailable");
      }
      await clipboard.writeText(value);
      return true;
    } catch {
      this.#editedComment.focus();
      this.#editedComment.select();
      return false;
    }
  }

  clearSensitiveContent(): void {
    this.#clearSensitiveDom();
  }

  render(state: PanelState): void {
    const previousKind = this.#currentKind;
    this.#currentKind = state.kind;
    const busy =
      state.kind === "extracting" || state.kind === "generating" || state.kind === "saving";
    this.#app.setAttribute("aria-busy", String(busy));
    this.#errorPanel.hidden = state.kind !== "error";
    this.#previewPanel.hidden = state.kind !== "preview";
    this.#progressPanel.hidden = state.kind !== "generating";
    this.#reviewPanel.hidden = !["review", "saving", "engaging", "approved", "completed"].includes(
      state.kind,
    );
    for (const input of this.#preferenceInputs()) input.disabled = busy;
    this.#closingPhrase.disabled = busy;
    this.#personalizationMode.disabled = busy;
    this.#regenerateButton.disabled = busy;
    this.#changeOptionsButton.disabled = busy;
    this.#savePreferencesButton.disabled = busy;
    if (state.kind === "extracting" || state.kind === "error" || state.kind === "generating") {
      this.#clearSensitiveDom();
    }

    if (state.kind === "extracting") {
      this.#status.textContent = "현재 글의 본문을 확인하고 있습니다.";
      return;
    }
    if (state.kind === "error") {
      this.#renderError(state.failure);
      return;
    }
    if (state.kind === "generating") {
      this.#status.textContent = state.message;
      this.#progressMessage.textContent = state.message;
      this.#cancelButton.hidden = !state.canCancel;
      return;
    }
    if (state.kind === "preview") {
      this.#renderPreview(state, previousKind !== "preview");
      return;
    }
    this.#renderRecommendation(
      state,
      state.kind,
      previousKind === null ||
        !["approved", "completed", "engaging", "review", "saving"].includes(previousKind),
    );
  }

  #renderError(failure: Extract<PanelState, { kind: "error" }>["failure"]): void {
    this.#status.textContent = "작업이 중단되었습니다.";
    const workflow = "action" in failure ? failure : null;
    this.#errorTitle.textContent = workflow?.title ?? "본문을 읽지 못했습니다";
    this.#errorMessage.textContent =
      workflow?.message ?? FAILURE_MESSAGES[failure.code as CaptureFailureCode];
    this.#retryButton.hidden = workflow !== null && workflow.action !== "retry";
    this.#replaceButton.hidden = workflow?.action !== "replace";
    this.#cleanupButton.hidden = workflow?.action !== "cleanup";
    this.#focus(this.#errorTitle);
  }

  #renderPreview(state: Extract<PanelState, { kind: "preview" }>, focusHeading: boolean): void {
    const { closingPhrase, preferences, preview } = state;
    this.#status.textContent = "본문 preview를 확인했습니다. 아직 local API로 전송하지 않았습니다.";
    this.#postTitle.textContent = preview.title;
    this.#postUrl.textContent = preview.sourceUrl;
    this.#characterCount.textContent = preview.truncated
      ? `${preview.transmittedLength.toLocaleString("ko-KR")}자 전송 예정 / ${preview.originalLength.toLocaleString("ko-KR")}자 추출`
      : `${preview.transmittedLength.toLocaleString("ko-KR")}자`;
    const bounded = boundCodePoints(preview.body, PREVIEW_CODE_POINTS);
    this.#bodyPreview.textContent = bounded.truncated ? `${bounded.text}\n…` : bounded.text;
    this.#truncationNotice.hidden = !preview.truncated;
    this.#truncationNotice.textContent = preview.truncated
      ? `API 제한에 맞춰 앞 ${preview.transmittedLength.toLocaleString("ko-KR")}자만 전송됩니다.`
      : "";
    this.#generateButton.disabled = false;
    this.#setChecked("relationship", preferences.relationshipLevel);
    this.#setChecked("speech-style", preferences.speechStyle);
    this.#setChecked("comment-length", preferences.commentLength);
    this.#setChecked("comment-mood", preferences.commentMood);
    this.#personalizationMode.checked = preferences.personalizationMode === "completed_examples";
    if (this.#document.activeElement !== this.#closingPhrase) {
      this.#closingPhrase.value = closingPhrase;
    }
    this.#closingPhraseCount.textContent = `${Array.from(this.#closingPhrase.value).length.toLocaleString("ko-KR")} / 50자`;
    this.#preferenceSummary.textContent = `${relationshipLabel(preferences.relationshipLevel)} · ${speechStyleLabel(preferences.speechStyle)} · ${commentLengthLabel(preferences.commentLength)} · ${commentMoodLabel(preferences.commentMood)} · ${personalizationLabel(preferences.personalizationMode)}`;
    const banmal = this.#document.querySelector<HTMLInputElement>(
      'input[name="speech-style"][value="banmal"]',
    );
    if (banmal !== null) banmal.disabled = preferences.relationshipLevel !== "close";
    this.#preferenceNotice.hidden = state.preferenceNotice === undefined;
    this.#preferenceNotice.textContent = state.preferenceNotice ?? "";
    if (focusHeading) this.#focus(this.#previewTitle);
  }

  #renderRecommendation(
    presentation: ReviewPresentation,
    kind: "approved" | "completed" | "engaging" | "review" | "saving",
    focusHeading: boolean,
  ): void {
    const { recommendation } = presentation;
    this.#status.textContent =
      kind === "engaging"
        ? "승인한 교류를 한 단계씩 실행하고 있습니다."
        : kind === "saving"
          ? "검토 상태를 저장하고 있습니다."
          : kind === "completed"
            ? "수동 등록 완료로 표시했습니다."
            : "추천 댓글을 직접 검토해 주세요.";
    this.#reviewStatus.textContent =
      kind === "engaging"
        ? "교류 실행 중"
        : kind === "saving"
          ? "저장 중"
          : kind === "completed"
            ? "수동 workflow 완료"
            : kind === "approved"
              ? "승인됨"
              : "검토 중";
    this.#generatedRelationship.textContent = relationshipLabel(recommendation.relationshipLevel);
    this.#generatedSpeechStyle.textContent = speechStyleLabel(recommendation.speechStyle);
    this.#generatedCommentLength.textContent = commentLengthLabel(recommendation.commentLength);
    this.#generatedCommentMood.textContent = commentMoodLabel(recommendation.commentMood);
    this.#personalizationResultNotice.textContent = recommendation.personalizationApplied
      ? `최근 완료 댓글 ${recommendation.personalizationSampleCount}개를 스타일 예시로 적용했습니다.`
      : recommendation.personalizationMode === "completed_examples"
        ? "사용 가능한 완료 댓글이 없어 스타일 예시 없이 생성했습니다."
        : "스타일 예시 없이 생성했습니다.";
    const warnings = [...new Set(recommendation.qualityWarnings)];
    this.#qualityWarningPanel.hidden = warnings.length === 0;
    this.#qualityWarningList.replaceChildren(
      ...warnings.map((warning) => {
        const item = this.#document.createElement("li");
        item.textContent = qualityWarningLabel(warning);
        return item;
      }),
    );
    this.#summary.textContent = recommendation.summary;
    this.#topics.replaceChildren(
      ...recommendation.topics.map((topic) => {
        const item = this.#document.createElement("li");
        item.textContent = topic;
        return item;
      }),
    );
    const activeElement = this.#document.activeElement;
    const Input = this.#document.defaultView?.HTMLInputElement;
    const focusedCandidateId =
      Input !== undefined && activeElement instanceof Input && activeElement.name === "candidate"
        ? activeElement.value
        : null;
    const legend = this.#document.createElement("legend");
    legend.textContent = "댓글 후보";
    this.#candidateList.replaceChildren(legend);
    for (const candidate of recommendation.candidates) {
      const container = this.#document.createElement("div");
      container.className = "candidate";
      const input = this.#document.createElement("input");
      input.type = "radio";
      input.name = "candidate";
      input.value = candidate.id;
      input.id = `candidate-${candidate.id}`;
      input.checked = candidate.id === presentation.selectedCandidateId;
      input.disabled = kind !== "review";
      const contentId = `candidate-content-${candidate.id}`;
      input.setAttribute("aria-labelledby", contentId);
      const content = this.#document.createElement("label");
      content.id = contentId;
      content.htmlFor = input.id;
      const tone = this.#document.createElement("strong");
      tone.textContent = toneLabel(candidate.tone);
      const comment = this.#document.createElement("span");
      comment.textContent = candidate.comment;
      const detail = this.#document.createElement("small");
      detail.textContent = `본문 근거: ${candidate.referencedDetail}`;
      content.append(tone, comment, detail);
      container.append(input, content);
      if (kind === "review") {
        const useButton = this.#document.createElement("button");
        useButton.className = "candidate-use";
        useButton.dataset.useCandidate = candidate.id;
        useButton.type = "button";
        useButton.textContent = "이 댓글 사용";
        container.append(useButton);
      }
      this.#candidateList.append(container);
    }
    if (this.#editedComment.value !== presentation.editedComment) {
      this.#editedComment.value = presentation.editedComment;
    }
    this.#editedComment.readOnly = kind !== "review";
    this.#editSection.hidden = kind === "review" && presentation.selectedCandidateId === null;
    this.#editCount.textContent = `${Array.from(presentation.editedComment).length.toLocaleString("ko-KR")} / 500자`;
    this.#editedUseButton.hidden = kind !== "review";
    this.#renderEngagement(presentation, kind);
    this.#copyButton.hidden = kind === "review" || kind === "saving" || kind === "engaging";
    this.#retryFillButton.hidden = kind !== "approved";
    this.#completeButton.hidden = kind !== "approved";
    this.#regenerateButton.hidden = kind === "saving" || kind === "engaging";
    this.#changeOptionsButton.hidden = kind === "saving" || kind === "engaging";
    this.#reviewNotice.hidden = presentation.notice === undefined;
    this.#reviewNotice.textContent = presentation.notice ?? "";
    if (focusedCandidateId !== null) {
      const focusedCandidate = Array.from(
        this.#candidateList.querySelectorAll<HTMLInputElement>('input[name="candidate"]'),
      ).find((input) => input.value === focusedCandidateId);
      focusedCandidate?.focus();
    } else if (kind !== "saving" && focusHeading) {
      this.#focus(this.#resultTitle);
    }
  }

  #renderEngagement(
    presentation: ReviewPresentation,
    kind: "approved" | "completed" | "engaging" | "review" | "saving",
  ): void {
    const discoveryPost = presentation.discoveryPost ?? null;
    const engagementRun = presentation.engagementRun ?? null;
    const available = discoveryPost !== null && kind !== "review" && kind !== "saving";
    this.#engagementRunPanel.hidden = !available;
    if (!available || discoveryPost === null) {
      this.#engagementStepResults.replaceChildren();
      return;
    }
    const search = discoveryPost.source === "search";
    this.#neighborMessageField.hidden = !search;
    if (this.#document.activeElement !== this.#neighborMessage) {
      this.#neighborMessage.value = presentation.neighborMessage ?? "";
    }
    this.#neighborMessage.disabled = kind === "engaging" || engagementRun?.state === "unconfirmed";
    this.#engagementRunButton.textContent = search
      ? "공감·댓글 등록 후 서로이웃 신청"
      : "공감하고 승인 댓글 등록";
    this.#engagementRunButton.disabled =
      kind === "engaging" ||
      engagementRun?.state === "succeeded" ||
      engagementRun?.state === "unconfirmed";
    const steps =
      engagementRun?.steps ??
      (search
        ? [
            { name: "like", state: "pending" },
            { name: "comment", state: "pending" },
            { name: "mutual_neighbor", state: "pending" },
          ]
        : [
            { name: "like", state: "pending" },
            { name: "comment", state: "pending" },
          ]);
    this.#engagementStepResults.replaceChildren(
      ...steps.map((step) => {
        const item = this.#document.createElement("li");
        item.textContent = `${engagementStepLabel(step.name)} · ${engagementStateLabel(step.state)}`;
        return item;
      }),
    );
  }

  #focus(element: HTMLElement): void {
    this.#document.defaultView?.requestAnimationFrame(() => element.focus());
  }

  #clearSensitiveDom(): void {
    this.#bodyPreview.textContent = "";
    this.#postTitle.textContent = "";
    this.#postUrl.textContent = "";
    this.#summary.textContent = "";
    this.#topics.replaceChildren();
    this.#candidateList.replaceChildren();
    this.#editedComment.value = "";
    this.#neighborMessage.value = "";
    this.#engagementStepResults.replaceChildren();
    this.#engagementRunPanel.hidden = true;
    this.#editCount.textContent = "";
    this.#reviewNotice.textContent = "";
    this.#generatedRelationship.textContent = "";
    this.#generatedSpeechStyle.textContent = "";
    this.#generatedCommentLength.textContent = "";
    this.#generatedCommentMood.textContent = "";
    this.#personalizationResultNotice.textContent = "";
    this.#qualityWarningList.replaceChildren();
    this.#qualityWarningPanel.hidden = true;
    this.#editSection.hidden = true;
  }

  #preferenceInputs(): HTMLInputElement[] {
    return Array.from(
      this.#document.querySelectorAll<HTMLInputElement>(
        'input[name="relationship"], input[name="speech-style"], input[name="comment-length"], input[name="comment-mood"]',
      ),
    );
  }

  #radioInput(event: Event, name: string): HTMLInputElement | null {
    const input = event.target;
    const Input = this.#document.defaultView?.HTMLInputElement;
    return Input !== undefined && input instanceof Input && input.name === name ? input : null;
  }

  #setChecked(name: string, value: string): void {
    for (const input of this.#document.querySelectorAll<HTMLInputElement>(
      `input[name="${name}"]`,
    )) {
      input.checked = input.value === value;
    }
  }
}

function toneLabel(tone: string): string {
  return { curious: "궁금한 점", supportive: "응원", warm: "따뜻한 공감" }[tone] ?? tone;
}

function engagementStepLabel(value: string): string {
  return (
    {
      comment: "댓글 등록",
      like: "공감",
      mutual_neighbor: "서로이웃 신청",
    }[value] ?? value
  );
}

function engagementStateLabel(value: string): string {
  return (
    {
      failed: "중단됨",
      pending: "대기",
      running: "실행 중",
      skipped: "이미 완료",
      succeeded: "완료",
      unconfirmed: "확인 필요",
    }[value] ?? value
  );
}

function relationshipLabel(value: string): string {
  return (
    { close: "가까운 사이", friendly: "편한 이웃", new: "처음 교류", polite: "예의를 갖춘 사이" }[
      value
    ] ?? value
  );
}

function speechStyleLabel(value: string): string {
  return { banmal: "반말", honorific: "존댓말" }[value] ?? value;
}

function commentLengthLabel(value: string): string {
  return (
    { long: "길게 (200–320자)", medium: "보통 (100–160자)", short: "짧게 (40–80자)" }[value] ??
    value
  );
}

function commentMoodLabel(value: string): string {
  return { calm: "차분하게", lively: "활기차게", warm: "따뜻하게" }[value] ?? value;
}

function personalizationLabel(value: string): string {
  return value === "completed_examples" ? "스타일 활용" : "스타일 미사용";
}

function qualityWarningLabel(value: string): string {
  return (
    {
      candidate_roles_blurred: "댓글 후보별 역할 차이가 충분히 뚜렷하지 않을 수 있습니다.",
      candidates_too_similar: "댓글 후보가 서로 비슷할 수 있으니 내용을 비교해 주세요.",
      length_target_missed: "일부 댓글이 선택한 길이 범위를 벗어날 수 있습니다.",
    }[value] ?? value
  );
}
