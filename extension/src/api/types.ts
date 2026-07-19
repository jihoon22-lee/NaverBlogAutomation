export type CandidateTone = "curious" | "supportive" | "warm";
export type ReviewStatus = "approved" | "completed" | "drafted";
export type RelationshipLevel = "close" | "friendly" | "new" | "polite";
export type SpeechStyle = "banmal" | "honorific";
export type CommentLength = "long" | "medium" | "short";
export type CommentMood = "calm" | "lively" | "warm";
export type QualityWarning =
  | "candidate_roles_blurred"
  | "candidates_too_similar"
  | "length_target_missed";

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
  relationshipLevel: RelationshipLevel;
  speechStyle: SpeechStyle;
  commentLength: CommentLength;
  commentMood: CommentMood;
  qualityWarnings: readonly QualityWarning[];
}

export interface CreateRecommendationRequest {
  body: string;
  comment_length?: CommentLength;
  comment_mood?: CommentMood;
  relationship_level?: RelationshipLevel;
  source_url: string;
  speech_style?: SpeechStyle;
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
