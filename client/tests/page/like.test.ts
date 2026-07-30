import { beforeEach, describe, expect, it } from "vitest";

import { probeLike, probeLikeOption } from "../../src/page/like";
import { likeControl, setBody } from "../fixtures/naver";

beforeEach(() => {
  setBody("");
});

describe("probeLike", () => {
  it("reports a ready control with a resolvable selector", () => {
    setBody(likeControl({ liked: false }));

    const probe = probeLike();

    expect(probe.code).toBe("ready");
    expect(probe.liked).toBe(false);
    expect(probe.candidateCount).toBe(1);
    expect(probe.selector).not.toBeNull();
    expect(document.querySelectorAll(probe.selector as string)).toHaveLength(1);
  });

  it("reports an already liked control", () => {
    setBody(likeControl({ liked: true }));

    expect(probeLike().code).toBe("already_liked");
  });

  it("reports state_unknown when no state attribute is present", () => {
    setBody(likeControl({ liked: null }));

    const probe = probeLike();

    expect(probe.code).toBe("state_unknown");
    expect(probe.liked).toBeNull();
  });

  it("reports not_found without any control", () => {
    setBody("<div><p>본문만 있습니다.</p></div>");

    const probe = probeLike();

    expect(probe.code).toBe("not_found");
    expect(probe.selector).toBeNull();
  });

  it("prefers the canonical control over duplicated fallbacks", () => {
    setBody(`${likeControl({ liked: false })}<button class="u_likeit_list_btn">공감</button>`);

    expect(probeLike().code).toBe("ready");
  });

  it("reports ambiguous when two canonical controls exist", () => {
    setBody(`${likeControl({ liked: false })}${likeControl({ liked: false })}`);

    const probe = probeLike();

    expect(probe.code).toBe("ambiguous");
    expect(probe.candidateCount).toBe(2);
    expect(probe.selector).toBeNull();
  });

  it("ignores hidden duplicates", () => {
    setBody(`
      ${likeControl({ liked: false })}
      <div style="display: none">${likeControl({ liked: false })}</div>
    `);

    expect(probeLike().code).toBe("ready");
  });

  it("ignores disabled controls", () => {
    setBody('<button class="u_likeit_list_btn" disabled>공감</button>');

    expect(probeLike().code).toBe("not_found");
  });

  it("ignores aria-disabled controls", () => {
    setBody('<button class="u_likeit_list_btn" aria-disabled="true">공감</button>');

    expect(probeLike().code).toBe("not_found");
  });

  it("reads a liked state from data attributes", () => {
    setBody('<button class="u_likeit_list_btn" data-state="on">공감</button>');

    expect(probeLike().code).toBe("already_liked");
  });

  it("reads an unliked state from data attributes", () => {
    setBody('<button class="u_likeit_list_btn" data-liked="false">공감</button>');

    expect(probeLike().code).toBe("ready");
  });

  it("reads a liked state from the on class", () => {
    setBody('<button class="u_likeit_list_btn on">공감</button>');

    expect(probeLike().code).toBe("already_liked");
  });

  it("reads an unliked state from the off class", () => {
    setBody('<button class="u_likeit_list_btn off">공감</button>');

    expect(probeLike().code).toBe("ready");
  });

  it("reads a liked state from a cancel label", () => {
    setBody('<button class="u_likeit_list_btn" aria-label="공감 취소">하트</button>');

    expect(probeLike().code).toBe("already_liked");
  });

  it("reports the default option selector when a reaction layer is present", () => {
    setBody(likeControl({ liked: false, withLayer: true }));

    const probe = probeLike();

    expect(probe.optionSelector).not.toBeNull();
    expect(document.querySelectorAll(probe.optionSelector as string)).toHaveLength(1);
  });

  it("omits the option selector when no layer exists", () => {
    setBody(likeControl({ liked: false }));

    expect(probeLike().optionSelector).toBeNull();
  });

  it("uses the primary control when the canonical wrapper is absent", () => {
    setBody(likeControl({ liked: false, canonical: false }));

    expect(probeLike().code).toBe("ready");
  });
});

describe("probeLikeOption", () => {
  it("returns the default option selector for a single control", () => {
    setBody(likeControl({ liked: false, withLayer: true }));

    expect(probeLikeOption()).not.toBeNull();
  });

  it("returns null when the control is ambiguous", () => {
    setBody(`${likeControl({ withLayer: true })}${likeControl({ withLayer: true })}`);

    expect(probeLikeOption()).toBeNull();
  });

  it("returns null when no control exists", () => {
    setBody("<div></div>");

    expect(probeLikeOption()).toBeNull();
  });
});
