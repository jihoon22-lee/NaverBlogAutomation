import { describe, expect, it, vi } from "vitest";

import { LocalApiClient } from "../../src/api/client";
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
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(service))
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
    expect(fetcher).toHaveBeenCalledTimes(5);
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
});
