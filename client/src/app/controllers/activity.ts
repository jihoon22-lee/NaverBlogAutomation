/** Recent local work: recommendations, batch sessions, and draft records. */

import { ApiError, LocalApiClient } from "../api/client";
import type { AutomationSession, PostDraft, RecommendationHistoryItem } from "../api/types";
import { renderActivity } from "../views/activity";

export interface ActivityState {
  drafts: PostDraft[];
  error: string | null;
  loading: boolean;
  notice: string | null;
  recommendations: RecommendationHistoryItem[];
  sessions: AutomationSession[];
}

type ActivityApi = Pick<
  LocalApiClient,
  | "clearPersonalizationExamples"
  | "deleteRecommendation"
  | "drafts"
  | "recommendations"
  | "reviewRecommendation"
  | "sessions"
>;

export interface ActivityControllerOptions {
  onOpenDraft?: (draftId: string) => void;
  onOpenRecommendation?: (recommendationId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}

export class ActivityController {
  readonly #api: ActivityApi;
  readonly #root: Element;
  readonly #onOpenDraft: (draftId: string) => void;
  readonly #onOpenRecommendation: (recommendationId: string) => void;
  readonly #onOpenSession: (sessionId: string) => void;
  #state: ActivityState = {
    drafts: [],
    error: null,
    loading: false,
    notice: null,
    recommendations: [],
    sessions: [],
  };

  constructor(
    root: Element,
    api: ActivityApi = new LocalApiClient(),
    options: ActivityControllerOptions = {},
  ) {
    this.#root = root;
    this.#api = api;
    this.#onOpenDraft = options.onOpenDraft ?? (() => undefined);
    this.#onOpenRecommendation = options.onOpenRecommendation ?? (() => undefined);
    this.#onOpenSession = options.onOpenSession ?? (() => undefined);
  }

  render(): void {
    renderActivity(this.#root, this.#state, {
      onClearExamples: () => void this.clearExamples(),
      onDeleteRecommendation: (id) => void this.deleteRecommendation(id),
      onOpenDraft: this.#onOpenDraft,
      onOpenRecommendation: this.#onOpenRecommendation,
      onOpenSession: this.#onOpenSession,
      onRefresh: () => void this.load(),
      onTogglePersonalization: (item) => void this.togglePersonalization(item),
    });
  }

  async load(): Promise<void> {
    if (this.#state.loading) return;
    this.#update({ ...this.#state, error: null, loading: true, notice: null });
    try {
      const [recommendations, sessions, drafts] = await Promise.all([
        this.#api.recommendations(),
        this.#api.sessions(20),
        this.#api.drafts(20),
      ]);
      this.#update({
        drafts,
        error: null,
        loading: false,
        notice: null,
        recommendations,
        sessions,
      });
    } catch (error) {
      this.#update({ ...this.#state, error: describe(error), loading: false });
    }
  }

  async deleteRecommendation(id: string): Promise<void> {
    try {
      await this.#api.deleteRecommendation(id);
      this.#update({
        ...this.#state,
        notice: "추천 댓글을 삭제했습니다.",
        recommendations: this.#state.recommendations.filter((item) => item.id !== id),
      });
    } catch (error) {
      this.#update({ ...this.#state, error: describe(error) });
    }
  }

  async togglePersonalization(item: RecommendationHistoryItem): Promise<void> {
    try {
      await this.#api.reviewRecommendation(item.id, {
        personalizationEligible: !item.personalizationEligible,
      });
      this.#update({
        ...this.#state,
        notice: "개인화 예시 포함 여부를 저장했습니다.",
        recommendations: this.#state.recommendations.map((current) =>
          current.id === item.id
            ? { ...current, personalizationEligible: !current.personalizationEligible }
            : current,
        ),
      });
    } catch (error) {
      this.#update({ ...this.#state, error: describe(error) });
    }
  }

  async clearExamples(): Promise<void> {
    try {
      await this.#api.clearPersonalizationExamples();
      this.#update({ ...this.#state, notice: "개인화 예시를 모두 지웠습니다." });
    } catch (error) {
      this.#update({ ...this.#state, error: describe(error) });
    }
  }

  #update(state: ActivityState): void {
    this.#state = state;
    this.render();
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.problem?.detail ?? error.message;
  return "최근 작업을 불러오지 못했습니다.";
}
