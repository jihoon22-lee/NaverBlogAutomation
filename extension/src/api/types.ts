export type CandidateTone = "curious" | "supportive" | "warm";
export type ReviewStatus = "approved" | "completed" | "drafted";
export type RelationshipLevel = "close" | "friendly" | "new" | "polite";
export type SpeechStyle = "banmal" | "honorific";
export type CommentLength = "long" | "medium" | "short";
export type CommentMood = "calm" | "lively" | "warm";
export type PersonalizationMode = "completed_examples" | "off";
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
  personalizationApplied: boolean;
  personalizationMode: PersonalizationMode;
  personalizationSampleCount: number;
  personalizationEligible: boolean;
}

export interface CreateRecommendationRequest {
  body: string;
  comment_length?: CommentLength;
  comment_mood?: CommentMood;
  relationship_level?: RelationshipLevel;
  source_url: string;
  speech_style?: SpeechStyle;
  personalization_mode?: PersonalizationMode;
  title: string;
}

export interface ReviewRecommendationRequest {
  edited_comment?: string | null;
  review_status?: ReviewStatus;
  selected_candidate_id?: string | null;
  personalization_eligible?: boolean;
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

export interface ServiceStatus {
  apiVersion: string;
  appEnvironment: "development" | "production" | "test";
  database: "ready";
  generatorMode: "fake" | "openai";
  generatorModel: string;
  status: "ready";
}

export interface RecommendationHistoryItem {
  comment: string | null;
  createdAt: string;
  id: string;
  reviewStatus: ReviewStatus;
  sourceUrl: string;
  title: string;
  updatedAt: string | null;
  personalizationEligible: boolean;
}

export type DiscoverySource = "neighbor" | "search";
export type DiscoveryState = "queued" | "opened" | "completed" | "skipped" | "unavailable";

export interface DiscoveryNeighbor {
  id: string;
  name: string;
  blogUrl: string;
  blogId: string;
  enabled: boolean;
  feedStatus: "ready" | "unavailable" | "unknown";
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface DiscoverySearch {
  id: string;
  query: string;
  excludedTerms: readonly string[];
  freshnessDays: number;
  enabled: boolean;
  createdAt: string;
}

export interface DiscoveryPost {
  id: string;
  source: DiscoverySource;
  state: DiscoveryState;
  sourceUrl: string;
  title: string;
  publisherName: string | null;
  publisherBlogId: string | null;
  publishedAt: string | null;
  neighborId: string | null;
  searchId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DigestSettings {
  timezone: string;
  hour: number;
  minute: number;
  emailEnabled: boolean;
  smtpConfigured: boolean;
}

export type AutomaticDiscoveryStatus = "failed" | "never" | "partial" | "success";

export interface AutomaticDiscoverySettings {
  ownBlogId: string;
  enabled: boolean;
  timezone: string;
  hour: number;
  minute: number;
  lastSyncedAt: string | null;
  lastStatus: AutomaticDiscoveryStatus;
  lastDetail: string;
}

export interface AutomaticDiscoverySyncResult {
  neighborsAdded: number;
  neighborPostsAdded: number;
  searchPostsAdded: number;
  searchProvider: "naver_open_api" | "none";
  status: Exclude<AutomaticDiscoveryStatus, "never">;
  detail: string;
}

export interface DiscoverySearchRefreshResult {
  importedCount: number;
  provider: "naver_open_api";
  detail: string;
}
