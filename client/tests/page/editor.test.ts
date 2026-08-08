import { beforeEach, describe, expect, it } from "vitest";

import {
  probeEditor,
  probeEditorSave,
  readEditorBlocks,
  readEditorText,
} from "../../src/page/editor";
import { setBody } from "../fixtures/naver";

const EDITOR = `
  <div class="se-section-documentTitle">
    <div class="se-text-paragraph" contenteditable="true"></div>
  </div>
  <div class="se-main-container">
    <div class="se-component-content">
      <div class="se-text-paragraph" contenteditable="true"></div>
    </div>
  </div>
  <input type="file" accept="image/*" class="se-image-file-input" />
  <button class="save_btn__bzc5B">저장</button>
  <span class="text__d09H7">3</span>
`;

const RESTORE = `
  <div class="se-popup-restore">
    <p>작성 중인 글이 있습니다.</p>
    <button class="se-popup-alert-cancel">취소</button>
  </div>
  ${EDITOR}
`;

const BLOCK_ACTIONS = `
  <button aria-label="소제목">소제목</button>
  <button aria-label="인용구">인용구</button>
  <button aria-label="번호 목록">번호 목록</button>
  <button aria-label="글머리 기호">글머리 기호</button>
  <button aria-label="구분선">구분선</button>
  <input aria-label="태그 입력" />
`;

beforeEach(() => {
  setBody("");
});

describe("probeEditor", () => {
  it("reports a ready editor with every selector", () => {
    setBody(EDITOR);

    const probe = probeEditor();

    expect(probe.stage).toBe("ready");
    for (const selector of [
      probe.titleSelector,
      probe.bodySelector,
      probe.imageInputSelector,
      probe.saveSelector,
    ]) {
      expect(document.querySelectorAll(selector as string)).toHaveLength(1);
    }
  });

  it("reports the restore prompt before anything else", () => {
    setBody(RESTORE);

    const probe = probeEditor();

    expect(probe.stage).toBe("restore_prompt");
    expect(document.querySelectorAll(probe.restoreCancelSelector as string)).toHaveLength(1);
    expect(probe.titleSelector).toBeNull();
  });

  it("reports a restore prompt without a cancel control", () => {
    setBody(`<div class="se-popup-restore"><p>작성 중인 글</p></div>${EDITOR}`);

    const probe = probeEditor();

    expect(probe.stage).toBe("restore_prompt");
    expect(probe.restoreCancelSelector).toBeNull();
  });

  it("reports login_required before looking for fields", () => {
    setBody(`<a href="https://nid.naver.com/nidlogin.login">로그인</a>${EDITOR}`);

    expect(probeEditor().stage).toBe("login_required");
  });

  it("reports not_found without an editor", () => {
    setBody("<div><p>본문만 있는 문서</p></div>");

    expect(probeEditor().stage).toBe("not_found");
  });

  it("reports not_found without a save control", () => {
    setBody(EDITOR.replace('<button class="save_btn__bzc5B">저장</button>', ""));

    expect(probeEditor().stage).toBe("not_found");
  });

  it("reports ambiguous when two title fields match", () => {
    setBody(`${EDITOR}<div class="se-section-documentTitle"><div class="se-text-paragraph">
      </div></div>`);

    expect(probeEditor().stage).toBe("ambiguous");
  });

  it("ignores a disabled save control", () => {
    setBody(
      EDITOR.replace(
        '<button class="save_btn__bzc5B">',
        '<button disabled class="save_btn__bzc5B">',
      ),
    );

    expect(probeEditor().stage).toBe("not_found");
  });

  it("reports no image input when the editor has none", () => {
    setBody(EDITOR.replace(/<input[^>]*>/u, ""));

    const probe = probeEditor();

    expect(probe.stage).toBe("ready");
    expect(probe.imageInputSelector).toBeNull();
  });

  it("exposes only unambiguous block action and tag controls", () => {
    setBody(`${EDITOR}${BLOCK_ACTIONS}`);

    const probe = probeEditor();

    expect(probe.stage).toBe("ready");
    for (const selector of Object.values(probe.blockActionSelectors)) {
      expect(document.querySelectorAll(selector)).toHaveLength(1);
    }
    expect(Object.keys(probe.blockActionSelectors).sort()).toEqual([
      "divider",
      "heading",
      "ordered_list",
      "quote",
      "unordered_list",
    ]);
    expect(document.querySelectorAll(probe.tagInputSelector as string)).toHaveLength(1);
  });

  it("withholds ambiguous toolbar and file controls instead of choosing the first one", () => {
    setBody(
      `${EDITOR}${BLOCK_ACTIONS}<button aria-label="인용구">인용구</button><input type="file" accept="image/*" />`,
    );

    const probe = probeEditor();

    expect(probe.stage).toBe("ready");
    expect(probe.blockActionSelectors.quote).toBeUndefined();
    expect(probe.imageInputSelector).toBeNull();
  });
});

describe("probeEditorSave", () => {
  it("reports the saved count", () => {
    setBody(EDITOR);

    expect(probeEditorSave()).toEqual({ saved: true, savedCount: 3, diagnosis: null });
  });

  it("reports not saved when the count is zero", () => {
    setBody(EDITOR.replace(">3<", ">0<"));

    expect(probeEditorSave().saved).toBe(false);
  });

  it("reports no count when none is rendered", () => {
    setBody(EDITOR.replace(/<span[^>]*>3<\/span>/u, ""));

    expect(probeEditorSave()).toEqual({ saved: false, savedCount: null, diagnosis: null });
  });

  it("reports a captcha before a count", () => {
    setBody(`<div class="captcha">보안 문자</div>${EDITOR}`);

    expect(probeEditorSave().diagnosis).toBe("captcha_required");
  });

  it("reports a login requirement", () => {
    setBody(`<a href="https://nid.naver.com/nidlogin.login">로그인</a>${EDITOR}`);

    expect(probeEditorSave().diagnosis).toBe("login_required");
  });
});

describe("readEditorText", () => {
  it("reads a contenteditable field and drops zero-width characters", () => {
    setBody(`<div id="body" contenteditable="true">  본문\u200b입니다  </div>`);

    expect(readEditorText("#body")).toBe("본문입니다");
  });

  it("reads a textarea value", () => {
    setBody(`<textarea id="title">제목</textarea>`);

    expect(readEditorText("#title")).toBe("제목");
  });

  it("returns an empty string for a missing element", () => {
    expect(readEditorText("#missing")).toBe("");
  });
});

describe("readEditorBlocks", () => {
  it("returns an explicit semantic snapshot in document order", () => {
    setBody(`
      <div id="body">
        <h2>소제목</h2><p>문단</p><blockquote>인용</blockquote>
        <ol><li>첫째</li><li>둘째</li></ol><ul><li>목록</li></ul><hr />
        <figure><img src="x.png" /><figcaption>사진 설명</figcaption></figure>
      </div>
    `);

    expect(readEditorBlocks("#body")).toEqual([
      { type: "heading", text: "소제목" },
      { type: "paragraph", text: "문단" },
      { type: "quote", text: "인용" },
      { type: "ordered_list", items: ["첫째", "둘째"] },
      { type: "unordered_list", items: ["목록"] },
      { type: "divider" },
      { type: "image", caption: "사진 설명" },
    ]);
  });

  it("refuses an editor whose child structure is not recognized", () => {
    setBody('<div id="body"><span>평문</span></div>');

    expect(readEditorBlocks("#body")).toBeNull();
  });
});
