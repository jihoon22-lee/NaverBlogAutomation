import { describe, expect, it, vi } from "vitest";

import { LocalApiClient } from "../../src/api/client";
import type { RecommendationHistoryItem, ServiceStatus } from "../../src/api/types";
import { HistoryController } from "../../src/history/controller";
import type { HistoryActions, HistoryState, HistoryView } from "../../src/history/state";

const id = "00000000-0000-4000-8000-000000000010";
const service = {
  api_version: "1.0.0",
  app_environment: "production",
  database: "ready",
  generator_mode: "openai",
  generator_model: "gpt-test",
  status: "ready",
};
const item = {
  comment: "이전에 승인한 댓글",
  created_at: "2026-07-17T00:00:00Z",
  id,
  personalization_eligible: true,
  review_status: "approved",
  source_url: "https://blog.naver.com/synthetic/10",
  title: "합성 전시 후기",
  updated_at: "2026-07-17T00:01:00Z",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

class FakeHistoryView implements HistoryView {
  actions: HistoryActions | null = null;
  copyText = vi.fn(async () => true);
  states: HistoryState[] = [];

  bind(actions: HistoryActions): void {
    this.actions = actions;
  }

  render(state: HistoryState): void {
    this.states.push(state);
  }
}

describe("HistoryController", () => {
  it("loads status and history, copies a comment, and refreshes after delete", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(json({ items: [item] }))
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(json({ items: [] }));
    const view = new FakeHistoryView();
    const removeRecommendation = vi.fn(async () => undefined);
    const controller = new HistoryController(view, new LocalApiClient(fetcher), {
      removeRecommendation,
    });

    controller.start();
    await vi.waitFor(() => expect(view.states.at(-1)).toMatchObject({ kind: "ready" }));
    view.actions?.copy(id);
    await vi.waitFor(() => expect(view.copyText).toHaveBeenCalledWith(item.comment));
    expect(view.states.at(-1)).toMatchObject({ notice: expect.stringContaining("복사") });

    view.actions?.delete(id);
    await vi.waitFor(() =>
      expect(view.states.at(-1)).toMatchObject({
        items: [],
        notice: expect.stringContaining("삭제"),
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(removeRecommendation).toHaveBeenCalledWith(id);
    controller.dispose();
  });

  it("shows a safe connection message when the local service is unavailable", async () => {
    const view = new FakeHistoryView();
    const controller = new HistoryController(
      view,
      new LocalApiClient(vi.fn<typeof fetch>().mockRejectedValue(new Error("private detail"))),
      { removeRecommendation: vi.fn(async () => undefined) },
    );

    await controller.refresh();

    expect(view.states.at(-1)).toEqual({
      kind: "error",
      message: "로컬 서비스에 연결하지 못했습니다. API 실행 상태를 확인해 주세요.",
    });
  });

  it("updates completed-comment personalization without deleting its history", async () => {
    const view = new FakeHistoryView();
    const completed: RecommendationHistoryItem = {
      comment: "완료한 댓글",
      createdAt: item.created_at,
      id,
      personalizationEligible: true,
      reviewStatus: "completed",
      sourceUrl: item.source_url,
      title: item.title,
      updatedAt: item.updated_at,
    };
    const status = vi.fn<(signal?: AbortSignal) => Promise<ServiceStatus>>(async () => ({
      apiVersion: "1.0.0",
      appEnvironment: "test",
      database: "ready",
      generatorMode: "fake",
      generatorModel: "deterministic-fake",
      status: "ready",
    }));
    const list = vi.fn<
      (limit?: number, signal?: AbortSignal) => Promise<readonly RecommendationHistoryItem[]>
    >(async () => [completed]);
    const review = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    const api = {
      clearPersonalizationExamples: clear,
      listEngagementRuns: vi.fn(async () => []),
      listRecommendations: list,
      reviewRecommendation: review,
      status,
    } as unknown as LocalApiClient;
    const controller = new HistoryController(view, api, {
      removeRecommendation: vi.fn(async () => undefined),
    });

    await controller.refresh();
    view.actions?.togglePersonalization(id);
    await vi.waitFor(() =>
      expect(review).toHaveBeenCalledWith(id, { personalization_eligible: false }),
    );
    await vi.waitFor(() =>
      expect(view.states.at(-1)).toMatchObject({
        kind: "ready",
        notice: expect.stringContaining("제외"),
      }),
    );

    view.actions?.clearPersonalization();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(view.states.at(-1)).toMatchObject({
        kind: "ready",
        notice: expect.stringContaining("모두 제외"),
      }),
    );
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("keeps history visible when a personalization update cannot be saved", async () => {
    const view = new FakeHistoryView();
    const completed: RecommendationHistoryItem = {
      comment: "완료한 댓글",
      createdAt: item.created_at,
      id,
      personalizationEligible: false,
      reviewStatus: "completed",
      sourceUrl: item.source_url,
      title: item.title,
      updatedAt: item.updated_at,
    };
    const api = {
      clearPersonalizationExamples: vi.fn(async () => {
        throw new Error("synthetic clear failure");
      }),
      listEngagementRuns: vi.fn(async () => []),
      listRecommendations: vi.fn(async () => [completed]),
      reviewRecommendation: vi.fn(async () => {
        throw new Error("synthetic update failure");
      }),
      status: vi.fn(async () => ({
        apiVersion: "1.0.0",
        appEnvironment: "test" as const,
        database: "ready" as const,
        generatorMode: "fake" as const,
        generatorModel: "deterministic-fake",
        status: "ready" as const,
      })),
    } as unknown as LocalApiClient;
    const controller = new HistoryController(view, api, {
      removeRecommendation: vi.fn(async () => undefined),
    });

    await controller.refresh();
    view.actions?.togglePersonalization(id);

    await vi.waitFor(() =>
      expect(view.states.at(-1)).toMatchObject({
        items: [completed],
        kind: "ready",
        notice: expect.stringContaining("바꾸지 못했습니다"),
      }),
    );

    view.actions?.clearPersonalization();
    await vi.waitFor(() =>
      expect(view.states.at(-1)).toMatchObject({
        items: [completed],
        kind: "ready",
        notice: expect.stringContaining("정리하지 못했습니다"),
      }),
    );
  });
});
