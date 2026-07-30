/**
 * Local web app entry point.
 *
 * Task 3 ships the shell only so the build has both entry points. The workspace views arrive with
 * the SPA task.
 */

export const APP_ROOT_ID = "workspace";

/** Render the initial shell into `root` and return the status element. */
export function renderShell(root: Element): HTMLElement {
  root.textContent = "";
  const status = root.ownerDocument.createElement("p");
  status.id = "workspace-status";
  status.setAttribute("role", "status");
  status.textContent = "로컬 서비스에 연결하는 중입니다.";
  root.append(status);
  return status;
}

/** Mount the shell when the document already contains the workspace root. */
export function mount(documentRef: Document = document): HTMLElement | null {
  const root = documentRef.getElementById(APP_ROOT_ID);
  return root === null ? null : renderShell(root);
}

if (typeof document !== "undefined" && document.getElementById(APP_ROOT_ID) !== null) {
  mount();
}
