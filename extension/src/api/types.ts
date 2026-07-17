export type CandidateTone = "curious" | "supportive" | "warm";
export type ReviewStatus = "approved" | "completed" | "drafted";

export interface CommentCandidate {
  comment: string;
  id: string;
  referencedDetail: string;
  tone: CandidateTone;
}

export interface Recommendation {
  candidates: readonly CommentCandidate[];
  createdAt: string;
  editedComment: string | null;
  id: string;
  reviewStatus: ReviewStatus;
  selectedCandidateId: string | null;
  sourceUrl: string;
  summary: string;
  title: string;
  topics: readonly string[];
  updatedAt: string | null;
}

export interface CreateRecommendationRequest {
  body: string;
  source_url: string;
  title: string;
}

export interface ReviewRecommendationRequest {
  edited_comment?: string | null;
  review_status?: ReviewStatus;
  selected_candidate_id?: string | null;
}

export interface ProblemDetails {
  code: string;
  detail: string;
  requestId: string;
  status: number;
  title: string;
  type: string;
}

export interface ApiResult<T> {
  replayed: boolean;
  value: T;
}
