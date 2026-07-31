import { beforeEach, describe, expect, it } from "vitest";

import {
  PAGE_BUNDLE_NAMESPACE,
  PAGE_BUNDLE_VERSION,
  createPageBundle,
  installPageBundle,
} from "../../src/page/index";
import { commentEditor, likeControl, modernPost, setBody } from "../fixtures/naver";

beforeEach(() => {
  setBody("");
});

describe("createPageBundle", () => {
  it("exposes every read-only probe", () => {
    const bundle = createPageBundle();

    expect(Object.keys(bundle).sort()).toEqual(
      [
        "captchaVisible",
        "captureArticle",
        "commentStillPending",
        "countMatchingComments",
        "diagnoseCommentPage",
        "probeCategoryPostList",
        "probeComment",
        "probeEditor",
        "probeEditorSave",
        "probeLike",
        "probeLikeOption",
        "probeMyBlogCategories",
        "probeNeighborApplication",
        "probeNeighborConfirmation",
        "probeNeighborOption",
        "probeNeighborRelationship",
        "readEditorText",
        "version",
      ].sort(),
    );
    expect(bundle.version).toBe(PAGE_BUNDLE_VERSION);
  });

  it("runs the probes it exposes against a synthetic document", () => {
    setBody(`${modernPost()}${likeControl()}${commentEditor()}`);
    const bundle = createPageBundle();

    expect(bundle.captureArticle()?.selectorKind).toBe("modern");
    expect(bundle.probeLike().code).toBe("ready");
    expect(bundle.probeComment("합성 댓글").code).toBe("ready");
    expect(bundle.probeNeighborRelationship().state).toBe("state_unknown");
    expect(bundle.captchaVisible()).toBe(false);
  });
});

describe("installPageBundle", () => {
  it("installs the bundle on the target global object", () => {
    const target: Record<string, unknown> = {};

    const bundle = installPageBundle(target);

    expect(target[PAGE_BUNDLE_NAMESPACE]).toBe(bundle);
  });

  it("reuses an already installed bundle of the same version", () => {
    const target: Record<string, unknown> = {};

    const first = installPageBundle(target);
    const second = installPageBundle(target);

    expect(second).toBe(first);
  });

  it("replaces a bundle from a different version", () => {
    const target: Record<string, unknown> = { [PAGE_BUNDLE_NAMESPACE]: { version: 0 } };

    const bundle = installPageBundle(target);

    expect(bundle.version).toBe(PAGE_BUNDLE_VERSION);
    expect(target[PAGE_BUNDLE_NAMESPACE]).toBe(bundle);
  });

  it("installs itself on the real global object when the bundle is imported", () => {
    const installed = (globalThis as Record<string, unknown>)[PAGE_BUNDLE_NAMESPACE];

    expect(installed).toBeDefined();
    expect((installed as { version: number }).version).toBe(PAGE_BUNDLE_VERSION);
  });
});
