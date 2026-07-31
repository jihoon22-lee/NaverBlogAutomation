import { beforeEach, describe, expect, it } from "vitest";

import { probeEditor, probeEditorSave, readEditorText } from "../../src/page/editor";
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
