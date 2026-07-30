/**
 * Local web app entry point.
 *
 * The app is served from the same loopback origin as the API, so it needs no configured host and no
 * CORS relaxation.
 */

import { TodayController } from "./controllers/today";

export const APP_ROOT_ID = "workspace";

/** Create the Today controller for `root` and start its first load. */
export function mount(documentRef: Document = document): TodayController | null {
  const root = documentRef.getElementById(APP_ROOT_ID);
  if (root === null) return null;
  const controller = new TodayController(root);
  controller.render();
  void controller.load();
  return controller;
}

if (typeof document !== "undefined" && document.getElementById(APP_ROOT_ID) !== null) {
  mount();
}
