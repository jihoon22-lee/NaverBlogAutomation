import { beforeEach, describe, expect, it, vi } from "vitest";

import { ActivityController } from "../../src/app/controllers/activity";

const RECOMMENDATION = {
  id: "11111111-1111-4111-8111-111111111111",
  sourceUrl: "https://blog.naver.com/example/1",
  title: "합성 댓글 작업",
  reviewStatus: "approved" as const,
  comment: "승인한 댓글입니다.",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: null,
  personalizationEligible: true,
};

const DRAFT = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "합성 초안",
  status: "composed" as const,
  updatedAt: null,
};

const SESSION = {
  id: "33333333-3333-4333-8333-333333333333",
  state: "completed" as const,
  createdAt: "2026-08-01T00:00:00Z",
};

function api() {
  return {
    clearPersonalizationExamples: vi.fn(async () => undefined),
    deleteRecommendation: vi.fn(async () => undefined),
    drafts: vi.fn(async () => []),
    recommendations: vi.fn(async () => [RECOMMENDATION]),
    reviewRecommendation: vi.fn(async () => undefined),
    sessions: vi.fn(async () => []),
  };
}

describe("recent activity", () => {
  beforeEach(() => {
    document.body.innerHTML = "<main id=workspace></main>";
  });

  it("loads recommendations, sessions, and drafts into one recent-work screen", async () => {
    const root = document.getElementById("workspace") as Element;
    const controller = new ActivityController(root, api() as never);

    await controller.load();

    expect(root.textContent).toContain("합성 댓글 작업");
    expect(root.textContent).toContain("여러 글 처리 이력");
    expect(root.textContent).toContain("글 작성 이력");
  });

  it("deletes a recommendation, changes personalization eligibility, and clears examples", async () => {
    const root = document.getElementById("workspace") as Element;
    const client = api();
    const controller = new ActivityController(root, client as never);
    await controller.load();

    (root.querySelector(`#personalization-${RECOMMENDATION.id}`) as HTMLButtonElement).click();
    await Promise.resolve();
    expect(client.reviewRecommendation).toHaveBeenCalledWith(RECOMMENDATION.id, {
      personalizationEligible: false,
    });

    (root.querySelector("#clear-personalization-button") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(client.clearPersonalizationExamples).toHaveBeenCalledTimes(1);

    (
      root.querySelector(`#delete-recommendation-${RECOMMENDATION.id}`) as HTMLButtonElement
    ).click();
    await Promise.resolve();
    expect(client.deleteRecommendation).toHaveBeenCalledWith(RECOMMENDATION.id);
    expect(root.textContent).toContain("아직 저장된 댓글 작업이 없습니다");
  });

  it("opens the stored records through the owning workspace callbacks", async () => {
    const root = document.getElementById("workspace") as Element;
    const client = api();
    client.drafts.mockResolvedValue([DRAFT] as never);
    client.sessions.mockResolvedValue([SESSION] as never);
    const onOpenDraft = vi.fn();
    const onOpenRecommendation = vi.fn();
    const onOpenSession = vi.fn();
    const controller = new ActivityController(root, client as never, {
      onOpenDraft,
      onOpenRecommendation,
      onOpenSession,
    });
    await controller.load();

    (root.querySelector(`#open-recommendation-${RECOMMENDATION.id}`) as HTMLButtonElement).click();
    (root.querySelector(`#open-draft-${DRAFT.id}`) as HTMLButtonElement).click();
    (root.querySelector(`#open-session-${SESSION.id}`) as HTMLButtonElement).click();

    expect(onOpenRecommendation).toHaveBeenCalledWith(RECOMMENDATION.id);
    expect(onOpenDraft).toHaveBeenCalledWith(DRAFT.id);
    expect(onOpenSession).toHaveBeenCalledWith(SESSION.id);
  });

  it("filters compact summary cards without reloading the activity records", async () => {
    const root = document.getElementById("workspace") as Element;
    const client = api();
    client.drafts.mockResolvedValue([DRAFT] as never);
    client.sessions.mockResolvedValue([SESSION] as never);
    const controller = new ActivityController(root, client as never);
    await controller.load();

    (root.querySelector("#activity-filter-draft") as HTMLButtonElement).click();

    expect(root.querySelectorAll(".activity-card")).toHaveLength(1);
    expect(root.textContent).toContain("합성 초안");
    expect(root.textContent).not.toContain("합성 댓글 작업");
    expect(root.textContent).not.toContain("여러 글 처리 이력");
    expect(client.recommendations).toHaveBeenCalledTimes(1);
  });
});
