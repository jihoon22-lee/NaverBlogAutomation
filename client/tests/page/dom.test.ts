import { beforeEach, describe, expect, it } from "vitest";

import {
  collectVisibleText,
  elementSelector,
  isEditable,
  isEnabled,
  isInteractable,
  isVisible,
  normalizeExtractedText,
  queryAllUnique,
  readValue,
} from "../../src/page/dom";
import { setBody } from "../fixtures/naver";

beforeEach(() => {
  setBody("");
});

describe("elementSelector", () => {
  it("returns a selector that resolves to exactly the same element", () => {
    setBody("<div><span>a</span><span id='target'>b</span><span>c</span></div>");
    const target = document.getElementById("target") as Element;

    const selector = elementSelector(target);

    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)).toBe(target);
  });

  it("distinguishes siblings of the same tag", () => {
    setBody("<ul><li>1</li><li>2</li><li>3</li></ul>");
    const items = Array.from(document.querySelectorAll("li"));

    const selectors = items.map(elementSelector);

    expect(new Set(selectors).size).toBe(3);
    for (const [index, selector] of selectors.entries()) {
      expect(document.querySelector(selector)).toBe(items[index]);
    }
  });

  it("handles deeply nested elements", () => {
    setBody("<div><div><div><p><em>deep</em></p></div></div></div>");
    const target = document.querySelector("em") as Element;

    expect(document.querySelector(elementSelector(target))).toBe(target);
  });

  it("handles a detached element without throwing", () => {
    const detached = document.createElement("div");

    expect(elementSelector(detached)).toBe("div");
  });
});

describe("visibility helpers", () => {
  it("treats a plain element as visible and interactable", () => {
    setBody("<div><span id='t'>text</span></div>");
    const target = document.getElementById("t") as Element;

    expect(isVisible(target)).toBe(true);
    expect(isInteractable(target)).toBe(true);
  });

  it("rejects a hidden attribute", () => {
    setBody("<span id='t' hidden>text</span>");

    expect(isVisible(document.getElementById("t") as Element)).toBe(false);
  });

  it("rejects aria-hidden", () => {
    setBody("<span id='t' aria-hidden='true'>text</span>");

    expect(isVisible(document.getElementById("t") as Element)).toBe(false);
  });

  it("rejects display none", () => {
    setBody("<span id='t' style='display: none'>text</span>");

    expect(isVisible(document.getElementById("t") as Element)).toBe(false);
  });

  it("rejects visibility hidden and collapse", () => {
    setBody(
      "<span id='a' style='visibility: hidden'>a</span><span id='b' style='visibility: collapse'>b</span>",
    );

    expect(isVisible(document.getElementById("a") as Element)).toBe(false);
    expect(isVisible(document.getElementById("b") as Element)).toBe(false);
  });

  it("rejects zero opacity and pointer-events none", () => {
    setBody(
      "<span id='a' style='opacity: 0'>a</span><span id='b' style='pointer-events: none'>b</span>",
    );

    expect(isVisible(document.getElementById("a") as Element)).toBe(false);
    expect(isVisible(document.getElementById("b") as Element)).toBe(false);
  });

  it("rejects an element inside a hidden ancestor", () => {
    setBody("<div style='display: none'><span id='t'>text</span></div>");
    const target = document.getElementById("t") as Element;

    expect(isVisible(target)).toBe(true);
    expect(isInteractable(target)).toBe(false);
  });
});

describe("isEnabled", () => {
  it("accepts an enabled control", () => {
    setBody("<button id='t'>ok</button>");

    expect(isEnabled(document.getElementById("t") as Element)).toBe(true);
  });

  it("rejects disabled and aria-disabled controls", () => {
    setBody("<button id='a' disabled>a</button><button id='b' aria-disabled='true'>b</button>");

    expect(isEnabled(document.getElementById("a") as Element)).toBe(false);
    expect(isEnabled(document.getElementById("b") as Element)).toBe(false);
  });
});

describe("editable helpers", () => {
  it("accepts a writable textarea", () => {
    setBody("<textarea id='t'>value</textarea>");
    const target = document.getElementById("t") as Element;

    expect(isEditable(target)).toBe(true);
    expect(readValue(target)).toBe("value");
  });

  it("rejects a disabled or read-only textarea", () => {
    setBody("<textarea id='a' disabled></textarea><textarea id='b' readonly></textarea>");

    expect(isEditable(document.getElementById("a") as Element)).toBe(false);
    expect(isEditable(document.getElementById("b") as Element)).toBe(false);
  });

  it("accepts a contenteditable element and reads its text", () => {
    setBody("<div id='t' contenteditable='true'>편집 가능</div>");
    const target = document.getElementById("t") as Element;

    expect(isEditable(target)).toBe(true);
    expect(readValue(target)).toBe("편집 가능");
  });

  it("rejects an aria-disabled contenteditable element", () => {
    setBody("<div id='t' contenteditable='true' aria-disabled='true'></div>");

    expect(isEditable(document.getElementById("t") as Element)).toBe(false);
  });
});

describe("normalizeExtractedText", () => {
  it("collapses inline whitespace and drops empty lines", () => {
    expect(normalizeExtractedText("  a   b \n\n  c  ")).toBe("a b\nc");
  });

  it("replaces non-breaking spaces", () => {
    expect(normalizeExtractedText("a\u00a0b")).toBe("a b");
  });

  it("returns an empty string for whitespace only", () => {
    expect(normalizeExtractedText("   \n\t  ")).toBe("");
  });
});

describe("collectVisibleText", () => {
  it("bounds the retained text while counting the original length", () => {
    setBody("<div id='t'>가나다라마</div>");
    const target = document.getElementById("t") as Element;

    const collected = collectVisibleText(target, 3);

    expect(collected.text).toBe("가나다");
    expect(collected.originalLength).toBe(5);
  });

  it("separates block elements with newlines", () => {
    setBody("<div id='t'><p>첫</p><p>둘</p></div>");

    expect(collectVisibleText(document.getElementById("t") as Element, 100).text).toBe("첫\n둘");
  });

  it("skips excluded regions", () => {
    setBody("<div id='t'><p>본문</p><div class='comment'>댓글</div><script>1</script></div>");

    const collected = collectVisibleText(document.getElementById("t") as Element, 100);

    expect(collected.text).toBe("본문");
  });

  it("ignores comment nodes", () => {
    setBody("<div id='t'><!-- 주석 --><p>본문</p></div>");

    expect(collectVisibleText(document.getElementById("t") as Element, 100).text).toBe("본문");
  });
});

describe("queryAllUnique", () => {
  it("returns each element once in selector order", () => {
    setBody("<div><p class='a b'>1</p><p class='b'>2</p></div>");

    const found = queryAllUnique([".a", ".b"], document);

    expect(found).toHaveLength(2);
    expect(found[0]?.textContent).toBe("1");
  });

  it("returns an empty list when nothing matches", () => {
    setBody("<div></div>");

    expect(queryAllUnique([".missing"], document)).toHaveLength(0);
  });
});
