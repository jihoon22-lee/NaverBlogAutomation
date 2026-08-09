/**
 * Small, DOM-only UI primitives shared by the web app views.
 *
 * The factories deliberately return native elements instead of a component abstraction.  This
 * keeps the existing controller/view architecture intact while giving new screens one place to
 * get consistent class names and accessibility behaviour.
 */

export type UiContent = Node | string | number | readonly UiContent[] | null | undefined;

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type CardVariant = "flat" | "interactive" | "status";
export type StatusKind = "ready" | "needs-action" | "running" | "error" | "neutral";
export type ToastKind = "status" | "alert";

type AttributeValue = string | number | boolean | null | undefined;

export interface ElementOptions {
  document?: Document;
  id?: string;
  className?: string;
  attributes?: Readonly<Record<string, AttributeValue>>;
}

export interface ButtonOptions extends ElementOptions {
  label?: UiContent;
  children?: UiContent;
  content?: UiContent;
  variant?: ButtonVariant;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
}

export interface IconButtonOptions extends ElementOptions {
  label: string;
  icon?: UiContent;
  children?: UiContent;
  content?: UiContent;
  variant?: ButtonVariant;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
}

export interface CardOptions extends ElementOptions {
  variant?: CardVariant;
  children?: UiContent;
  content?: UiContent;
  onClick?: (event: MouseEvent) => void;
}

export interface StatusChipOptions extends ElementOptions {
  status?: StatusKind;
  label?: UiContent;
  children?: UiContent;
  content?: UiContent;
}

export interface FieldOptions extends ElementOptions {
  label: UiContent;
  control: HTMLElement;
  hint?: UiContent;
  error?: UiContent;
}

export interface ToastOptions extends ElementOptions {
  status?: ToastKind;
  message?: UiContent;
  children?: UiContent;
  content?: UiContent;
  dismissible?: boolean;
  closeLabel?: string;
  onDismiss?: (event: MouseEvent) => void;
}

export interface SkeletonOptions extends ElementOptions {
  width?: string;
  height?: string;
}

export interface EmptyStateOptions extends ElementOptions {
  title: UiContent;
  body?: UiContent;
  action?: UiContent;
  actionLabel?: UiContent;
  onAction?: (event: MouseEvent) => void;
}

export interface DialogOptions extends ElementOptions {
  title: UiContent;
  content?: UiContent;
  actions?: UiContent;
  /** Set false to omit the default close button, or provide custom close-button content. */
  close?: boolean | UiContent;
  closeLabel?: string;
  onClose?: (event: Event) => void;
  open?: boolean;
}

export interface SheetOptions extends ElementOptions {
  title: UiContent;
  content?: UiContent;
  actions?: UiContent;
  /** Set false to omit the default close button, or provide custom close-button content. */
  close?: boolean | UiContent;
  closeLabel?: string;
  onClose?: (event: Event) => void;
  open?: boolean;
}

export interface TabDefinition {
  id: string;
  label: UiContent;
  panel?: UiContent;
  content?: UiContent;
  disabled?: boolean;
}

export interface TabsOptions extends ElementOptions {
  tabs?: readonly TabDefinition[];
  items?: readonly TabDefinition[];
  selectedId?: string;
  activeId?: string;
  orientation?: "horizontal" | "vertical";
  onSelect?: (id: string, event?: Event) => void;
}

export interface TabsElement extends HTMLDivElement {
  /** Select a tab by its application id. Returns false for an unknown or disabled tab. */
  selectTab(id: string): boolean;
  readonly selectedTabId: string | null;
}

export interface StickyActionBarOptions extends ElementOptions {
  children?: UiContent;
  content?: UiContent;
  actions?: UiContent;
  label?: string;
}

let generatedId = 0;

function isDocument(value: unknown): value is Document {
  if (typeof value !== "object" || value === null) return false;
  return "nodeType" in value && (value as { nodeType?: unknown }).nodeType === 9;
}

function resolveDocument<T extends { document?: Document }>(
  documentOrOptions: Document | T | undefined,
  maybeOptions: T | undefined,
): [Document, T] {
  if (isDocument(documentOrOptions)) {
    return [documentOrOptions, maybeOptions ?? ({} as T)];
  }
  const options = documentOrOptions ?? ({} as T);
  if (options.document !== undefined) return [options.document, options];
  if (typeof globalThis.document !== "undefined") return [globalThis.document, options];
  throw new Error("A Document is required to create a UI element.");
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "nodeType" in value;
}

function appendContent(parent: Element, content: UiContent): void {
  if (content === null || content === undefined) return;
  if (Array.isArray(content)) {
    for (const item of content) appendContent(parent, item);
    return;
  }
  if (isNode(content)) {
    parent.append(content);
    return;
  }
  parent.append(parent.ownerDocument.createTextNode(String(content)));
}

function hasContent(content: UiContent): boolean {
  if (content === null || content === undefined) return false;
  if (typeof content === "string") return content.length > 0;
  if (Array.isArray(content)) return content.some((item) => hasContent(item));
  return true;
}

function contentFrom(options: {
  children?: UiContent;
  content?: UiContent;
  label?: UiContent;
}): UiContent {
  return options.children ?? options.content ?? options.label;
}

function nextId(document: Document, prefix: string): string {
  let id: string;
  do {
    generatedId += 1;
    id = `${prefix}-${generatedId}`;
  } while (document.getElementById(id) !== null);
  return id;
}

function classNames(...values: readonly (string | false | undefined)[]): string {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

function applyOptions(element: HTMLElement, options: ElementOptions, baseClass: string): void {
  if (options.attributes !== undefined) {
    for (const [name, value] of Object.entries(options.attributes)) {
      if (value === null || value === undefined || value === false) {
        element.removeAttribute(name);
      } else if (typeof value === "boolean") {
        element.setAttribute(name, "true");
      } else {
        element.setAttribute(name, String(value));
      }
    }
  }
  if (options.id !== undefined) element.id = options.id;
  element.className = classNames(baseClass, options.className);
}

function addClickHandler(
  element: HTMLElement,
  handler: ((event: MouseEvent) => void) | undefined,
): void {
  if (handler !== undefined) element.addEventListener("click", handler);
}

/** Create a button with one of the shared visual variants. */
export function Button(document: Document, options?: ButtonOptions): HTMLButtonElement;
export function Button(options?: ButtonOptions): HTMLButtonElement;
export function Button(
  documentOrOptions?: Document | ButtonOptions,
  maybeOptions?: ButtonOptions,
): HTMLButtonElement {
  const [document, options] = resolveDocument(documentOrOptions, maybeOptions);
  const element = document.createElement("button");
  applyOptions(
    element,
    options,
    classNames("ui-button", `ui-button--${options.variant ?? "primary"}`),
  );
  element.type = options.type ?? "button";
  element.disabled = options.disabled ?? false;
  appendContent(element, contentFrom(options));
  addClickHandler(element, options.onClick);
  return element;
}

/** Create an icon-only button. The label is deliberately required for screen-reader users. */
export function IconButton(document: Document, options: IconButtonOptions): HTMLButtonElement;
export function IconButton(options: IconButtonOptions): HTMLButtonElement;
export function IconButton(
  documentOrOptions: Document | IconButtonOptions,
  maybeOptions?: IconButtonOptions,
): HTMLButtonElement {
  const [document, options] = resolveDocument(documentOrOptions, maybeOptions);
  if (options.label.trim().length === 0)
    throw new Error("IconButton requires a non-empty accessible label.");
  const element = document.createElement("button");
  applyOptions(
    element,
    options,
    classNames(
      "ui-button",
      "ui-icon-button",
      "ui-button--icon",
      `ui-button--${options.variant ?? "ghost"}`,
    ),
  );
  element.type = options.type ?? "button";
  element.disabled = options.disabled ?? false;
  element.setAttribute("aria-label", options.label);
  appendContent(element, options.children ?? options.content ?? options.icon);
  addClickHandler(element, options.onClick);
  return element;
}

/** Create a card. Interactive cards get keyboard activation as well as click activation. */
export function Card(document: Document, options?: CardOptions): HTMLElement;
export function Card(options?: CardOptions): HTMLElement;
export function Card(
  documentOrOptions?: Document | CardOptions,
  maybeOptions?: CardOptions,
): HTMLElement {
  const [document, options] = resolveDocument(documentOrOptions, maybeOptions);
  const element = document.createElement("article");
  const variant = options.variant ?? "flat";
  applyOptions(element, options, classNames("ui-card", `ui-card--${variant}`));
  appendContent(element, options.children ?? options.content);
  if (variant === "interactive") {
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    addClickHandler(element, options.onClick);
    if (options.onClick !== undefined) {
      element.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        element.click();
      });
    }
  } else if (options.onClick !== undefined) {
    addClickHandler(element, options.onClick);
  }
  return element;
}

/** Create a status chip with a stable status modifier class. */
export function StatusChip(document: Document, options?: StatusChipOptions): HTMLSpanElement;
export function StatusChip(options?: StatusChipOptions): HTMLSpanElement;
export function StatusChip(
  documentOrOptions?: Document | StatusChipOptions,
  maybeOptions?: StatusChipOptions,
): HTMLSpanElement {
  const [document, options] = resolveDocument(documentOrOptions, maybeOptions);
  const status = options.status ?? "neutral";
  const element = document.createElement("span");
  applyOptions(element, options, classNames("ui-status-chip", `ui-status-chip--${status}`));
  appendContent(element, contentFrom(options));
  return element;
}

/**
 * Wrap an existing form control and wire its label, hint, and error description.
 * The control is moved into the field; it is never cloned, so listeners and state survive.
 */
export function Field(document: Document, options: FieldOptions): HTMLDivElement;
export function Field(options: FieldOptions): HTMLDivElement;
export function Field(
  documentOrOptions: Document | FieldOptions,
  maybeOptions?: FieldOptions,
): HTMLDivElement {
  const [document, options] = resolveDocument(documentOrOptions, maybeOptions);
  const field = document.createElement("div");
  applyOptions(field, options, "ui-field");

  const controlId = options.control.id || nextId(document, "ui-field-control");
  options.control.id = controlId;

  const label = document.createElement("label");
  label.className = "ui-field__label";
  label.htmlFor = controlId;
  appendContent(label, options.label);
  field.append(label, options.control);

  const describedBy = new Set(
    (options.control.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean),
  );
  if (hasContent(options.hint)) {
    const hint = document.createElement("p");
    hint.id = nextId(document, `${controlId}-hint`);
    hint.className = "ui-field__hint";
    appendContent(hint, options.hint);
    describedBy.add(hint.id);
    field.append(hint);
  }
  if (hasContent(options.error)) {
    const error = document.createElement("p");
    error.id = nextId(document, `${controlId}-error`);
    error.className = "ui-field__error";
    appendContent(error, options.error);
    describedBy.add(error.id);
    options.control.setAttribute("aria-invalid", "true");
    field.append(error);
  }
  if (describedBy.size > 0)
    options.control.setAttribute("aria-describedby", [...describedBy].join(" "));
  return field;
}

/** Create a live status or alert message. */
export function Toast(document: Document, options?: ToastOptions): HTMLDivElement;
export function Toast(options?: ToastOptions): HTMLDivElement;
export function Toast(
  documentOrOptions?: Document | ToastOptions,
  maybeOptions?: ToastOptions,
): HTMLDivElement {
  const [document, options] = resolveDocument(documentOrOptions, maybeOptions);
  const status = options.status ?? "status";
  const element = document.createElement("div");
  applyOptions(element, options, classNames("ui-toast", `ui-toast--${status}`));
  element.setAttribute("role", status);
  element.setAttribute("aria-live", status === "alert" ? "assertive" : "polite");
  element.setAttribute("aria-atomic", "true");
  appendContent(element, options.children ?? options.content ?? options.message);
  if (options.dismissible) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ui-toast__dismiss";
    close.setAttribute("aria-label", options.closeLabel ?? "알림 닫기");
    close.textContent = "×";
    if (options.onDismiss !== undefined) close.addEventListener("click", options.onDismiss);
    element.append(close);
  }
  return element;
}

/** Create a visual loading placeholder. It is hidden from assistive technology. */
export function Skeleton(document: Document, options?: SkeletonOptions): HTMLSpanElement;
export function Skeleton(options?: SkeletonOptions): HTMLSpanElement;
export function Skeleton(
  documentOrOptions?: Document | SkeletonOptions,
  maybeOptions?: SkeletonOptions,
): HTMLSpanElement {
  const [document, options] = resolveDocument(documentOrOptions, maybeOptions);
  const element = document.createElement("span");
  applyOptions(element, options, "ui-skeleton");
  element.setAttribute("aria-hidden", "true");
  if (options.width !== undefined) element.style.width = options.width;
  if (options.height !== undefined) element.style.height = options.height;
  return element;
}

/** Create the standard title/body/action empty state. */
export function EmptyState(document: Document, options: EmptyStateOptions): HTMLElement;
export function EmptyState(options: EmptyStateOptions): HTMLElement;
export function EmptyState(
  documentOrOptions: Document | EmptyStateOptions,
  maybeOptions?: EmptyStateOptions,
): HTMLElement {
  const [document, options] = resolveDocument(documentOrOptions, maybeOptions);
  const element = document.createElement("section");
  applyOptions(element, options, "ui-empty-state");
  const title = document.createElement("h2");
  title.className = "ui-empty-state__title";
  appendContent(title, options.title);
  element.append(title);
  if (hasContent(options.body)) {
    const body = document.createElement("p");
    body.className = "ui-empty-state__body";
    appendContent(body, options.body);
    element.append(body);
  }
  if (hasContent(options.action) || hasContent(options.actionLabel)) {
    const action = document.createElement("div");
    action.className = "ui-empty-state__action";
    if (hasContent(options.action)) {
      appendContent(action, options.action);
    } else {
      const buttonOptions: ButtonOptions = { label: options.actionLabel };
      if (options.onAction !== undefined) {
        buttonOptions.onClick = options.onAction;
      }
      const button = Button(document, buttonOptions);
      action.append(button);
    }
    element.append(action);
  }
  return element;
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  }
}

function addCloseControl(
  document: Document,
  dialog: HTMLDialogElement,
  close: boolean | UiContent | undefined,
  closeLabel: string,
  className: string,
): void {
  if (close === false) return;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = className;
  closeButton.setAttribute("aria-label", closeLabel);
  appendContent(closeButton, close === true || close === undefined ? "×" : close);
  closeButton.addEventListener("click", () => closeDialog(dialog));
  dialog.append(closeButton);
}

function addDialogSurface(
  document: Document,
  dialog: HTMLDialogElement,
  options: DialogOptions | SheetOptions,
  surfaceClass: string,
  titleClass: string,
  closeClass: string,
): void {
  applyOptions(dialog, options, surfaceClass);
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const titleId = nextId(document, `${surfaceClass.replace(/[^a-z0-9]+/giu, "-")}-title`);
  const title = document.createElement("h2");
  title.id = titleId;
  title.className = titleClass;
  appendContent(title, options.title);
  dialog.setAttribute("aria-labelledby", titleId);

  const header = document.createElement("header");
  header.className = `${surfaceClass}__header`;
  header.append(title);
  dialog.append(header);
  addCloseControl(document, dialog, options.close, options.closeLabel ?? "닫기", closeClass);

  if (hasContent(options.content)) {
    const content = document.createElement("div");
    content.className = `${surfaceClass}__content`;
    appendContent(content, options.content);
    dialog.append(content);
  }
  if (hasContent(options.actions)) {
    const actions = document.createElement("footer");
    actions.className = `${surfaceClass}__actions`;
    appendContent(actions, options.actions);
    dialog.append(actions);
  }
  if (options.onClose !== undefined) dialog.addEventListener("close", options.onClose);
  if (options.open) dialog.setAttribute("open", "");
}

/** Create a native modal dialog with a labelled title and close control. */
export function Dialog(document: Document, options: DialogOptions): HTMLDialogElement;
export function Dialog(options: DialogOptions): HTMLDialogElement;
export function Dialog(
  documentOrOptions: Document | DialogOptions,
  maybeOptions?: DialogOptions,
): HTMLDialogElement {
  const [document, options] = resolveDocument(documentOrOptions, maybeOptions);
  const dialog = document.createElement("dialog");
  addDialogSurface(document, dialog, options, "ui-dialog", "ui-dialog__title", "ui-dialog__close");
  return dialog;
}

/** Create a native dialog styled as a sheet while retaining dialog semantics. */
export function Sheet(document: Document, options: SheetOptions): HTMLDialogElement;
export function Sheet(options: SheetOptions): HTMLDialogElement;
export function Sheet(
  documentOrOptions: Document | SheetOptions,
  maybeOptions?: SheetOptions,
): HTMLDialogElement {
  const [document, options] = resolveDocument(documentOrOptions, maybeOptions);
  const dialog = document.createElement("dialog");
  addDialogSurface(document, dialog, options, "ui-sheet", "ui-sheet__title", "ui-sheet__close");
  return dialog;
}

function tabId(prefix: string, id: string, index: number): string {
  const safeId = id.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "") || "tab";
  return `${prefix}-${safeId}-${index + 1}`;
}

/** Create a connected ARIA tablist and tabpanels. */
export function Tabs(document: Document, options?: TabsOptions): TabsElement;
export function Tabs(options?: TabsOptions): TabsElement;
export function Tabs(
  documentOrOptions?: Document | TabsOptions,
  maybeOptions?: TabsOptions,
): TabsElement {
  const [document, options] = resolveDocument(documentOrOptions, maybeOptions);
  const root = document.createElement("div") as TabsElement;
  applyOptions(root, options, "ui-tabs");
  const definitions = options.tabs ?? options.items ?? [];
  const prefix = nextId(document, "ui-tabs");
  const tablist = document.createElement("div");
  tablist.className = "ui-tabs__list";
  tablist.setAttribute("role", "tablist");
  if (options.orientation === "vertical") tablist.setAttribute("aria-orientation", "vertical");
  root.append(tablist);

  const records = definitions.map((definition, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ui-tabs__tab";
    button.id = tabId(`${prefix}-tab`, definition.id, index);
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", tabId(`${prefix}-panel`, definition.id, index));
    button.disabled = definition.disabled ?? false;
    appendContent(button, definition.label);

    const panel = document.createElement("div");
    panel.className = "ui-tabs__panel";
    panel.id = tabId(`${prefix}-panel`, definition.id, index);
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    panel.tabIndex = 0;
    appendContent(panel, definition.panel ?? definition.content);
    tablist.append(button);
    root.append(panel);
    return { definition, button, panel };
  });

  const firstEnabled = records.find((record) => !record.definition.disabled);
  let selectedId: string | null = records.some(
    (record) =>
      record.definition.id === (options.selectedId ?? options.activeId) &&
      !record.definition.disabled,
  )
    ? (options.selectedId ?? options.activeId ?? null)
    : (firstEnabled?.definition.id ?? null);

  const updateSelection = (id: string, event?: Event, focus = false): boolean => {
    const record = records.find((candidate) => candidate.definition.id === id);
    if (record === undefined || record.definition.disabled) return false;
    const changed = selectedId !== id;
    selectedId = id;
    for (const candidate of records) {
      const active = candidate.definition.id === id;
      candidate.button.setAttribute("aria-selected", String(active));
      candidate.button.tabIndex = active ? 0 : -1;
      candidate.button.classList.toggle("is-selected", active);
      candidate.panel.hidden = !active;
    }
    root.dataset.selectedTab = id;
    if (focus) record.button.focus();
    if (changed) {
      if (event === undefined) options.onSelect?.(id);
      else options.onSelect?.(id, event);
    }
    return true;
  };

  for (const [index, record] of records.entries()) {
    record.button.addEventListener("click", (event) =>
      updateSelection(record.definition.id, event),
    );
    record.button.addEventListener("keydown", (event) => {
      const horizontal = options.orientation !== "vertical";
      const forward = horizontal ? event.key === "ArrowRight" : event.key === "ArrowDown";
      const backward = horizontal ? event.key === "ArrowLeft" : event.key === "ArrowUp";
      if (!forward && !backward && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      const enabled = records.filter((candidate) => !candidate.definition.disabled);
      if (enabled.length === 0) return;
      const current = enabled.indexOf(record);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? enabled.length - 1
            : (current + (forward ? 1 : -1) + enabled.length) % enabled.length;
      updateSelection(enabled[next]?.definition.id ?? record.definition.id, event, true);
    });
    if (index === 0) record.button.tabIndex = 0;
  }
  Object.defineProperty(root, "selectTab", {
    value: (id: string) => updateSelection(id),
    enumerable: false,
  });
  Object.defineProperty(root, "selectedTabId", { get: () => selectedId, enumerable: false });
  if (selectedId !== null) updateSelection(selectedId);
  return root;
}

/** Create the bottom action region used by focused workflows. */
export function StickyActionBar(document: Document, options?: StickyActionBarOptions): HTMLElement;
export function StickyActionBar(options?: StickyActionBarOptions): HTMLElement;
export function StickyActionBar(
  documentOrOptions?: Document | StickyActionBarOptions,
  maybeOptions?: StickyActionBarOptions,
): HTMLElement {
  const [document, options] = resolveDocument(documentOrOptions, maybeOptions);
  const element = document.createElement("div");
  applyOptions(element, options, "ui-sticky-action-bar");
  element.setAttribute("role", "region");
  if (options.label !== undefined) element.setAttribute("aria-label", options.label);
  appendContent(element, options.children ?? options.content);
  if (hasContent(options.actions)) {
    const actions = document.createElement("div");
    actions.className = "ui-sticky-action-bar__actions";
    appendContent(actions, options.actions);
    element.append(actions);
  }
  return element;
}

// Lower-camel aliases make the primitives convenient in existing view modules while the named
// exports above remain the canonical API used by design-system documentation.
export const button = Button;
export const iconButton = IconButton;
export const card = Card;
export const statusChip = StatusChip;
export const field = Field;
export const toast = Toast;
export const skeleton = Skeleton;
export const emptyState = EmptyState;
export const dialog = Dialog;
export const sheet = Sheet;
export const tabs = Tabs;
export const stickyActionBar = StickyActionBar;
