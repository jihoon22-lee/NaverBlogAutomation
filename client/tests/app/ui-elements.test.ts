import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Sheet,
  Skeleton,
  StatusChip,
  StickyActionBar,
  Tabs,
  Toast,
} from "../../src/app/ui/elements";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("basic UI elements", () => {
  it("creates button variants and an accessible icon button", () => {
    const clicked = vi.fn();
    const button = Button(document, { label: "저장", variant: "secondary", onClick: clicked });
    document.body.append(button);
    expect(button.className).toContain("ui-button--secondary");
    expect(button.type).toBe("button");
    button.click();
    expect(clicked).toHaveBeenCalledOnce();

    const icon = IconButton(document, { label: "닫기", children: "×" });
    expect(icon.className).toContain("ui-button--icon");
    expect(icon.getAttribute("aria-label")).toBe("닫기");
  });

  it("supports the options-only overload, element attributes, and content fallbacks", () => {
    const child = document.createElement("strong");
    child.textContent = "강조";
    const button = Button({
      label: ["저장 ", null, 2, child],
      id: "save-button",
      className: "custom-button",
      attributes: {
        "data-number": 7,
        "data-true": true,
        "data-false": false,
        "data-null": null,
        "data-undefined": undefined,
      },
    });
    expect(button.id).toBe("save-button");
    expect(button.className).toContain("custom-button");
    expect(button.dataset.number).toBe("7");
    expect(button.dataset.true).toBe("true");
    expect(button.hasAttribute("data-false")).toBe(false);
    expect(button.hasAttribute("data-null")).toBe(false);
    expect(button.hasAttribute("data-undefined")).toBe(false);
    expect(button.textContent).toBe("저장 2강조");

    const explicitDocument = Button({ document, label: "문서 지정" });
    expect(explicitDocument.ownerDocument).toBe(document);
    const noOptions = Button(document);
    expect(noOptions.textContent).toBe("");

    const iconContent = IconButton({ label: "메뉴", content: "☰" });
    const iconFallback = IconButton({ label: "검색", icon: "⌕" });
    expect(iconContent.textContent).toBe("☰");
    expect(iconFallback.textContent).toBe("⌕");
    expect(() => IconButton({ label: "   " })).toThrow("accessible label");
  });

  it("makes interactive cards keyboard-activatable and styles status chips", () => {
    const clicked = vi.fn();
    const card = Card(document, { variant: "interactive", children: "초안", onClick: clicked });
    card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(clicked).toHaveBeenCalledOnce();
    expect(card.getAttribute("role")).toBe("button");
    expect(card.tabIndex).toBe(0);

    const chip = StatusChip(document, { status: "needs-action", label: "확인 필요" });
    expect(chip.className).toContain("ui-status-chip--needs-action");
    expect(chip.textContent).toBe("확인 필요");
  });

  it("covers flat/status cards and both interactive keyboard paths", () => {
    const flat = Card({ children: "기본 카드" });
    const status = Card(document, { variant: "status", content: "상태 카드" });
    const passiveClick = vi.fn();
    const passive = Card(document, { onClick: passiveClick });
    expect(flat.className).toContain("ui-card--flat");
    expect(status.className).toContain("ui-card--status");
    expect(status.textContent).toBe("상태 카드");
    expect(passive.getAttribute("role")).toBeNull();
    passive.click();
    expect(passiveClick).toHaveBeenCalledOnce();

    const clicked = vi.fn();
    const interactive = Card(document, { variant: "interactive", onClick: clicked });
    interactive.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    interactive.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("connects field label and descriptions to the supplied control", () => {
    const input = document.createElement("input");
    input.setAttribute("aria-describedby", "existing-help");
    const field = Field(document, {
      label: "블로그 ID",
      control: input,
      hint: "영문 ID를 입력하세요.",
      error: "블로그 ID를 확인하세요.",
    });
    const label = field.querySelector("label");
    const describedBy = input.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(field.className).toBe("ui-field");
    expect(label?.htmlFor).toBe(input.id);
    expect(describedBy).toContain("existing-help");
    expect(describedBy).toHaveLength(3);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(field.querySelector(".ui-field__hint")).not.toBeNull();
    expect(field.querySelector(".ui-field__error")).not.toBeNull();
  });

  it("keeps a clean field when optional descriptions are absent", () => {
    const input = document.createElement("input");
    input.id = "existing-control";
    const field = Field({
      label: "제목",
      control: input,
      id: "title-field",
      className: "custom-field",
    });
    expect(field.id).toBe("title-field");
    expect(field.className).toContain("custom-field");
    expect(input.id).toBe("existing-control");
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(field.querySelector(".ui-field__hint")).toBeNull();
    expect(field.querySelector(".ui-field__error")).toBeNull();
  });

  it("keeps the field and generated control IDs unique", () => {
    const input = document.createElement("input");
    const field = Field({ label: "제목", control: input, id: "title-field" });

    expect(field.id).toBe("title-field");
    expect(input.id).not.toBe("title-field");
    expect(field.querySelector("label")?.htmlFor).toBe(input.id);
  });

  it("creates live toasts, hidden skeletons, and empty states", () => {
    const dismissed = vi.fn();
    const toast = Toast(document, {
      status: "alert",
      message: "저장에 실패했습니다.",
      dismissible: true,
      onDismiss: dismissed,
    });
    expect(toast.className).toContain("ui-toast--alert");
    expect(toast.getAttribute("role")).toBe("alert");
    (toast.querySelector("button") as HTMLButtonElement).click();
    expect(dismissed).toHaveBeenCalledOnce();

    const skeleton = Skeleton(document, { width: "12rem" });
    expect(skeleton.className).toBe("ui-skeleton");
    expect(skeleton.getAttribute("aria-hidden")).toBe("true");
    expect(skeleton.style.width).toBe("12rem");

    const action = Button(document, { label: "새로고침" });
    const empty = EmptyState(document, {
      title: "초안이 없습니다",
      body: "새 글을 시작하세요.",
      action,
    });
    expect(empty.className).toBe("ui-empty-state");
    expect(empty.querySelector("button")).toBe(action);
  });

  it("covers default toast, optional dismissal, skeleton height, and actionLabel", () => {
    const toast = Toast({ message: "저장되었습니다." });
    expect(toast.className).toContain("ui-toast--status");
    expect(toast.getAttribute("aria-live")).toBe("polite");
    expect(toast.querySelector("button")).toBeNull();

    const dismissible = Toast(document, { dismissible: true });
    expect(dismissible.querySelector("button")).not.toBeNull();
    const skeleton = Skeleton({ height: "2rem", className: "wide" });
    expect(skeleton.style.height).toBe("2rem");
    expect(skeleton.style.width).toBe("");
    expect(skeleton.className).toContain("wide");

    const onAction = vi.fn();
    const empty = EmptyState({
      title: "아직 작업이 없습니다",
      actionLabel: "작업 시작",
      onAction,
    });
    const action = empty.querySelector("button") as HTMLButtonElement;
    action.click();
    expect(action.textContent).toBe("작업 시작");
    expect(onAction).toHaveBeenCalledOnce();
  });
});

describe("dialog and sheet", () => {
  it("uses native dialog semantics and closes through the labelled control", () => {
    const close = vi.fn();
    const dialog = Dialog(document, {
      title: "설정",
      content: "연결 상태",
      actions: Button(document, { label: "저장" }),
      onClose: close,
    });
    document.body.append(dialog);
    expect(dialog.className).toBe("ui-dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBe(dialog.querySelector("h2")?.id);
    expect(dialog.querySelector(".ui-dialog__content")?.textContent).toBe("연결 상태");
    (dialog.querySelector(".ui-dialog__close") as HTMLButtonElement).click();
    expect(close).toHaveBeenCalledOnce();

    const sheet = Sheet(document, { title: "필터", close: false });
    expect(sheet.className).toBe("ui-sheet");
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.querySelector(".ui-sheet__close")).toBeNull();
  });

  it("supports an open dialog and custom close content", () => {
    const dialog = Dialog({
      title: "확인",
      close: "나가기",
      closeLabel: "대화상자 닫기",
      open: true,
    });
    expect(dialog.hasAttribute("open")).toBe(true);
    const close = dialog.querySelector(".ui-dialog__close") as HTMLButtonElement;
    expect(close.textContent).toBe("나가기");
    expect(close.getAttribute("aria-label")).toBe("대화상자 닫기");
  });
});

describe("tabs and sticky action bar", () => {
  it("connects tabs to panels and selects with callback and keyboard navigation", () => {
    const onSelect = vi.fn();
    const tabs = Tabs(document, {
      tabs: [
        { id: "drafts", label: "초안", panel: "초안 목록" },
        { id: "published", label: "게시됨", panel: "게시물 목록" },
      ],
      onSelect,
    });
    document.body.append(tabs);
    const tabButtons = tabs.querySelectorAll<HTMLButtonElement>("[role=tab]");
    const panels = tabs.querySelectorAll<HTMLElement>("[role=tabpanel]");
    expect(tabs.className).toBe("ui-tabs");
    expect(tabButtons).toHaveLength(2);
    expect(tabButtons[0]?.getAttribute("aria-controls")).toBe(panels[0]?.id);
    expect(panels[0]?.getAttribute("aria-labelledby")).toBe(tabButtons[0]?.id);
    expect(panels[0]?.hidden).toBe(false);
    expect(panels[1]?.hidden).toBe(true);

    expect(tabs.selectTab("published")).toBe(true);
    expect(tabs.selectedTabId).toBe("published");
    expect(panels[0]?.hidden).toBe(true);
    expect(panels[1]?.hidden).toBe(false);
    expect(onSelect).toHaveBeenCalledWith("published");

    tabButtons[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(tabs.selectedTabId).toBe("drafts");
    expect(tabs.selectTab("unknown")).toBe(false);
  });

  it("supports item aliases, vertical navigation, disabled tabs, and empty tablists", () => {
    const onSelect = vi.fn();
    const tabs = Tabs({
      items: [
        { id: "!!!", label: "사용 안 함", disabled: true },
        { id: "second", label: "두 번째", content: "두 번째 패널" },
      ],
      activeId: "second",
      orientation: "vertical",
      onSelect,
    });
    const list = tabs.querySelector("[role=tablist]");
    const tabButtons = tabs.querySelectorAll<HTMLButtonElement>("[role=tab]");
    expect(list?.getAttribute("aria-orientation")).toBe("vertical");
    expect(tabButtons[0]?.disabled).toBe(true);
    expect(tabs.selectedTabId).toBe("second");
    expect(tabs.selectTab("!!!")).toBe(false);

    tabButtons[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(tabs.selectedTabId).toBe("second");

    const empty = Tabs({ tabs: [{ id: "only", label: "없음", disabled: true }] });
    const only = empty.querySelector("[role=tab]") as HTMLButtonElement;
    only.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(empty.selectedTabId).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("handles tab Home, End, and ignored keys", () => {
    const tabs = Tabs(document, {
      tabs: [
        { id: "first", label: "첫째", panel: "1" },
        { id: "middle", label: "가운데", panel: "2" },
        { id: "last", label: "마지막", panel: "3" },
      ],
    });
    const buttons = tabs.querySelectorAll<HTMLButtonElement>("[role=tab]");
    buttons[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(tabs.selectedTabId).toBe("last");
    buttons[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(tabs.selectedTabId).toBe("first");
    buttons[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(tabs.selectedTabId).toBe("first");
  });

  it("renders a labelled sticky action region", () => {
    const bar = StickyActionBar(document, {
      label: "초안 작업",
      content: "저장 상태",
      actions: Button(document, { label: "저장", variant: "primary" }),
    });
    expect(bar.className).toBe("ui-sticky-action-bar");
    expect(bar.getAttribute("role")).toBe("region");
    expect(bar.getAttribute("aria-label")).toBe("초안 작업");
    expect(bar.querySelector(".ui-sticky-action-bar__actions button")?.textContent).toBe("저장");

    const unlabeled = StickyActionBar({ children: "상태" });
    expect(unlabeled.getAttribute("aria-label")).toBeNull();
    expect(unlabeled.querySelector(".ui-sticky-action-bar__actions")).toBeNull();
  });
});
