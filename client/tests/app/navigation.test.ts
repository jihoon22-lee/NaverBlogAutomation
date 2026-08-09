/** Global navigation: reaching each section, marking the current one, and focus handling. */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createNavigation, focusWorkspace, NAV_ID } from "../../src/app/navigation";

function shell(): Document {
  document.body.innerHTML = `
    <header>
      <nav id="${NAV_ID}" aria-label="작업 화면">
        <button type="button" data-section="home" aria-current="page">
          <svg class="nav-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 5h16v14H4V5Z" /></svg>
          <span class="nav-label">홈</span>
        </button>
        <button type="button" data-section="workbench">
          <svg class="nav-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 5h16v14H4V5Z" /></svg>
          <span class="nav-label">작업함</span>
        </button>
        <button type="button" data-section="writing">
          <svg class="nav-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 5h16v14H4V5Z" /></svg>
          <span class="nav-label">글쓰기</span>
        </button>
        <button type="button" data-section="more">
          <svg class="nav-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 5h16v14H4V5Z" /></svg>
          <span class="nav-label">관리</span>
        </button>
      </nav>
    </header>
    <main id="workspace"><p id="workspace-status">준비됐습니다.</p></main>
  `;
  return document;
}

function tab(section: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-section="${section}"]`);
  if (button === null) throw new Error(`missing tab: ${section}`);
  return button;
}

describe("createNavigation", () => {
  beforeEach(() => {
    shell();
  });

  it("reports a click on each section", () => {
    const onSelect = vi.fn();
    createNavigation(document, { onSelect });

    tab("writing").click();
    tab("home").click();

    expect(onSelect.mock.calls).toEqual([["writing"], ["home"]]);
  });

  it("keeps navigation labels as accessible button names beside decorative icons", () => {
    const navigation = createNavigation(document, { onSelect: vi.fn() });

    expect(navigation).not.toBeNull();
    const labels = new Map([
      ["home", "홈"],
      ["workbench", "작업함"],
      ["writing", "글쓰기"],
      ["more", "관리"],
    ]);
    for (const [section, label] of labels) {
      const button = tab(section);
      expect(button.hasAttribute("aria-label")).toBe(false);
      expect(button.querySelector("svg.nav-icon")?.getAttribute("aria-hidden")).toBe("true");
      expect(button.querySelector("span.nav-label")?.textContent).toBe(label);
      expect(button.textContent?.trim()).toContain(label);
    }
  });

  it("marks only the current section", () => {
    const navigation = createNavigation(document, { onSelect: vi.fn() });

    navigation?.mark("writing");

    expect(tab("writing").getAttribute("aria-current")).toBe("page");
    expect(tab("home").hasAttribute("aria-current")).toBe(false);
  });

  it("moves the mark back when the other section becomes current", () => {
    const navigation = createNavigation(document, { onSelect: vi.fn() });
    navigation?.mark("writing");

    navigation?.mark("home");

    expect(tab("home").getAttribute("aria-current")).toBe("page");
    expect(tab("writing").hasAttribute("aria-current")).toBe(false);
  });

  it("marking does not invoke the handler", () => {
    const onSelect = vi.fn();
    const navigation = createNavigation(document, { onSelect });

    navigation?.mark("writing");

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("returns null when the shell has no nav", () => {
    document.body.innerHTML = '<main id="workspace"></main>';

    expect(createNavigation(document, { onSelect: vi.fn() })).toBeNull();
  });

  it("tolerates a nav that is missing one button", () => {
    document.body.innerHTML = `<nav id="${NAV_ID}">
      <button type="button" data-section="home"></button>
    </nav>`;
    const onSelect = vi.fn();

    const navigation = createNavigation(document, { onSelect });
    navigation?.mark("writing");
    tab("home").click();

    expect(onSelect.mock.calls).toEqual([["home"]]);
  });
});

describe("focusWorkspace", () => {
  beforeEach(() => {
    shell();
  });

  it("focuses the status line so a screen reader lands on the new section", () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing root");

    focusWorkspace(root);

    expect(document.activeElement?.id).toBe("workspace-status");
  });

  it("makes the status line focusable without adding it to the tab order", () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing root");

    focusWorkspace(root);

    expect(document.getElementById("workspace-status")?.getAttribute("tabindex")).toBe("-1");
  });

  it("falls back to the root when no status line exists yet", () => {
    document.body.innerHTML = '<main id="workspace"></main>';
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing root");

    focusWorkspace(root);

    expect(document.activeElement?.id).toBe("workspace");
  });
});
