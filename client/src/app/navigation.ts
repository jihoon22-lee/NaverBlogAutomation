/**
 * Global navigation between workspace sections.
 *
 * The nav lives in the HTML shell rather than inside `#workspace`, because every view clears the
 * workspace root when it renders. Keeping it outside means the tabs survive a re-render and stay in
 * the same place while the user works.
 */

export const NAV_ID = "workspace-nav";

/** The sections a user can reach directly from the nav. */
export type NavSection = "today" | "session" | "writing" | "settings";

const SECTIONS: readonly NavSection[] = ["today", "session", "writing", "settings"];

export interface NavigationHandlers {
  onSelect(section: NavSection): void;
}

export interface Navigation {
  /** Mark one section as the current one without invoking the handler. */
  mark(section: NavSection): void;
}

/** Bind the shell's nav buttons and report clicks as section selections. */
export function createNavigation(
  documentRef: Document,
  handlers: NavigationHandlers,
): Navigation | null {
  const nav = documentRef.getElementById(NAV_ID);
  if (nav === null) return null;
  const buttons = new Map<NavSection, HTMLButtonElement>();
  for (const section of SECTIONS) {
    const button = nav.querySelector<HTMLButtonElement>(`[data-section="${section}"]`);
    if (button === null) continue;
    buttons.set(section, button);
    button.addEventListener("click", () => handlers.onSelect(section));
  }
  return {
    mark(section: NavSection): void {
      for (const [name, button] of buttons) {
        if (name === section) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
    },
  };
}

/**
 * Move focus to the workspace after a section change.
 *
 * Views rebuild the root on every render, so focus would otherwise fall back to the document body
 * and a screen reader user would lose their place. Only call this on an actual section change; doing
 * it on every render would steal focus while the user types.
 */
export function focusWorkspace(root: Element): void {
  const target = root.querySelector<HTMLElement>("#workspace-status") ?? (root as HTMLElement);
  target.setAttribute("tabindex", "-1");
  target.focus();
}
