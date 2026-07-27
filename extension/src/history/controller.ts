import { ApiClientError, LocalApiClient } from "../api/client";
import type { EngagementRun, RecommendationHistoryItem, ServiceStatus } from "../api/types";
import { IdempotencyRegistry } from "../idempotency/registry";
import type { HistoryView } from "./state";

export interface HistoryRegistry {
  removeRecommendation(recommendationId: string): Promise<void>;
}

export class HistoryController {
  readonly #api: LocalApiClient;
  readonly #registry: HistoryRegistry;
  readonly #view: HistoryView;
  #abort: AbortController | null = null;
  #busy = false;
  #items: readonly RecommendationHistoryItem[] = [];
  #engagementRuns: readonly EngagementRun[] = [];
  #service: ServiceStatus | null = null;

  constructor(
    view: HistoryView,
    api: LocalApiClient = new LocalApiClient(),
    registry: HistoryRegistry = new IdempotencyRegistry(),
  ) {
    this.#api = api;
    this.#registry = registry;
    this.#view = view;
    this.#view.bind({
      copy: (id) => void this.copy(id),
      clearPersonalization: () => void this.clearPersonalization(),
      delete: (id) => void this.delete(id),
      refresh: () => void this.refresh(),
      togglePersonalization: (id) => void this.togglePersonalization(id),
    });
  }

  start(): void {
    void this.refresh();
  }

  dispose(): void {
    this.#abort?.abort();
    this.#abort = null;
  }

  async refresh(notice?: string): Promise<void> {
    if (this.#busy) return;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    this.#view.render({ kind: "loading" });
    try {
      const [service, items, engagementRuns] = await Promise.all([
        this.#api.status(abort.signal),
        this.#api.listRecommendations(20, abort.signal),
        this.#api.listEngagementRuns(20, abort.signal),
      ]);
      if (abort.signal.aborted) return;
      this.#service = service;
      this.#items = items;
      this.#engagementRuns = engagementRuns;
      this.#view.render({
        engagementRuns,
        items,
        kind: "ready",
        ...(notice === undefined ? {} : { notice }),
        service,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      this.#view.render({
        kind: "error",
        message:
          error instanceof ApiClientError
            ? "로컬 서비스에 연결하지 못했습니다. API 실행 상태를 확인해 주세요."
            : "최근 작업을 불러오지 못했습니다.",
      });
    } finally {
      if (this.#abort === abort) this.#abort = null;
    }
  }

  async copy(id: string): Promise<void> {
    if (this.#busy || this.#service === null) return;
    const item = this.#items.find((candidate) => candidate.id === id);
    if (item?.comment === null || item?.comment === undefined) return;
    const copied = await this.#view.copyText(item.comment);
    this.#view.render({
      items: this.#items,
      engagementRuns: this.#engagementRuns,
      kind: "ready",
      notice: copied
        ? "이전 댓글을 clipboard에 복사했습니다."
        : "자동 복사가 차단되어 댓글을 선택했습니다. 직접 복사해 주세요.",
      service: this.#service,
    });
  }

  async delete(id: string): Promise<void> {
    if (this.#busy || this.#service === null || !this.#items.some((item) => item.id === id)) return;
    this.#busy = true;
    this.#view.render({
      busyId: id,
      engagementRuns: this.#engagementRuns,
      items: this.#items,
      kind: "ready",
      service: this.#service,
    });
    try {
      await this.#api.deleteRecommendation(id);
      let notice = "선택한 로컬 기록을 삭제했습니다.";
      try {
        await this.#registry.removeRecommendation(id);
      } catch {
        notice =
          "기록은 삭제했지만 browser retry metadata를 정리하지 못했습니다. 설정에서 registry를 정리해 주세요.";
      }
      this.#busy = false;
      await this.refresh(notice);
    } catch {
      this.#view.render({
        items: this.#items,
        engagementRuns: this.#engagementRuns,
        kind: "ready",
        notice: "기록을 삭제하지 못했습니다. 서비스 상태를 확인한 뒤 다시 시도해 주세요.",
        service: this.#service,
      });
    } finally {
      this.#busy = false;
    }
  }

  async togglePersonalization(id: string): Promise<void> {
    if (this.#busy || this.#service === null) return;
    const item = this.#items.find((candidate) => candidate.id === id);
    if (item === undefined || item.reviewStatus !== "completed" || item.comment === null) return;
    this.#busy = true;
    this.#view.render({
      busyId: id,
      engagementRuns: this.#engagementRuns,
      items: this.#items,
      kind: "ready",
      service: this.#service,
    });
    try {
      await this.#api.reviewRecommendation(id, {
        personalization_eligible: !item.personalizationEligible,
      });
      this.#busy = false;
      await this.refresh(
        item.personalizationEligible
          ? "선택한 완료 댓글을 스타일 예시에서 제외했습니다."
          : "선택한 완료 댓글을 스타일 예시에 다시 포함했습니다.",
      );
    } catch {
      this.#view.render({
        items: this.#items,
        engagementRuns: this.#engagementRuns,
        kind: "ready",
        notice: "스타일 예시 설정을 바꾸지 못했습니다. 서비스 상태를 확인해 주세요.",
        service: this.#service,
      });
    } finally {
      this.#busy = false;
    }
  }

  async clearPersonalization(): Promise<void> {
    if (this.#busy || this.#service === null) return;
    this.#busy = true;
    this.#view.render({
      clearingPersonalization: true,
      engagementRuns: this.#engagementRuns,
      items: this.#items,
      kind: "ready",
      service: this.#service,
    });
    try {
      await this.#api.clearPersonalizationExamples();
      this.#busy = false;
      await this.refresh("완료 댓글 기록은 보존하고 스타일 예시에서 모두 제외했습니다.");
    } catch {
      this.#view.render({
        items: this.#items,
        engagementRuns: this.#engagementRuns,
        kind: "ready",
        notice: "스타일 예시를 정리하지 못했습니다. 서비스 상태를 확인해 주세요.",
        service: this.#service,
      });
    } finally {
      this.#busy = false;
    }
  }
}
