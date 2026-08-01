/**
 * Settings screen for automatic discovery.
 *
 * Synchronization reports what it added, not only that it ran: "성공" with nothing added and "성공"
 * with twelve new posts need different follow-up. A missing search API key is stated as a partial
 * result rather than a failure, because neighbour collection keeps working without it.
 */

import { type SettingsState, isSettingsBusy } from "../controllers/settings";

export interface SettingsHandlers {
  onSave(): void;
  onSync(): void;
  onRefresh(): void;
  onFieldChange(patch: Partial<SettingsState["form"]>): void;
  onQueryChange(value: string): void;
  onAddSearch(): void;
  onDeleteSearch(id: string): void;
  onRefreshSearch(id: string): void;
  onNeighborFieldChange(patch: Partial<SettingsState["neighborForm"]>): void;
  onSaveNeighbor(): void;
  onToggleNeighbor(id: string): void;
  onDigestFieldChange(patch: Partial<SettingsState["digestForm"]>): void;
  onSaveDigest(): void;
  onCommentFieldChange(patch: Partial<SettingsState["commentForm"]>): void;
  onAutomationFieldChange(patch: Partial<SettingsState["automationForm"]>): void;
  onWritingFieldChange(patch: Partial<SettingsState["writingForm"]>): void;
  onSaveCommentSettings(): void;
  onSaveAutomationSettings(): void;
  onSaveWritingSettings(): void;
}

const SYNC_STATUS_LABELS: Record<string, string> = {
  never: "아직 동기화하지 않았습니다.",
  success: "마지막 동기화가 성공했습니다.",
  partial: "마지막 동기화가 일부만 성공했습니다.",
  failed: "마지막 동기화가 실패했습니다.",
};

const FEED_STATUS_LABELS: Record<string, string> = {
  ready: "RSS 확인 가능",
  unavailable: "RSS를 확인하지 못함",
  unknown: "아직 확인하지 않음",
};

/** Render the settings screen for `state`. */
export function renderSettings(
  root: Element,
  state: SettingsState,
  handlers: SettingsHandlers,
): void {
  const document = root.ownerDocument;
  root.textContent = "";

  const status = document.createElement("p");
  status.id = "workspace-status";
  status.setAttribute("role", "status");
  status.textContent = statusMessage(state);
  root.append(status);

  root.append(renderDiscoveryForm(document, state, handlers));
  root.append(renderSyncPanel(document, state, handlers));
  root.append(renderSearchPanel(document, state, handlers));
  root.append(renderNeighborPanel(document, state, handlers));
  root.append(renderDigestPanel(document, state, handlers));
  root.append(renderCommentSettings(document, state, handlers));
  root.append(renderAutomationSettings(document, state, handlers));
  root.append(renderWritingSettings(document, state, handlers));
}

function renderCommentSettings(
  document: Document,
  state: SettingsState,
  handlers: SettingsHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "comment-settings-panel";
  section.append(heading(document, "댓글 · AI 기본값"));
  section.append(
    selectField(
      document,
      "comment-relationship",
      "기본 관계",
      state.commentForm.relationshipLevel,
      [
        ["new", "신규"],
        ["polite", "정중"],
        ["friendly", "친근"],
        ["close", "친밀"],
      ],
      (value) =>
        handlers.onCommentFieldChange({
          relationshipLevel: value as SettingsState["commentForm"]["relationshipLevel"],
        }),
    ),
    selectField(
      document,
      "comment-speech",
      "기본 말투",
      state.commentForm.speechStyle,
      [
        ["honorific", "존댓말"],
        ["banmal", "반말"],
      ],
      (value) =>
        handlers.onCommentFieldChange({
          speechStyle: value as SettingsState["commentForm"]["speechStyle"],
        }),
    ),
    selectField(
      document,
      "comment-length",
      "기본 길이",
      state.commentForm.commentLength,
      [
        ["short", "짧게"],
        ["medium", "보통"],
        ["long", "길게"],
      ],
      (value) =>
        handlers.onCommentFieldChange({
          commentLength: value as SettingsState["commentForm"]["commentLength"],
        }),
    ),
    selectField(
      document,
      "comment-mood",
      "기본 분위기",
      state.commentForm.commentMood,
      [
        ["calm", "담담하게"],
        ["warm", "따뜻하게"],
        ["lively", "활기차게"],
      ],
      (value) =>
        handlers.onCommentFieldChange({
          commentMood: value as SettingsState["commentForm"]["commentMood"],
        }),
    ),
    selectField(
      document,
      "comment-personalization",
      "완료 댓글 개인화 사용",
      state.commentForm.personalizationMode,
      [
        ["off", "사용 안 함"],
        ["completed_examples", "완료 댓글 예시 사용"],
      ],
      (value) =>
        handlers.onCommentFieldChange({
          personalizationMode: value as SettingsState["commentForm"]["personalizationMode"],
        }),
    ),
  );
  section.append(
    textField(document, "closing-phrase", "마무리 문구", state.commentForm.closingPhrase, (value) =>
      handlers.onCommentFieldChange({ closingPhrase: value }),
    ),
    textField(
      document,
      "neighbor-message",
      "서로이웃 기본 메시지",
      state.commentForm.neighborMessage,
      (value) => handlers.onCommentFieldChange({ neighborMessage: value }),
    ),
  );
  section.append(
    button(
      document,
      "save-comment-settings-button",
      "댓글 기본값 저장",
      handlers.onSaveCommentSettings,
    ),
  );
  return section;
}

function renderAutomationSettings(
  document: Document,
  state: SettingsState,
  handlers: SettingsHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "automation-settings-panel";
  section.append(heading(document, "자동 실행과 안전"));
  const consent = document.createElement("label");
  const input = document.createElement("input");
  input.id = "automation-consent";
  input.type = "checkbox";
  input.checked = state.automationForm.accepted;
  input.addEventListener("change", () =>
    handlers.onAutomationFieldChange({ accepted: input.checked }),
  );
  consent.append(input, document.createTextNode("공감·댓글·서로이웃 신청 자동 실행에 동의합니다."));
  section.append(consent);
  section.append(
    numberField(
      document,
      "daily-like-cap",
      "일일 공감 상한",
      state.automationForm.dailyLikeCap,
      (value) => handlers.onAutomationFieldChange({ dailyLikeCap: value }),
    ),
    numberField(
      document,
      "daily-comment-cap",
      "일일 댓글 상한",
      state.automationForm.dailyCommentCap,
      (value) => handlers.onAutomationFieldChange({ dailyCommentCap: value }),
    ),
    numberField(
      document,
      "daily-neighbor-cap",
      "일일 서로이웃 상한",
      state.automationForm.dailyNeighborCap,
      (value) => handlers.onAutomationFieldChange({ dailyNeighborCap: value }),
    ),
    numberField(
      document,
      "min-interval-seconds",
      "최소 간격(초)",
      state.automationForm.minIntervalSeconds,
      (value) => handlers.onAutomationFieldChange({ minIntervalSeconds: value }),
    ),
    numberField(
      document,
      "max-consecutive-failures",
      "연속 실패 상한",
      state.automationForm.maxConsecutiveFailures,
      (value) => handlers.onAutomationFieldChange({ maxConsecutiveFailures: value }),
    ),
    allowedHoursField(document, state, handlers),
    numberField(
      document,
      "automation-jitter-percent",
      "간격 변동 비율(%)",
      state.automationForm.jitterPercent,
      (value) => handlers.onAutomationFieldChange({ jitterPercent: value }),
      0,
      90,
    ),
  );
  section.append(
    button(
      document,
      "save-automation-settings-button",
      "안전 설정 저장",
      handlers.onSaveAutomationSettings,
    ),
  );
  return section;
}

function allowedHoursField(
  document: Document,
  state: SettingsState,
  handlers: SettingsHandlers,
): Element {
  const field = document.createElement("fieldset");
  field.className = "allowed-hours-field";
  const legend = document.createElement("legend");
  legend.textContent = "자동 실행 허용 시간";
  field.append(legend);
  for (let hour = 0; hour < 24; hour += 1) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.automationForm.allowedHours.includes(hour);
    input.setAttribute("aria-label", `${hour}시 허용`);
    input.addEventListener("change", () => {
      const selected = new Set(state.automationForm.allowedHours);
      if (input.checked) selected.add(hour);
      else selected.delete(hour);
      handlers.onAutomationFieldChange({ allowedHours: [...selected].toSorted((a, b) => a - b) });
    });
    label.append(input, document.createTextNode(`${hour}시`));
    field.append(label);
  }
  return field;
}

function renderWritingSettings(
  document: Document,
  state: SettingsState,
  handlers: SettingsHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "writing-settings-panel";
  section.append(heading(document, "글쓰기 기본값"));
  section.append(
    selectField(
      document,
      "writing-length",
      "기본 길이",
      state.writingForm.targetLength,
      [
        ["short", "짧게"],
        ["medium", "보통"],
        ["long", "길게"],
      ],
      (value) =>
        handlers.onWritingFieldChange({
          targetLength: value as SettingsState["writingForm"]["targetLength"],
        }),
    ),
    selectField(
      document,
      "writing-tone",
      "기본 분위기",
      state.writingForm.tone,
      [
        ["calm", "담담하게"],
        ["warm", "따뜻하게"],
        ["lively", "활기차게"],
      ],
      (value) =>
        handlers.onWritingFieldChange({ tone: value as SettingsState["writingForm"]["tone"] }),
    ),
    selectField(
      document,
      "writing-structure",
      "기본 구성",
      state.writingForm.structure,
      [
        ["plain", "문단만"],
        ["sectioned", "구역 나누기"],
        ["story", "시간 순서"],
      ],
      (value) =>
        handlers.onWritingFieldChange({
          structure: value as SettingsState["writingForm"]["structure"],
        }),
    ),
    numberField(
      document,
      "writing-reference-post-count",
      "참고할 최근 글 수",
      state.writingForm.referencePostCount,
      (value) => handlers.onWritingFieldChange({ referencePostCount: value }),
      1,
      10,
    ),
    numberField(
      document,
      "writing-body-tag-cap",
      "본문 태그 상한",
      state.writingForm.bodyTagCap,
      (value) => handlers.onWritingFieldChange({ bodyTagCap: value }),
      1,
      30,
    ),
  );
  const vision = document.createElement("label");
  const check = document.createElement("input");
  check.id = "writing-image-vision";
  check.type = "checkbox";
  check.checked = state.writingForm.useImageVision;
  check.addEventListener("change", () =>
    handlers.onWritingFieldChange({ useImageVision: check.checked }),
  );
  vision.append(check, document.createTextNode("이미지 분석 사용"));
  section.append(
    vision,
    button(
      document,
      "save-writing-settings-button",
      "글쓰기 기본값 저장",
      handlers.onSaveWritingSettings,
    ),
  );
  return section;
}

function statusMessage(state: SettingsState): string {
  if (state.phase === "loading") return "설정을 불러오는 중입니다.";
  if (state.phase === "saving") return "설정을 저장하는 중입니다.";
  if (state.phase === "syncing") return "공개 정보를 모으는 중입니다.";
  if (state.phase === "failed") return state.error ?? "설정을 불러오지 못했습니다.";
  if (state.error !== null) return state.error;
  if (state.notice !== null) return state.notice;
  return "내 블로그 ID를 저장하면 이웃 새 글을 자동으로 모읍니다.";
}

function renderDiscoveryForm(
  document: Document,
  state: SettingsState,
  handlers: SettingsHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "discovery-settings-panel";
  const heading = document.createElement("h2");
  heading.textContent = "자동 탐색 설정";
  section.append(heading);

  const blogLabel = document.createElement("label");
  blogLabel.setAttribute("for", "own-blog-id");
  blogLabel.textContent = "내 블로그 ID";
  const blogInput = document.createElement("input");
  blogInput.id = "own-blog-id";
  blogInput.type = "text";
  blogInput.value = state.form.ownBlogId;
  blogInput.disabled = isSettingsBusy(state);
  blogInput.addEventListener("input", () => handlers.onFieldChange({ ownBlogId: blogInput.value }));
  section.append(blogLabel, blogInput);

  const enabledLabel = document.createElement("label");
  enabledLabel.className = "checkbox-label";
  const enabled = document.createElement("input");
  enabled.id = "discovery-enabled";
  enabled.type = "checkbox";
  enabled.checked = state.form.enabled;
  enabled.disabled = isSettingsBusy(state);
  enabled.addEventListener("change", () => handlers.onFieldChange({ enabled: enabled.checked }));
  enabledLabel.append(enabled, document.createTextNode("매일 자동으로 모으기"));
  section.append(enabledLabel);

  const hourLabel = document.createElement("label");
  hourLabel.setAttribute("for", "discovery-hour");
  hourLabel.textContent = "시각 (시)";
  const hour = numberInput(document, "discovery-hour", state.form.hour, 0, 23, state);
  hour.addEventListener("change", () => handlers.onFieldChange({ hour: Number(hour.value) }));

  const minuteLabel = document.createElement("label");
  minuteLabel.setAttribute("for", "discovery-minute");
  minuteLabel.textContent = "시각 (분)";
  const minute = numberInput(document, "discovery-minute", state.form.minute, 0, 59, state);
  minute.addEventListener("change", () => handlers.onFieldChange({ minute: Number(minute.value) }));
  section.append(hourLabel, hour, minuteLabel, minute);

  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent =
    "공개된 metadata만 모읍니다. 로그인 정보나 쿠키는 읽지 않고 Captcha를 우회하지 않습니다.";
  section.append(note);

  const save = document.createElement("button");
  save.type = "button";
  save.id = "save-discovery-button";
  save.textContent = "설정 저장";
  save.disabled = isSettingsBusy(state);
  save.addEventListener("click", () => handlers.onSave());
  section.append(save);

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.id = "refresh-settings-button";
  refresh.textContent = "새로고침";
  refresh.disabled = isSettingsBusy(state);
  refresh.addEventListener("click", () => handlers.onRefresh());
  section.append(refresh);
  return section;
}

function numberInput(
  document: Document,
  id: string,
  value: number,
  min: number,
  max: number,
  state: SettingsState,
): HTMLInputElement {
  const input = document.createElement("input");
  input.id = id;
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.disabled = isSettingsBusy(state);
  return input;
}

function renderSyncPanel(
  document: Document,
  state: SettingsState,
  handlers: SettingsHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "sync-panel";
  const heading = document.createElement("h2");
  heading.textContent = "지금 동기화";
  section.append(heading);

  const history = document.createElement("p");
  history.className = "sync-history";
  const settings = state.settings;
  if (settings === null) {
    history.textContent = "동기화 이력을 아직 확인하지 못했습니다.";
  } else {
    const label = SYNC_STATUS_LABELS[settings.lastStatus] ?? settings.lastStatus;
    const when = settings.lastSyncedAt === null ? "" : ` (${settings.lastSyncedAt})`;
    const detail = settings.lastDetail.length === 0 ? "" : ` ${settings.lastDetail}`;
    history.textContent = `${label}${when}${detail}`;
  }
  section.append(history);

  if (state.lastSync !== null) {
    const result = document.createElement("p");
    result.className = "sync-result";
    const sync = state.lastSync;
    const parts = [
      `새 이웃 ${sync.neighborsAdded}명`,
      `이웃 새 글 ${sync.neighborPostsAdded}건`,
      `검색 후보 ${sync.searchPostsAdded}건`,
    ];
    result.textContent = `${parts.join(", ")}을 모았습니다.`;
    section.append(result);

    if (sync.searchProvider === "none") {
      const missing = document.createElement("p");
      missing.className = "sync-provider-missing";
      missing.textContent =
        "검색 API key가 없어 검색 후보는 건너뜁니다. 이웃 새 글은 그대로 모았습니다.";
      section.append(missing);
    }
  }

  const sync = document.createElement("button");
  sync.type = "button";
  sync.id = "sync-discovery-button";
  sync.textContent = "지금 동기화";
  sync.disabled = isSettingsBusy(state) || state.settings === null;
  sync.addEventListener("click", () => handlers.onSync());
  section.append(sync);
  return section;
}

function renderSearchPanel(
  document: Document,
  state: SettingsState,
  handlers: SettingsHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "search-panel";
  const heading = document.createElement("h2");
  heading.textContent = "신규 이웃 검색어";
  section.append(heading);

  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent =
    "저장한 검색어의 모든 단어가 제목에 포함될 때만 후보로 보여줍니다. 검색어를 지우면 후보 목록에서만 숨고 이미 모인 글은 남습니다.";
  section.append(note);

  const label = document.createElement("label");
  label.setAttribute("for", "new-search-query");
  label.textContent = "검색어 추가";
  const input = document.createElement("input");
  input.id = "new-search-query";
  input.type = "text";
  input.value = state.newQuery;
  input.disabled = isSettingsBusy(state);
  input.addEventListener("input", () => handlers.onQueryChange(input.value));
  section.append(label, input);

  const add = document.createElement("button");
  add.type = "button";
  add.id = "add-search-button";
  add.textContent = "검색어 저장";
  add.disabled = isSettingsBusy(state);
  add.addEventListener("click", () => handlers.onAddSearch());
  section.append(add);

  if (state.searches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "search-empty";
    empty.textContent = "저장한 검색어가 없습니다. 이웃 새 글만 모읍니다.";
    section.append(empty);
    return section;
  }

  const list = document.createElement("ul");
  list.className = "search-list";
  for (const search of state.searches) {
    const item = document.createElement("li");
    item.className = "search-item";
    const text = document.createElement("span");
    text.className = "search-query";
    text.textContent = `${search.query} (최근 ${search.freshnessDays}일)`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "search-remove";
    remove.dataset.searchId = search.id;
    remove.textContent = "지우기";
    remove.disabled = isSettingsBusy(state);
    remove.addEventListener("click", () => handlers.onDeleteSearch(search.id));
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "search-refresh";
    refresh.dataset.searchId = search.id;
    refresh.textContent = "지금 갱신";
    refresh.disabled = isSettingsBusy(state);
    refresh.addEventListener("click", () => handlers.onRefreshSearch(search.id));
    item.append(text, refresh, remove);
    list.append(item);

    if (state.lastSearchRefresh?.searchId === search.id) {
      const result = document.createElement("p");
      result.className = "search-refresh-result";
      result.textContent = state.lastSearchRefresh.result.detail;
      item.append(result);
    }
  }
  section.append(list);
  return section;
}

function renderNeighborPanel(
  document: Document,
  state: SettingsState,
  handlers: SettingsHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "neighbor-panel";
  const heading = document.createElement("h2");
  heading.textContent = "이웃 목록";
  section.append(heading);

  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent =
    "공개 RSS를 확인할 이웃을 직접 추가할 수 있습니다. 수집을 멈춰도 이전에 모은 글은 남습니다.";
  section.append(note);

  const name = textInput(document, "neighbor-name", "이웃 이름", state.neighborForm.name, state);
  name.input.addEventListener("input", () =>
    handlers.onNeighborFieldChange({ name: name.input.value }),
  );
  const blogId = textInput(
    document,
    "neighbor-blog-id",
    "블로그 ID",
    state.neighborForm.blogId,
    state,
  );
  blogId.input.addEventListener("input", () =>
    handlers.onNeighborFieldChange({ blogId: blogId.input.value }),
  );
  const blogUrl = textInput(
    document,
    "neighbor-blog-url",
    "공개 블로그 URL",
    state.neighborForm.blogUrl,
    state,
  );
  blogUrl.input.placeholder = "https://blog.naver.com/example";
  blogUrl.input.addEventListener("input", () =>
    handlers.onNeighborFieldChange({ blogUrl: blogUrl.input.value }),
  );
  section.append(name.label, name.input, blogId.label, blogId.input, blogUrl.label, blogUrl.input);

  const save = document.createElement("button");
  save.type = "button";
  save.id = "save-neighbor-button";
  save.textContent = "이웃 저장";
  save.disabled = isSettingsBusy(state);
  save.addEventListener("click", () => handlers.onSaveNeighbor());
  section.append(save);

  if (state.neighbors.length === 0) {
    const empty = document.createElement("p");
    empty.className = "neighbor-empty";
    empty.textContent = "저장한 이웃이 없습니다. 자동 동기화에서 찾거나 직접 추가하세요.";
    section.append(empty);
    return section;
  }

  const list = document.createElement("ul");
  list.className = "neighbor-list";
  for (const neighbor of state.neighbors) {
    const item = document.createElement("li");
    item.className = "neighbor-item";
    const nameText = document.createElement("strong");
    nameText.textContent = neighbor.name;
    const detail = document.createElement("span");
    detail.className = "neighbor-detail";
    const checked = neighbor.lastCheckedAt === null ? "" : ` · ${neighbor.lastCheckedAt}`;
    detail.textContent = `${neighbor.blogId} · ${FEED_STATUS_LABELS[neighbor.feedStatus]}${checked}`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "neighbor-toggle";
    toggle.dataset.neighborId = neighbor.id;
    toggle.textContent = neighbor.enabled ? "수집 멈추기" : "수집 다시 켜기";
    toggle.disabled = isSettingsBusy(state);
    toggle.addEventListener("click", () => handlers.onToggleNeighbor(neighbor.id));
    item.append(nameText, detail, toggle);
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderDigestPanel(
  document: Document,
  state: SettingsState,
  handlers: SettingsHandlers,
): Element {
  const section = document.createElement("section");
  section.className = "digest-panel";
  const heading = document.createElement("h2");
  heading.textContent = "이메일 요약";
  section.append(heading);

  const timezone = document.createElement("p");
  timezone.className = "settings-note";
  timezone.textContent = `요약 시각은 ${state.digestForm.timezone} 기준입니다.`;
  section.append(timezone);

  const hourLabel = document.createElement("label");
  hourLabel.setAttribute("for", "digest-hour");
  hourLabel.textContent = "시각 (시)";
  const hour = numberInput(document, "digest-hour", state.digestForm.hour, 0, 23, state);
  hour.addEventListener("change", () => handlers.onDigestFieldChange({ hour: Number(hour.value) }));
  const minuteLabel = document.createElement("label");
  minuteLabel.setAttribute("for", "digest-minute");
  minuteLabel.textContent = "시각 (분)";
  const minute = numberInput(document, "digest-minute", state.digestForm.minute, 0, 59, state);
  minute.addEventListener("change", () =>
    handlers.onDigestFieldChange({ minute: Number(minute.value) }),
  );
  section.append(hourLabel, hour, minuteLabel, minute);

  const emailLabel = document.createElement("label");
  emailLabel.className = "checkbox-label";
  const email = document.createElement("input");
  email.id = "digest-email-enabled";
  email.type = "checkbox";
  email.checked = state.digestForm.emailEnabled;
  email.disabled = isSettingsBusy(state);
  email.addEventListener("change", () =>
    handlers.onDigestFieldChange({ emailEnabled: email.checked }),
  );
  emailLabel.append(email, document.createTextNode("이메일로 새 글 요약 받기"));
  section.append(emailLabel);

  if (state.digest?.smtpConfigured === false) {
    const missing = document.createElement("p");
    missing.className = "digest-smtp-missing";
    missing.textContent =
      "SMTP가 아직 설정되지 않았습니다. 선택은 저장되지만 SMTP 설정 전에는 이메일을 보내지 않습니다.";
    section.append(missing);
  }

  const save = document.createElement("button");
  save.type = "button";
  save.id = "save-digest-button";
  save.textContent = "요약 설정 저장";
  save.disabled = isSettingsBusy(state);
  save.addEventListener("click", () => handlers.onSaveDigest());
  section.append(save);
  return section;
}

function textInput(
  document: Document,
  id: string,
  label: string,
  value: string,
  state: SettingsState,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const fieldLabel = document.createElement("label");
  fieldLabel.setAttribute("for", id);
  fieldLabel.textContent = label;
  const input = document.createElement("input");
  input.id = id;
  input.type = "text";
  input.value = value;
  input.disabled = isSettingsBusy(state);
  return { label: fieldLabel, input };
}

function heading(document: Document, text: string): HTMLHeadingElement {
  const element = document.createElement("h2");
  element.textContent = text;
  return element;
}

function button(
  document: Document,
  id: string,
  text: string,
  handler: () => void,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.id = id;
  element.textContent = text;
  element.addEventListener("click", handler);
  return element;
}

function textField(
  document: Document,
  id: string,
  label: string,
  value: string,
  onChange: (value: string) => void,
): Element {
  const field = document.createElement("div");
  const name = document.createElement("label");
  name.htmlFor = id;
  name.textContent = label;
  const input = document.createElement("input");
  input.id = id;
  input.value = value;
  input.addEventListener("input", () => onChange(input.value));
  field.append(name, input);
  return field;
}

function numberField(
  document: Document,
  id: string,
  label: string,
  value: number,
  onChange: (value: number) => void,
  min = 1,
  max?: number,
): Element {
  const field = document.createElement("div");
  const name = document.createElement("label");
  name.htmlFor = id;
  name.textContent = label;
  const input = document.createElement("input");
  input.id = id;
  input.type = "number";
  input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.value = String(value);
  input.addEventListener("change", () => onChange(Number(input.value)));
  field.append(name, input);
  return field;
}

function selectField(
  document: Document,
  id: string,
  label: string,
  value: string,
  values: readonly (readonly [string, string])[],
  onChange: (value: string) => void,
): Element {
  const field = document.createElement("div");
  const name = document.createElement("label");
  name.htmlFor = id;
  name.textContent = label;
  const select = document.createElement("select");
  select.id = id;
  for (const [optionValue, text] of values) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = text;
    option.selected = optionValue === value;
    select.append(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  field.append(name, select);
  return field;
}
