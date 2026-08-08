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
  showHome(): void;
  showMore(): void;
  showWorkbench(selectedPostId?: string): void;
  showSession(sessionId?: string): void;
  showActivity(): void;
  showSettings(): void;
  /** @deprecated Historical route alias. Opens the workbench. */
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
  // A document can contain only one mounted app in production.  Tests and hot reload can replace
  // that root, so stale listeners must not repaint a detached prior workspace on a later hashchange.
  const isCurrentRoot = () => document.getElementById(APP_ROOT_ID) === root;
  const pairingButton = document.getElementById(REMOTE_PAIRING_BUTTON_ID);
  let activeView: "home" | "workbench" | "writing" | "more" | "activity" | "settings" | "session" =
    "home";
  const navigation = createNavigation(root.ownerDocument, {
    onSelect: (section: NavSection) => {
      if (section === "writing") workspace.showWriting?.();
      else if (section === "workbench") workspace.showWorkbench?.();
      else if (section === "more") workspace.showMore?.();
      else workspace.showHome?.();
    },
  });
  const comment = new CommentController(root, {
    api,
    copy: async (text: string) => {
      if (!(await copyText(document, text))) throw new Error("clipboard_unavailable");
    },
    onBack: () => workspace.showWorkbench?.(),
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
    onWorkbenchRequested: () => workspace.showWorkbench?.(),
    onBatchRequested: ({ postIds, approvedSteps }) => {
      session.setSelectedPosts(postIds);
      session.setApprovedSteps(approvedSteps);
      workspace.showSession?.();
    },
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
  const session = new SessionController(root, {
    api,
    onBack: () => workspace.showWorkbench?.(),
  });
  session.observe(() => {
    if (activeView === "session") session.render();
  });
  const appSettings = new SettingsController(root);
  appSettings.observe(() => {
    if (activeView === "settings") appSettings.render();
  });
  workspace.settings = appSettings;
  workspace.session = session;
  workspace.comment = comment;
  workspace.today = today;
  workspace.writing = writing;
  workspace.activity = activity;
  workspace.showHome = () => {
    setNavigationVisible(document, true);
    activeView = "home";
    setRoute(document, "#home");
    session.close();
    navigation?.mark("home");
    today.setView("home");
    today.render();
    focusWorkspace(root);
    void today.load();
  };
  workspace.showWorkbench = (selectedPostId) => {
    setNavigationVisible(document, true);
    activeView = "workbench";
    setRoute(document, selectedPostId === undefined ? "#workbench" : `#post/${selectedPostId}`);
    session.close();
    navigation?.mark("workbench");
    today.setView("workbench");
    today.render();
    focusWorkspace(root);
    if (today.state.phase === "idle" || selectedPostId !== undefined) {
      void today.load(selectedPostId === undefined ? {} : { selectedPostId });
    }
  };
  workspace.showMore = () => {
    setNavigationVisible(document, true);
    activeView = "more";
    setRoute(document, "#more");
    session.close();
    navigation?.mark("more");
    renderMore(root, {
      onActivity: () => workspace.showActivity?.(),
      onPairing: () => workspace.showRemotePairingCode?.(),
      onSettings: () => workspace.showSettings?.(),
      showPairing: isLoopbackDesktop(document),
    });
    focusWorkspace(root);
  };
  workspace.showSettings = () => {
    setNavigationVisible(document, true);
    activeView = "settings";
    setRoute(document, "#settings");
    session.close();
    navigation?.mark("more");
    appSettings.render();
    focusWorkspace(root);
    void appSettings.load();
  };
  workspace.showSession = (sessionId) => {
    setNavigationVisible(document, true);
    activeView = "session";
    setRoute(document, sessionId === undefined ? "#session" : `#session/${sessionId}`);
    navigation?.mark("workbench");
    session.render();
    focusWorkspace(root);
    void session.load(sessionId === undefined ? {} : { sessionId });
  };
  workspace.showWriting = (draftId) => {
    setNavigationVisible(document, true);
    activeView = "writing";
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
    activeView = "workbench";
    setRoute(document, discoveryPostId === null ? "#comment/direct" : `#post/${discoveryPostId}`);
    session.close();
    navigation?.mark("workbench");
    comment.open(extraction, discoveryPostId, source, options);
    focusWorkspace(root);
    void comment.loadClosingPhrase();
  };
  workspace.openCommentUrl = (url, discoveryPostId, source) => {
    setNavigationVisible(document, true);
    activeView = "workbench";
    setRoute(document, discoveryPostId === null ? "#comment/direct" : `#post/${discoveryPostId}`);
    session.close();
    navigation?.mark("workbench");
    comment.openUrl(url, discoveryPostId, source);
    focusWorkspace(root);
    void comment.loadClosingPhrase();
  };
  workspace.showStoredComment = (recommendationId, discoveryPostId, source) => {
    setNavigationVisible(document, true);
    activeView = "workbench";
    const parameters = new URLSearchParams();
    if (discoveryPostId !== null) parameters.set("post", discoveryPostId);
    if (source !== null) parameters.set("source", source);
    const query = parameters.size === 0 ? "" : `?${parameters.toString()}`;
    setRoute(document, `#comment/${recommendationId}${query}`);
    session.close();
    navigation?.mark("workbench");
    comment.render();
    focusWorkspace(root);
    void comment.loadClosingPhrase();
    void comment.restore(recommendationId, discoveryPostId, source);
  };
  workspace.showToday = (selectedPostId) => workspace.showWorkbench?.(selectedPostId);
  workspace.showActivity = () => {
    setNavigationVisible(document, true);
    activeView = "activity";
    setRoute(document, "#activity");
    session.close();
    navigation?.mark("more");
    activity.render();
    focusWorkspace(root);
    void activity.load();
  };
  workspace.showRemotePairing = () => {
    session.close();
    activeView = "more";
    setRoute(document, "#pairing");
    setNavigationVisible(document, false);
    renderRemotePairing(root, api, () => workspace.showToday?.());
    focusWorkspace(root);
  };
  workspace.showRemotePairingCode = () => {
    session.close();
    activeView = "more";
    setRoute(document, "#pairing-code");
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
    if (activeView === "home" || activeView === "workbench") void today.load();
    else if (activeView === "session") void session.load();
    else if (activeView === "writing") void writing.refreshActive();
    else if (activeView === "activity") void activity.load();
    else if (activeView === "settings") void appSettings.load();
  };
  document.addEventListener("visibilitychange", () => {
    if (isCurrentRoot() && document.visibilityState === "visible") refreshAfterResume();
  });
  document.defaultView?.addEventListener("pageshow", () => {
    if (isCurrentRoot()) refreshAfterResume();
  });
  document.defaultView?.addEventListener("hashchange", () => {
    if (!isCurrentRoot()) return;
    const hash = document.defaultView?.location.hash ?? "";
    const route = routeFromHash(hash);
    if (route === "writing" && activeView !== "writing") {
      workspace.showWriting?.(draftRouteFromHash(hash));
    } else if (route === "session" && activeView !== "session") {
      workspace.showSession?.(sessionRouteFromHash(hash));
    } else if (route === "activity" && activeView !== "activity") workspace.showActivity?.();
    else if (route === "settings" && activeView !== "settings") workspace.showSettings?.();
    else if (route === "more" && activeView !== "more") workspace.showMore?.();
    else if (route === "home" && activeView !== "home") workspace.showHome?.();
    else if (route === "workbench" && activeView !== "workbench") workspace.showWorkbench?.();
    else if (route === "post" && root.querySelector("#comment-status") === null) {
      const postId = postRouteFromHash(hash);
      if (postId !== null) workspace.showWorkbench?.(postId);
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
  else if (route === "more") workspace.showMore();
  else if (route === "workbench") workspace.showWorkbench();
  else if (route === "home") workspace.showHome();
  else if (route === "post") {
    const postId = postRouteFromHash(documentRef.defaultView?.location.hash ?? "");
    workspace.showWorkbench(postId ?? undefined);
  } else if (route === "comment") {
    const context = commentRouteFromHash(documentRef.defaultView?.location.hash ?? "");
    if (context === null) workspace.showWorkbench();
    else
      workspace.showStoredComment(
        context.recommendationId,
        context.discoveryPostId,
        context.source,
      );
  } else workspace.showHome();
  return workspace;
}

if (typeof document !== "undefined" && document.getElementById(APP_ROOT_ID) !== null) {
  mount();
  registerPwaShell();
}

/** Register only the static shell cache; API calls deliberately bypass the service worker. */
export function registerPwaShell(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("./service-worker.js", { scope: "./" }).catch(() => {
    // The app remains fully usable online when installation is unavailable (for example private mode).
  });
}

function setNavigationVisible(document: Document, visible: boolean): void {
  const navigation = document.getElementById("workspace-nav");
  if (navigation !== null) navigation.hidden = !visible;
}

/** Map public hash routes back to their owning workspace section. */
export function routeFromHash(
  hash: string,
): NavSection | "session" | "activity" | "settings" | "post" | "comment" | null {
  const path = hash.replace(/^#/u, "").split("?")[0] ?? "";
  if (path === "home" || path === "today") return "home";
  if (path === "workbench") return "workbench";
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

function renderMore(
  root: Element,
  handlers: { onActivity(): void; onPairing(): void; onSettings(): void; showPairing: boolean },
): void {
  const document = root.ownerDocument;
  root.textContent = "";
  const status = document.createElement("p");
  status.id = "workspace-status";
  status.setAttribute("role", "status");
  status.textContent = "이력과 설정을 엽니다.";
  root.append(status);

  const section = document.createElement("section");
  section.className = "more-menu-panel";
  const heading = document.createElement("h2");
  heading.textContent = "더보기";
  const note = document.createElement("p");
  note.textContent = "작업 흐름을 방해하지 않는 보조 기능을 여기에서 관리합니다.";
  section.append(heading, note);
  const cards: [string, string, string, () => void][] = [
    [
      "more-activity",
      "이력",
      "댓글, 일괄 작업, 초안의 최근 결과를 확인합니다.",
      handlers.onActivity,
    ],
    [
      "more-settings",
      "설정",
      "작업 기본값과 탐색·자동화, PC 연결을 관리합니다.",
      handlers.onSettings,
    ],
  ];
  if (handlers.showPairing) {
    cards.push([
      "more-pairing",
      "태블릿 연결",
      "이 PC에서만 일회용 연결 코드를 만듭니다.",
      handlers.onPairing,
    ]);
  }
  for (const [id, label, description, handler] of cards) {
    const card = document.createElement("article");
    card.className = "more-menu-card";
    const labelHeading = document.createElement("h3");
    labelHeading.textContent = label;
    const detail = document.createElement("p");
    detail.textContent = description;
    const open = document.createElement("button");
    open.type = "button";
    open.id = id;
    open.textContent = `${label} 열기`;
    open.addEventListener("click", handler);
    card.append(labelHeading, detail, open);
    section.append(card);
  }
  root.append(section);
}

/** Paired LAN clients must not even be offered desktop-owned device administration. */
function isLoopbackDesktop(document: Document): boolean {
  const host = document.defaultView?.location.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
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
