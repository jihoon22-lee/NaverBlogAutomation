import { beforeEach, describe, expect, it } from "vitest";

import {
  probeNeighborApplication,
  probeNeighborConfirmation,
  probeNeighborOption,
  probeNeighborRelationship,
} from "../../src/page/mutual-neighbor";
import {
  neighborApplicationForm,
  neighborEntry,
  neighborOptionForm,
  setBody,
} from "../fixtures/naver";

const MESSAGE = "합성 서로이웃 신청 메시지입니다.";

beforeEach(() => {
  setBody("");
});

describe("probeNeighborRelationship", () => {
  it("reports can_request with a resolvable entry selector", () => {
    setBody(neighborEntry("서로이웃추가"));

    const probe = probeNeighborRelationship();

    expect(probe.state).toBe("can_request");
    expect(document.querySelectorAll(probe.entrySelector as string)).toHaveLength(1);
    expect(probe.matchedKinds).toContain("buddy_add_href");
  });

  it("reports already_mutual", () => {
    setBody(neighborEntry("서로이웃"));

    expect(probeNeighborRelationship().state).toBe("already_mutual");
  });

  it("reports already_neighbor", () => {
    setBody(neighborEntry("이웃"));

    expect(probeNeighborRelationship().state).toBe("already_neighbor");
  });

  it("reports request_pending", () => {
    setBody(neighborEntry("신청중"));

    expect(probeNeighborRelationship().state).toBe("request_pending");
  });

  it("reports request_unavailable", () => {
    setBody(neighborEntry("신청불가"));

    expect(probeNeighborRelationship().state).toBe("request_unavailable");
  });

  it("reports state_unknown for an unrecognized label", () => {
    setBody(neighborEntry("팬하기"));

    expect(probeNeighborRelationship().state).toBe("state_unknown");
  });

  it("reports state_unknown without any entry control", () => {
    setBody("<div><p>본문</p></div>");

    const probe = probeNeighborRelationship();

    expect(probe.state).toBe("state_unknown");
    expect(probe.candidateCount).toBe(0);
    expect(probe.entrySelector).toBeNull();
  });

  it("reports state_unknown when several entry controls exist", () => {
    setBody(`${neighborEntry()}${neighborEntry()}`);

    const probe = probeNeighborRelationship();

    expect(probe.candidateCount).toBe(2);
    expect(probe.entrySelector).toBeNull();
  });
});

describe("probeNeighborOption", () => {
  it("reports a ready mutual option and the next control", () => {
    setBody(neighborOptionForm());

    const probe = probeNeighborOption();

    expect(probe.code).toBe("ready");
    expect(probe.mutualSelected).toBe(false);
    expect(document.querySelectorAll(probe.optionSelector as string)).toHaveLength(1);
    expect(document.querySelectorAll(probe.nextSelector as string)).toHaveLength(1);
  });

  it("reports already_selected when the option is checked", () => {
    setBody(neighborOptionForm({ checked: true }));

    const probe = probeNeighborOption();

    expect(probe.code).toBe("already_selected");
    expect(probe.mutualSelected).toBe(true);
  });

  it("reports not_found without the next control", () => {
    setBody(neighborOptionForm({ withNext: false }));

    expect(probeNeighborOption().code).toBe("not_found");
  });

  it("reports not_found when only a plain neighbor option exists", () => {
    setBody(`
      <form id="buddyAddForm">
        <input type="radio" id="each_buddy" name="relation" value="each" />
        <button type="button">다음</button>
      </form>
    `);

    expect(probeNeighborOption().code).toBe("not_found");
  });

  it("reports ambiguous for two popup forms", () => {
    setBody(`${neighborOptionForm()}${neighborOptionForm()}`);

    expect(probeNeighborOption().code).toBe("ambiguous");
  });

  it("targets the visible label when the radio itself is hidden", () => {
    setBody(`
      <form id="buddyAddForm">
        <input type="radio" id="both_buddy" value="both" style="display: none" />
        <label for="both_buddy">서로이웃</label>
        <button type="button">다음</button>
      </form>
    `);

    const probe = probeNeighborOption();

    expect(probe.code).toBe("ready");
    expect(probe.optionSelector).toContain("label");
  });

  it("reports captcha_required when a captcha is rendered instead of the form", () => {
    setBody('<div class="captcha"></div>');

    expect(probeNeighborOption().code).toBe("captcha_required");
  });

  it("reports login_required when a login form replaces the popup", () => {
    setBody('<form action="https://nid.naver.com/nidlogin.login"></form>');

    expect(probeNeighborOption().code).toBe("login_required");
  });
});

describe("probeNeighborApplication", () => {
  it("reports a ready message field and next control", () => {
    setBody(neighborApplicationForm());

    const probe = probeNeighborApplication(MESSAGE);

    expect(probe.code).toBe("ready");
    expect(document.querySelectorAll(probe.messageSelector as string)).toHaveLength(1);
    expect(document.querySelectorAll(probe.nextSelector as string)).toHaveLength(1);
    expect(probe.groupKind).toBe("none");
  });

  it("accepts a message field that already holds the approved text", () => {
    setBody(neighborApplicationForm({ message: MESSAGE }));

    expect(probeNeighborApplication(MESSAGE).code).toBe("ready");
  });

  it("reports message_occupied for a different draft", () => {
    setBody(neighborApplicationForm({ message: "다른 메시지" }));

    expect(probeNeighborApplication(MESSAGE).code).toBe("message_occupied");
  });

  it("reports the first selectable group for a select control", () => {
    setBody(neighborApplicationForm({ group: "select" }));

    const probe = probeNeighborApplication(MESSAGE);

    expect(probe.groupKind).toBe("select");
    expect(probe.groupNeedsSelection).toBe(true);
    expect(probe.groupOptionValue).toBe("1");
  });

  it("keeps an already selected group", () => {
    setBody(`
      <form name="buddyApplyFrm">
        <select name="groupId"><option value="1" selected>기본 그룹</option></select>
        <textarea id="message"></textarea>
        <button type="button">다음</button>
      </form>
    `);

    const probe = probeNeighborApplication(MESSAGE);

    expect(probe.groupNeedsSelection).toBe(false);
    expect(probe.groupOptionValue).toBe("1");
  });

  it("reports a radio group that needs selection", () => {
    setBody(neighborApplicationForm({ group: "radio" }));

    const probe = probeNeighborApplication(MESSAGE);

    expect(probe.groupKind).toBe("radio");
    expect(probe.groupNeedsSelection).toBe(true);
  });

  it("reports not_found without the next control", () => {
    setBody(neighborApplicationForm({ withNext: false }));

    expect(probeNeighborApplication(MESSAGE).code).toBe("not_found");
  });

  it("reports ambiguous for two application forms", () => {
    setBody(`${neighborApplicationForm()}${neighborApplicationForm()}`);

    expect(probeNeighborApplication(MESSAGE).code).toBe("ambiguous");
  });

  it("reports ambiguous for two message fields", () => {
    setBody(`
      <form name="buddyApplyFrm">
        <textarea id="message"></textarea>
        <textarea name="buddyMessage"></textarea>
        <button type="button">다음</button>
      </form>
    `);

    expect(probeNeighborApplication(MESSAGE).code).toBe("ambiguous");
  });

  it("reports captcha_required when the form is replaced by a captcha", () => {
    setBody('<div id="captcha"></div>');

    expect(probeNeighborApplication(MESSAGE).code).toBe("captcha_required");
  });
});

describe("probeNeighborConfirmation", () => {
  it("confirms a completed request and finds the close control", () => {
    setBody('<p>서로이웃을 신청하였습니다.</p><button type="button">닫기</button>');

    const probe = probeNeighborConfirmation();

    expect(probe.confirmed).toBe(true);
    expect(document.querySelectorAll(probe.closeSelector as string)).toHaveLength(1);
    expect(probe.diagnosis).toBeNull();
  });

  it("recognizes a class-based close control", () => {
    setBody('<p>서로이웃 신청이 완료되었습니다.</p><a class="btn_close" href="#"></a>');

    expect(probeNeighborConfirmation().closeSelector).not.toBeNull();
  });

  it("does not confirm without a completion notice", () => {
    setBody("<p>신청 화면</p>");

    const probe = probeNeighborConfirmation();

    expect(probe.confirmed).toBe(false);
    expect(probe.closeSelector).toBeNull();
  });

  it("reports a captcha diagnosis", () => {
    setBody('<div class="captcha"></div>');

    expect(probeNeighborConfirmation().diagnosis).toBe("captcha_required");
  });

  it("reports a login diagnosis", () => {
    setBody('<a href="https://nid.naver.com/nidlogin.login">로그인</a>');

    expect(probeNeighborConfirmation().diagnosis).toBe("login_required");
  });

  it("omits the close selector when several close controls exist", () => {
    setBody("<p>서로이웃을 신청하였습니다.</p><button>닫기</button><button>닫기</button>");

    expect(probeNeighborConfirmation().closeSelector).toBeNull();
  });
});
