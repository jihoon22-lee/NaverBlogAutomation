/**
 * Local web app entry point.
 *
 * The app is served from the same desktop-owned origin as the API, so it needs no configured host
 * and no CORS relaxation. Exactly one workspace view is active at a time.
 */

import { ApiError, LocalApiClient } from "./api/client";
import type { ArticleExtraction } from "./api/types";
import { ActivityController } from "./controllers/activity";
import { CommentController } from "./controllers/comment";
import { SessionController } from "./controllers/session";
import { SettingsController } from "./controllers/settings";
import { TodayController } from "./controllers/today";
import { WritingController } from "./controllers/writing";
import { createNavigation, focusWorkspace, type NavSection } from "./navigation";

export const APP_ROOT_ID = "workspace";
const REMOTE_PAIRING_BUTTON_ID = "remote-pairing-code-button";

export interface Workspace {
  activity: ActivityController;
  comment: CommentController;
  openComment(
    extraction: ArticleExtraction,
    discoveryPostId: string | null,
    source?: "neighbor" | "search" | null,
    options?: { generate?: boolean },
  ): void;
  openCommentUrl(
    url: string,
    discoveryPostId: string | null,
    source: "neighbor" | "search" | null,
  ): void;
  session: SessionController;
  settings: SettingsController;
  showSession(sessionId?: string): void;
  showActivity(): void;
  showSettings(): void;
  showToday(selectedPostId?: string): void;
  showWriting(draftId?: string): void;
  showStoredComment(
    recommendationId: string,
    discoveryPostId: string | null,
    source: "neighbor" | "search" | null,
  ): void;
  showRemotePairing(): void;
  showRemotePairingCode(): void;
  today: TodayController;
  writing: WritingController;
}

/** Compose the Today, Comment, and Writing controllers over one root element. */
export function createWorkspace(root: Element): Workspace {
  const workspace: Partial<Workspace> = {};
  const api = new LocalApiClient();
  const document = root.ownerDocument;
  const pairingButton = document.getElementById(REMOTE_PAIRING_BUTTON_ID);
  let activeSection: NavSection = "today";
  const navigation = createNavigation(root.ownerDocument, {
    onSelect: (section: NavSection) => {
      if (section === "writing") workspace.showWriting?.();
      else if (section === "session") workspace.showSession?.();
      else if (section === "activity") workspace.showActivity?.();
      else if (section === "settings") workspace.showSettings?.();
      else workspace.showToday?.();
    },
  });
  const comment = new CommentController(root, {
    api,
    copy: async (text: string) => {
      if (!(await copyText(document, text))) throw new Error("clipboard_unavailable");
    },
    onBack: () => workspace.showToday?.(),
    onRecommendationReady: (recommendationId, discoveryPostId, source) => {
      const parameters = new URLSearchParams();
      if (discoveryPostId !== null) parameters.set("post", discoveryPostId);
      if (source !== null) parameters.set("source", source);
      const query = parameters.size === 0 ? "" : `?${parameters.toString()}`;
      setRoute(document, `#comment/${recommendationId}${query}`);
    },
  });
  const today = new TodayController(root, {
    api,
    onDiscoveryPostOpened: (post) =>
      workspace.openCommentUrl?.(post.sourceUrl, post.id, post.source),
    onDirectUrlOpened: (url) => workspace.openCommentUrl?.(url, null, null),
    onExtracted: (extraction, post) =>
      workspace.openComment?.(extraction, post?.id ?? null, post?.source ?? null, {
        generate: true,
      }),
    onRemotePairingRequired: () => workspace.showRemotePairing?.(),
    onSettingsRequested: () => workspace.showSettings?.(),
  });
  const writing = new WritingController(root, {
    api,
    onDraftOpened: (draftId) => setRoute(document, `#writing/${draftId}`),
  });
  const activity = new ActivityController(root, api, {
    onOpenDraft: (draftId) => workspace.showWriting?.(draftId),
    onOpenRecommendation: (recommendationId) =>
      workspace.showStoredComment?.(recommendationId, null, null),
    onOpenSession: (sessionId) => workspace.showSession?.(sessionId),
  });
  const session = new SessionController(root, { api });
  session.observe(() => {
    if (activeSection === "session") session.render();
  });
  const appSettings = new SettingsController(root);
  appSettings.observe(() => {
    if (activeSection === "settings") appSettings.render();
  });
  workspace.settings = appSettings;
  workspace.session = session;
  workspace.comment = comment;
  workspace.today = today;
  workspace.writing = writing;
  workspace.activity = activity;
  workspace.showSettings = () => {
    setNavigationVisible(document, true);
    activeSection = "settings";
    setRoute(document, "#settings");
    session.close();
    navigation?.mark("settings");
    appSettings.render();
    focusWorkspace(root);
    void appSettings.load();
  };
  workspace.showSession = (sessionId) => {
    setNavigationVisible(document, true);
    activeSection = "session";
    setRoute(document, sessionId === undefined ? "#session" : `#session/${sessionId}`);
    navigation?.mark("session");
    session.render();
    focusWorkspace(root);
    void session.load(sessionId === undefined ? {} : { sessionId });
  };
  workspace.showWriting = (draftId) => {
    setNavigationVisible(document, true);
    activeSection = "writing";
    setRoute(document, draftId === undefined ? "#writing" : `#writing/${draftId}`);
    navigation?.mark("writing");
    writing.render();
    focusWorkspace(root);
    void writing.load(draftId === undefined ? {} : { draftId });
  };
  workspace.openComment = (
    extraction: ArticleExtraction,
    discoveryPostId: string | null,
    source: "neighbor" | "search" | null = null,
    options: { generate?: boolean } = {},
  ) => {
    setNavigationVisible(document, true);
    activeSection = "today";
    setRoute(document, discoveryPostId === null ? "#comment/direct" : `#post/${discoveryPostId}`);
    session.close();
    navigation?.mark("today");
    comment.open(extraction, discoveryPostId, source, options);
    focusWorkspace(root);
    void comment.loadClosingPhrase();
  };
  workspace.openCommentUrl = (url, discoveryPostId, source) => {
    setNavigationVisible(document, true);
    activeSection = "today";
    setRoute(document, discoveryPostId === null ? "#comment/direct" : `#post/${discoveryPostId}`);
    session.close();
    navigation?.mark("today");
    comment.openUrl(url, discoveryPostId, source);
    focusWorkspace(root);
    void comment.loadClosingPhrase();
  };
  workspace.showStoredComment = (recommendationId, discoveryPostId, source) => {
    setNavigationVisible(document, true);
    activeSection = "today";
    const parameters = new URLSearchParams();
    if (discoveryPostId !== null) parameters.set("post", discoveryPostId);
    if (source !== null) parameters.set("source", source);
    const query = parameters.size === 0 ? "" : `?${parameters.toString()}`;
    setRoute(document, `#comment/${recommendationId}${query}`);
    session.close();
    navigation?.mark("today");
    comment.render();
    focusWorkspace(root);
    void comment.loadClosingPhrase();
    void comment.restore(recommendationId, discoveryPostId, source);
  };
  workspace.showToday = (selectedPostId) => {
    setNavigationVisible(document, true);
    activeSection = "today";
    setRoute(document, selectedPostId === undefined ? "#today" : `#post/${selectedPostId}`);
    navigation?.mark("today");
    today.render();
    focusWorkspace(root);
    void today.load(selectedPostId === undefined ? {} : { selectedPostId });
  };
  workspace.showActivity = () => {
    setNavigationVisible(document, true);
    activeSection = "activity";
    setRoute(document, "#activity");
    session.close();
    navigation?.mark("activity");
    activity.render();
    focusWorkspace(root);
    void activity.load();
  };
  workspace.showRemotePairing = () => {
    session.close();
    setNavigationVisible(document, false);
    renderRemotePairing(root, api, () => workspace.showToday?.());
    focusWorkspace(root);
  };
  workspace.showRemotePairingCode = () => {
    session.close();
    setNavigationVisible(document, true);
    renderPairingCode(root, api);
    focusWorkspace(root);
  };
  pairingButton?.addEventListener("click", () => workspace.showRemotePairingCode?.());
  const refreshAfterResume = () => {
    if (root.querySelector("#remote-pairing-status") !== null) return;
    if (root.querySelector("#comment-status") !== null) {
      void comment.refresh();
      return;
    }
    if (activeSection === "today") void today.load();
    else if (activeSection === "session") void session.load();
    else if (activeSection === "writing") void writing.refreshActive();
    else if (activeSection === "activity") void activity.load();
    else void appSettings.load();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshAfterResume();
  });
  document.defaultView?.addEventListener("pageshow", () => refreshAfterResume());
  document.defaultView?.addEventListener("hashchange", () => {
    const hash = document.defaultView?.location.hash ?? "";
    const route = routeFromHash(hash);
    if (route === "writing" && activeSection !== "writing") {
      workspace.showWriting?.(draftRouteFromHash(hash));
    } else if (route === "session" && activeSection !== "session") {
      workspace.showSession?.(sessionRouteFromHash(hash));
    } else if (route === "activity" && activeSection !== "activity") workspace.showActivity?.();
    else if (route === "settings" && activeSection !== "settings") workspace.showSettings?.();
    else if (route === "today" && activeSection !== "today") workspace.showToday?.();
    else if (route === "post" && root.querySelector("#comment-status") === null) {
      const postId = postRouteFromHash(hash);
      if (postId !== null) workspace.showToday?.(postId);
    } else if (route === "comment") {
      const context = commentRouteFromHash(hash);
      if (
        context !== null &&
        comment.state.recommendation?.id !== context.recommendationId &&
        root.querySelector("#comment-status") === null
      ) {
        workspace.showStoredComment?.(
          context.recommendationId,
          context.discoveryPostId,
          context.source,
        );
      }
    }
  });
  return workspace as Workspace;
}

/** Create the workspace for `root` and start the first load. */
export function mount(documentRef: Document = document): Workspace | null {
  const root = documentRef.getElementById(APP_ROOT_ID);
  if (root === null) return null;
  const workspace = createWorkspace(root);
  const route = routeFromHash(documentRef.defaultView?.location.hash ?? "");
  if (route === "writing")
    workspace.showWriting(draftRouteFromHash(documentRef.defaultView?.location.hash ?? ""));
  else if (route === "session")
    workspace.showSession(sessionRouteFromHash(documentRef.defaultView?.location.hash ?? ""));
  else if (route === "activity") workspace.showActivity();
  else if (route === "settings") workspace.showSettings();
  else if (route === "post") {
    const postId = postRouteFromHash(documentRef.defaultView?.location.hash ?? "");
    workspace.showToday(postId ?? undefined);
  } else if (route === "comment") {
    const context = commentRouteFromHash(documentRef.defaultView?.location.hash ?? "");
    if (context === null) workspace.showToday();
    else
      workspace.showStoredComment(
        context.recommendationId,
        context.discoveryPostId,
        context.source,
      );
  } else workspace.showToday();
  return workspace;
}

if (typeof document !== "undefined" && document.getElementById(APP_ROOT_ID) !== null) {
  mount();
}

function setNavigationVisible(document: Document, visible: boolean): void {
  const navigation = document.getElementById("workspace-nav");
  if (navigation !== null) navigation.hidden = !visible;
}

/** Map public hash routes back to their owning workspace section. */
export function routeFromHash(hash: string): NavSection | "post" | "comment" | null {
  const path = hash.replace(/^#/u, "").split("?")[0] ?? "";
  if (path === "today") return "today";
  if (path === "session" || path.startsWith("session/")) return "session";
  if (path === "writing" || path.startsWith("writing/")) return "writing";
  if (path === "activity") return "activity";
  if (path === "settings" || path.startsWith("settings/")) return "settings";
  if (path.startsWith("post/")) return "post";
  if (path.startsWith("comment/")) return "comment";
  return null;
}

function postRouteFromHash(hash: string): string | null {
  const path = hash.replace(/^#/u, "").split("?")[0] ?? "";
  const postId = path.startsWith("post/") ? path.slice("post/".length) : "";
  return postId.length === 0 ? null : postId;
}

function draftRouteFromHash(hash: string): string | undefined {
  const path = hash.replace(/^#/u, "").split("?")[0] ?? "";
  const draftId = path.startsWith("writing/") ? path.slice("writing/".length) : "";
  return draftId.length === 0 ? undefined : draftId;
}

function sessionRouteFromHash(hash: string): string | undefined {
  const path = hash.replace(/^#/u, "").split("?")[0] ?? "";
  const sessionId = path.startsWith("session/") ? path.slice("session/".length) : "";
  return sessionId.length === 0 ? undefined : sessionId;
}

function commentRouteFromHash(hash: string): {
  recommendationId: string;
  discoveryPostId: string | null;
  source: "neighbor" | "search" | null;
} | null {
  const [path, query = ""] = hash.replace(/^#/u, "").split("?", 2);
  const recommendationId = path?.startsWith("comment/") ? path.slice("comment/".length) : "";
  if (recommendationId.length === 0 || recommendationId === "direct") return null;
  const parameters = new URLSearchParams(query);
  const source = parameters.get("source");
  return {
    recommendationId,
    discoveryPostId: parameters.get("post"),
    source: source === "neighbor" || source === "search" ? source : null,
  };
}

function setRoute(document: Document, hash: string): void {
  const view = document.defaultView;
  if (view !== null && view.location.hash !== hash) view.location.hash = hash;
}

function renderRemotePairing(root: Element, api: LocalApiClient, onPaired: () => void): void {
  const document = root.ownerDocument;
  root.textContent = "";
  const panel = document.createElement("section");
  panel.className = "remote-pairing-panel";
  const heading = document.createElement("h2");
  heading.id = "workspace-status";
  heading.textContent = "이 태블릿 연결";
  const guide = document.createElement("p");
  guide.textContent = "PC 웹앱의 태블릿 연결에서 만든 일회용 코드를 입력하세요.";
  const nameLabel = document.createElement("label");
  nameLabel.htmlFor = "remote-device-name";
  nameLabel.textContent = "기기 이름";
  const name = document.createElement("input");
  name.id = "remote-device-name";
  name.value = "내 태블릿";
  name.maxLength = 80;
  const codeLabel = document.createElement("label");
  codeLabel.htmlFor = "remote-pairing-code";
  codeLabel.textContent = "일회용 코드";
  const code = document.createElement("input");
  code.id = "remote-pairing-code";
  code.autocomplete = "one-time-code";
  const submit = document.createElement("button");
  submit.type = "button";
  submit.id = "remote-pair-button";
  submit.textContent = "이 기기 연결";
  const status = document.createElement("p");
  status.id = "remote-pairing-status";
  status.setAttribute("role", "status");
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    status.textContent = "연결하는 중입니다.";
    try {
      await api.pairRemoteDevice(code.value, name.value);
      status.textContent = "연결되었습니다. 작업 화면을 여는 중입니다.";
      onPaired();
    } catch (error) {
      status.textContent = remoteErrorMessage(error);
      submit.disabled = false;
    }
  });
  panel.append(heading, guide, nameLabel, name, codeLabel, code, submit, status);
  root.append(panel);
}

function renderPairingCode(root: Element, api: LocalApiClient): void {
  const document = root.ownerDocument;
  root.textContent = "";
  const panel = document.createElement("section");
  panel.className = "remote-pairing-panel";
  const heading = document.createElement("h2");
  heading.id = "workspace-status";
  heading.textContent = "태블릿 연결 코드";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "일회용 코드를 만드는 중입니다.";
  const instructions = document.createElement("p");
  const devices = document.createElement("div");
  devices.id = "remote-device-list";
  panel.append(heading, status, instructions, devices);
  root.append(panel);
  void api
    .appReadiness()
    .then(async (readiness) => {
      const pairedDevices = await api.remoteDevices();
      if (readiness.accessMode === "local") {
        status.textContent = "태블릿 연결은 아직 켜지지 않았습니다.";
        instructions.textContent =
          "private env file에 WEBAPP_ACCESS_MODE=lan 및 API_HOST=0.0.0.0을 설정한 뒤 PC 서비스를 다시 시작하세요.";
        renderPairedDevices(devices, api, pairedDevices);
        return;
      }
      const pairing = await api.createRemotePairingCode();
      const lanAddress = readiness.lanAddresses[0];
      if (lanAddress === undefined) throw new Error("lan_address_unavailable");
      status.textContent = "5분 안에 태블릿에 아래 일회용 코드를 입력하세요.";
      instructions.textContent = `태블릿에서 http://${lanAddress}:8765/app/ 를 여세요.`;
      renderPairingCodeValue(panel, document, pairing.code);
      renderPairedDevices(devices, api, pairedDevices);
    })
    .catch((error: unknown) => {
      status.textContent = remoteErrorMessage(error);
    });
}

function renderPairingCodeValue(panel: Element, document: Document, code: string): void {
  const label = document.createElement("label");
  label.htmlFor = "remote-pairing-code-value";
  label.textContent = "일회용 코드";
  const value = document.createElement("input");
  value.id = "remote-pairing-code-value";
  value.readOnly = true;
  value.value = code;
  value.setAttribute("aria-label", "태블릿 연결 일회용 코드");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "코드 복사";
  const copyStatus = document.createElement("p");
  copyStatus.setAttribute("role", "status");
  copy.addEventListener("click", async () => {
    if (await copyText(document, code)) {
      copyStatus.textContent = "코드를 복사했습니다.";
      return;
    }
    value.focus();
    value.select();
    copyStatus.textContent = "코드가 선택되었습니다. 길게 눌러 직접 복사하세요.";
  });
  panel.append(label, value, copy, copyStatus);
}

function renderPairedDevices(
  root: Element,
  api: LocalApiClient,
  devices: Awaited<ReturnType<LocalApiClient["remoteDevices"]>>,
): void {
  const document = root.ownerDocument;
  root.textContent = "";
  const heading = document.createElement("h3");
  heading.textContent = "연결된 기기";
  root.append(heading);
  if (devices.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "아직 연결된 기기가 없습니다.";
    root.append(empty);
    return;
  }
  const list = document.createElement("ul");
  for (const device of devices) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = `${device.deviceName} · 마지막 사용 ${device.lastSeenAt}`;
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.textContent = "연결 해제";
    revoke.addEventListener("click", async () => {
      revoke.disabled = true;
      try {
        await api.revokeRemoteDevice(device.id);
        renderPairedDevices(
          root,
          api,
          devices.filter((item) => item.id !== device.id),
        );
      } catch (error) {
        revoke.disabled = false;
        text.textContent = remoteErrorMessage(error);
      }
    });
    item.append(text, revoke);
    list.append(item);
  }
  root.append(list);
}

function remoteErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.problem?.detail ?? error.message;
  return "태블릿 연결을 완료하지 못했습니다. PC 웹앱에서 새 코드를 만든 뒤 다시 시도하세요.";
}

async function copyText(document: Document, text: string): Promise<boolean> {
  const clipboard = document.defaultView?.navigator.clipboard;
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // HTTP LAN mode can deny the modern Clipboard API; use a selectable fallback below.
    }
  }
  if (document.body === null) return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-label", "복사할 텍스트");
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}
