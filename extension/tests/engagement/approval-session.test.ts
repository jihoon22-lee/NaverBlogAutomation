import { describe, expect, it } from "vitest";

import { EngagementApprovalSession } from "../../src/engagement/approval-session";

const details = {
  comment: "승인 댓글",
  sourceUrl: "https://blog.naver.com/synthetic/7",
  steps: ["like", "comment"] as const,
  title: "합성 글",
};

describe("EngagementApprovalSession", () => {
  it("issues one immutable in-memory token and consumes it once", () => {
    const session = new EngagementApprovalSession(() => "approval-1");
    const token = session.issue(details);

    expect(token).toEqual({ details, id: "approval-1" });
    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.isFrozen(token.details.steps)).toBe(true);
    expect(session.consume(token.id)).toBe(token);
    expect(session.consume(token.id)).toBeNull();
  });

  it("revokes every unused token on navigation or panel shutdown", () => {
    const session = new EngagementApprovalSession(() => "approval-2");
    const token = session.issue(details);

    session.revokeAll();

    expect(session.consume(token.id)).toBeNull();
  });
});
