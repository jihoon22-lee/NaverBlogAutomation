/**
 * Local web app entry point.
 *
 * The app is served from the same loopback origin as the API, so it needs no configured host and no
 * CORS relaxation. Exactly one workspace view is active at a time.
 */

import type { ArticleExtraction } from "./api/types";
import { CommentController } from "./controllers/comment";
import { TodayController } from "./controllers/today";

export const APP_ROOT_ID = "workspace";

export interface Workspace {
  comment: CommentController;
  openComment(extraction: ArticleExtraction, discoveryPostId: string): void;
  showToday(): void;
  today: TodayController;
}

/** Compose the Today and Comment controllers over one root element. */
export function createWorkspace(root: Element): Workspace {
  const workspace: Partial<Workspace> = {};
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
  workspace.comment = comment;
  workspace.today = today;
  workspace.openComment = (extraction: ArticleExtraction, discoveryPostId: string) => {
    comment.open(extraction, discoveryPostId);
    void comment.loadClosingPhrase();
  };
  workspace.showToday = () => {
    today.render();
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
