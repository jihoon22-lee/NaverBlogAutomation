/**
 * Local web app entry point.
 *
 * The app is served from the same loopback origin as the API, so it needs no configured host and no
 * CORS relaxation. Exactly one workspace view is active at a time.
 */

import type { ArticleExtraction } from "./api/types";
import { CommentController } from "./controllers/comment";
import { SessionController } from "./controllers/session";
import { TodayController } from "./controllers/today";
import { WritingController } from "./controllers/writing";
import { createNavigation, focusWorkspace, type NavSection } from "./navigation";

export const APP_ROOT_ID = "workspace";

export interface Workspace {
  comment: CommentController;
  openComment(extraction: ArticleExtraction, discoveryPostId: string): void;
  session: SessionController;
  showSession(): void;
  showToday(): void;
  showWriting(): void;
  today: TodayController;
  writing: WritingController;
}

/** Compose the Today, Comment, and Writing controllers over one root element. */
export function createWorkspace(root: Element): Workspace {
  const workspace: Partial<Workspace> = {};
  let activeSection: NavSection = "today";
  const navigation = createNavigation(root.ownerDocument, {
    onSelect: (section: NavSection) => {
      if (section === "writing") workspace.showWriting?.();
      else if (section === "session") workspace.showSession?.();
      else workspace.showToday?.();
    },
  });
  const comment = new CommentController(root, {
    copy: async (text: string) => {
      await navigator.clipboard.writeText(text);
    },
    onBack: () => workspace.showToday?.(),
  });
  const today = new TodayController(root, {
    onExtracted: (extraction, discoveryPostId) =>
      workspace.openComment?.(extraction, discoveryPostId),
  });
  const writing = new WritingController(root);
  const session = new SessionController(root);
  session.observe(() => {
    if (activeSection === "session") session.render();
  });
  workspace.session = session;
  workspace.comment = comment;
  workspace.today = today;
  workspace.writing = writing;
  workspace.showSession = () => {
    activeSection = "session";
    navigation?.mark("session");
    session.render();
    focusWorkspace(root);
    void session.load();
  };
  workspace.showWriting = () => {
    activeSection = "writing";
    navigation?.mark("writing");
    writing.render();
    focusWorkspace(root);
    void writing.load();
  };
  workspace.openComment = (extraction: ArticleExtraction, discoveryPostId: string) => {
    activeSection = "today";
    session.close();
    navigation?.mark("today");
    comment.open(extraction, discoveryPostId);
    focusWorkspace(root);
    void comment.loadClosingPhrase();
  };
  workspace.showToday = () => {
    activeSection = "today";
    navigation?.mark("today");
    today.render();
    focusWorkspace(root);
    void today.load();
  };
  return workspace as Workspace;
}

/** Create the workspace for `root` and start the first load. */
export function mount(documentRef: Document = document): Workspace | null {
  const root = documentRef.getElementById(APP_ROOT_ID);
  if (root === null) return null;
  const workspace = createWorkspace(root);
  workspace.today.render();
  void workspace.today.load();
  return workspace;
}

if (typeof document !== "undefined" && document.getElementById(APP_ROOT_ID) !== null) {
  mount();
}
