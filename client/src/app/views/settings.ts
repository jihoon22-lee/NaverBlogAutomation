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
}

const SYNC_STATUS_LABELS: Record<string, string> = {
  never: "아직 동기화하지 않았습니다.",
  success: "마지막 동기화가 성공했습니다.",
  partial: "마지막 동기화가 일부만 성공했습니다.",
  failed: "마지막 동기화가 실패했습니다.",
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
  add.disabled = isSettingsBusy(state) || state.newQuery.trim().length === 0;
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
    item.append(text, remove);
    list.append(item);
  }
  section.append(list);
  return section;
}
