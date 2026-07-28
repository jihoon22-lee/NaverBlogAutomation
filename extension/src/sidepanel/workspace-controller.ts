export type SidePanelWorkspace = "today" | "comment" | "history" | "settings";

const WORKSPACES: readonly SidePanelWorkspace[] = ["today", "comment", "history", "settings"];

export class SidePanelWorkspaceController {
  readonly #document: Document;
  #active: SidePanelWorkspace = "today";

  constructor(document: Document) {
    this.#document = document;
  }

  start(): void {
    this.#placeSections();
    const navigation = this.#required<HTMLElement>("#workspace-navigation");
    navigation.addEventListener("click", (event) => {
      const target = (event.target as Element).closest<HTMLButtonElement>(
        "[data-workspace-target]",
      );
      const workspace = parseWorkspace(target?.dataset.workspaceTarget);
      if (workspace !== null) this.activate(workspace);
    });
    navigation.addEventListener("keydown", (event) => this.#navigateByKey(event));
    this.#required<HTMLButtonElement>("#today-continue-button").addEventListener("click", () => {
      this.#dispatch("today-continue-requested", {});
    });
    this.#required<HTMLButtonElement>("#back-today-button").addEventListener("click", () =>
      this.activate("today"),
    );
    this.activate("today", false);
  }

  activate(workspace: SidePanelWorkspace, focusHeading = true): void {
    this.#active = workspace;
    for (const candidate of WORKSPACES) {
      const panel = this.#required<HTMLElement>(`#workspace-${candidate}`);
      const button = this.#required<HTMLButtonElement>(`#workspace-${candidate}-button`);
      const active = candidate === workspace;
      panel.hidden = !active;
      button.tabIndex = active ? 0 : -1;
      if (active) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    }
    if (focusHeading) {
      const heading = this.#required<HTMLElement>(`#workspace-${workspace}-title`);
      this.#document.defaultView?.requestAnimationFrame(() => heading.focus());
    }
    this.#dispatch("workspace-changed", { workspace });
  }

  get active(): SidePanelWorkspace {
    return this.#active;
  }

  #placeSections(): void {
    const sections = Array.from(
      this.#document.querySelectorAll<HTMLElement>("[data-workspace-section]"),
    ).sort((left, right) => sectionOrder(left) - sectionOrder(right));
    for (const section of sections) {
      const workspace = parseWorkspace(section.dataset.workspaceSection);
      if (workspace !== null) {
        this.#required<HTMLElement>(`#workspace-${workspace}`).append(section);
      }
    }
  }

  #navigateByKey(event: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const current = WORKSPACES.indexOf(this.#active);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? WORKSPACES.length - 1
          : event.key === "ArrowRight"
            ? (current + 1) % WORKSPACES.length
            : (current - 1 + WORKSPACES.length) % WORKSPACES.length;
    event.preventDefault();
    const workspace = WORKSPACES[next];
    if (workspace === undefined) return;
    this.activate(workspace, false);
    this.#required<HTMLButtonElement>(`#workspace-${workspace}-button`).focus();
  }

  #dispatch(name: string, detail: object): void {
    const EventConstructor = this.#document.defaultView?.CustomEvent;
    if (EventConstructor !== undefined) {
      this.#document.defaultView?.dispatchEvent(new EventConstructor(name, { detail }));
    }
  }

  #required<T extends Element>(selector: string): T {
    const value = this.#document.querySelector<T>(selector);
    if (value === null) throw new Error(`Missing workspace element: ${selector}`);
    return value;
  }
}

function parseWorkspace(value: string | undefined): SidePanelWorkspace | null {
  return WORKSPACES.includes(value as SidePanelWorkspace) ? (value as SidePanelWorkspace) : null;
}

function sectionOrder(element: HTMLElement): number {
  const value = Number(element.dataset.workspaceOrder ?? "100");
  return Number.isFinite(value) ? value : 100;
}
