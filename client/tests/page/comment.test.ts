import { beforeEach, describe, expect, it } from "vitest";

import {
  captchaVisible,
  commentStillPending,
  countMatchingComments,
  diagnoseCommentPage,
  probeComment,
} from "../../src/page/comment";
import { commentEditor, commentOpener, publishedComment, setBody } from "../fixtures/naver";

const COMMENT = "합성 댓글입니다.";

beforeEach(() => {
  setBody("");
});

describe("probeComment", () => {
  it("reports a ready editor with editor and submit selectors", () => {
    setBody(commentEditor());

    const probe = probeComment(COMMENT);

    expect(probe.code).toBe("ready");
    expect(probe.state).toBe("empty");
    expect(document.querySelectorAll(probe.editorSelector as string)).toHaveLength(1);
    expect(document.querySelectorAll(probe.submitSelector as string)).toHaveLength(1);
  });

  it("reports already_filled when the approved comment is present", () => {
    setBody(commentEditor({ value: COMMENT }));

    const probe = probeComment(COMMENT);

    expect(probe.code).toBe("already_filled");
    expect(probe.state).toBe("matching");
  });

  it("reports occupied when a different draft is present", () => {
    setBody(commentEditor({ value: "다른 초안" }));

    const probe = probeComment(COMMENT);

    expect(probe.code).toBe("occupied");
    expect(probe.state).toBe("occupied");
  });

  it("reports needs_open with the opener selector when the editor is closed", () => {
    setBody(commentOpener());

    const probe = probeComment(COMMENT);

    expect(probe.code).toBe("needs_open");
    expect(document.querySelectorAll(probe.openerSelector as string)).toHaveLength(1);
  });

  it("reports not_found without an editor or opener", () => {
    setBody("<div><p>본문만 있습니다.</p></div>");

    expect(probeComment(COMMENT).code).toBe("not_found");
  });

  it("reports ambiguous for two editors", () => {
    setBody(`${commentEditor()}${commentEditor()}`);

    const probe = probeComment(COMMENT);

    expect(probe.code).toBe("ambiguous");
    expect(probe.candidateCount).toBe(2);
  });

  it("reports ambiguous for two openers", () => {
    setBody(`${commentOpener()}${commentOpener()}`);

    expect(probeComment(COMMENT).code).toBe("ambiguous");
  });

  it("reports not_found when the editor has no submit control", () => {
    setBody(commentEditor({ withSubmit: false }));

    const probe = probeComment(COMMENT);

    expect(probe.code).toBe("not_found");
    expect(probe.editorSelector).not.toBeNull();
    expect(probe.submitSelector).toBeNull();
  });

  it("ignores a disabled submit control", () => {
    setBody(commentEditor({ disabledSubmit: true }));

    expect(probeComment(COMMENT).code).toBe("not_found");
  });

  it("finds the submit control in a sibling upload area", () => {
    setBody(`
      <div class="u_cbox_write_wrap">
        <div class="u_cbox_write_area"><textarea class="u_cbox_text"></textarea></div>
        <div class="u_cbox_upload"><a class="u_cbox_btn_upload" href="#">등록</a></div>
      </div>
    `);

    expect(probeComment(COMMENT).code).toBe("ready");
  });

  it("reports ambiguous when two submit controls share the scope", () => {
    setBody(`
      <div class="u_cbox_write_wrap">
        <div class="u_cbox_write_area"><textarea class="u_cbox_text"></textarea></div>
        <button class="u_cbox_btn_upload">등록</button>
        <button class="u_cbox_btn_upload">등록</button>
      </div>
    `);

    const probe = probeComment(COMMENT);

    expect(probe.code).toBe("ambiguous");
    expect(probe.submitSelector).toBeNull();
  });

  it("ignores a hidden editor", () => {
    setBody(`<div style="display: none">${commentEditor()}</div>`);

    expect(probeComment(COMMENT).code).toBe("not_found");
  });

  it("ignores a read-only editor", () => {
    setBody(`
      <div class="u_cbox_write_wrap">
        <div class="u_cbox_write_area"><textarea class="u_cbox_text" readonly></textarea></div>
        <button class="u_cbox_btn_upload">등록</button>
      </div>
    `);

    expect(probeComment(COMMENT).code).toBe("not_found");
  });

  it("supports a contenteditable editor", () => {
    setBody(`
      <div class="u_cbox_write_wrap">
        <div class="u_cbox_write_area">
          <div class="u_cbox_text" contenteditable="true"></div>
        </div>
        <button class="u_cbox_btn_upload">등록</button>
      </div>
    `);

    expect(probeComment(COMMENT).code).toBe("ready");
  });
});

describe("countMatchingComments", () => {
  it("counts only exact matches after trimming", () => {
    setBody(
      `${publishedComment(COMMENT)}${publishedComment(` ${COMMENT} `)}${publishedComment("다른 댓글")}`,
    );

    expect(countMatchingComments(COMMENT)).toBe(2);
  });

  it("returns zero when nothing matches", () => {
    setBody(publishedComment("다른 댓글"));

    expect(countMatchingComments(COMMENT)).toBe(0);
  });
});

describe("diagnoseCommentPage", () => {
  it("detects a captcha placeholder", () => {
    setBody('<div class="u_cbox_captcha"></div>');

    expect(diagnoseCommentPage().captcha).toBe(true);
  });

  it("detects a login requirement from markup", () => {
    setBody('<a href="https://nid.naver.com/nidlogin.login">로그인</a>');

    expect(diagnoseCommentPage().loginRequired).toBe(true);
  });

  it("detects a login requirement from text", () => {
    setBody("<p>로그인 후 이용할 수 있습니다.</p>");

    expect(diagnoseCommentPage().loginRequired).toBe(true);
  });

  it("detects a comment block notice", () => {
    setBody("<p>댓글을 작성할 수 없습니다.</p>");

    expect(diagnoseCommentPage().blocked).toBe(true);
  });

  it("reports a clean page", () => {
    setBody(commentEditor());

    expect(diagnoseCommentPage()).toEqual({ blocked: false, captcha: false, loginRequired: false });
  });
});

describe("captchaVisible", () => {
  it("ignores a zero-sized captcha placeholder", () => {
    setBody('<div class="u_cbox_captcha"></div>');

    expect(captchaVisible()).toBe(false);
  });

  it("ignores a hidden captcha", () => {
    setBody('<div class="u_cbox_captcha" style="display: none"></div>');

    expect(captchaVisible()).toBe(false);
  });
});

describe("commentStillPending", () => {
  it("reports true while the approved text remains in the editor", () => {
    setBody(commentEditor({ value: COMMENT }));

    expect(commentStillPending("textarea.u_cbox_text", COMMENT)).toBe(true);
  });

  it("reports false once the editor is cleared", () => {
    setBody(commentEditor());

    expect(commentStillPending("textarea.u_cbox_text", COMMENT)).toBe(false);
  });

  it("reports false when the editor is gone", () => {
    setBody("<div></div>");

    expect(commentStillPending("textarea.u_cbox_text", COMMENT)).toBe(false);
  });
});
