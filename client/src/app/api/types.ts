/** Transport types mirrored from the checked-in OpenAPI contract. */

export type DiscoverySource = "neighbor" | "search";

export type DiscoveryState = "queued" | "opened" | "completed" | "skipped" | "unavailable";

export type BrowserSessionState = "stopped" | "launching" | "ready" | "closing";

export type BrowserLoginState = "unknown" | "anonymous" | "authenticated";

export type ArticleSelectorKind = "modern" | "legacy" | "semantic";

export interface ServiceStatus {
  status: "ready";
  apiVersion: string;
  appEnvironment: "production" | "development" | "test";
  database: "ready";
  generatorMode: "openai" | "fake";
  generatorModel: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface BrowserSession {
  state: BrowserSessionState;
  login: BrowserLoginState;
  driver: string;
  headless: boolean;
  profileDir: string;
  openPages: number;
  detail: string | null;
}

export interface ArticleExtraction {
  sourceUrl: string;
  title: string;
  selectorKind: ArticleSelectorKind;
  originalLength: number;
  transmittedLength: number;
  truncated: boolean;
  preview: string;
}

export interface ProblemDetails {
  code: string;
  detail: string;
  status: number;
  title: string;
}

export type CandidateTone = "warm" | "curious" | "supportive";

export type ReviewStatus = "drafted" | "approved" | "completed";

export type RelationshipLevel = "new" | "polite" | "friendly" | "close";

export type SpeechStyle = "honorific" | "banmal";

export type CommentLength = "short" | "medium" | "long";

export type CommentMood = "calm" | "warm" | "lively";

export type PersonalizationMode = "off" | "completed_examples";

export type QualityWarning =
  | "length_target_missed"
  | "candidate_roles_blurred"
  | "candidates_too_similar";

export interface CommentCandidate {
  id: string;
  tone: CandidateTone;
  comment: string;
  referencedDetail: string;
}

export interface Recommendation {
  id: string;
  sourceUrl: string;
  title: string;
  summary: string;
  topics: string[];
  candidates: CommentCandidate[];
  selectedCandidateId: string | null;
  editedComment: string | null;
  reviewStatus: ReviewStatus;
  relationshipLevel: RelationshipLevel;
  speechStyle: SpeechStyle;
  commentLength: CommentLength;
  commentMood: CommentMood;
  qualityWarnings: QualityWarning[];
  version: number;
}

export interface GenerationOptions {
  relationshipLevel?: RelationshipLevel;
  speechStyle?: SpeechStyle;
  commentLength?: CommentLength;
  commentMood?: CommentMood;
  personalizationMode?: PersonalizationMode;
  replace?: boolean;
}

export interface CommentGeneration {
  attempt: number;
  extraction: ArticleExtraction;
  recommendation: Recommendation;
  replayed: boolean;
}

export interface AppSettingRecord {
  kind: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  updatedAt: string | null;
}

export type EngagementStepName = "like" | "comment" | "mutual_neighbor";

export type EngagementStepState =
  | "pending"
  | "running"
  | "succeeded"
  | "skipped"
  | "failed"
  | "unconfirmed";

export type EngagementRunState = "running" | "succeeded" | "failed" | "unconfirmed";

export interface EngagementStep {
  name: EngagementStepName;
  position: number;
  state: EngagementStepState;
  resultCode: string | null;
  updatedAt: string;
}

export interface EngagementRun {
  id: string;
  approvalId: string;
  discoveryPostId: string;
  recommendationId: string;
  source: DiscoverySource;
  state: EngagementRunState;
  steps: EngagementStep[];
  createdAt: string;
  updatedAt: string;
}

/** One decoded server-sent event from a run's progress stream. */
export interface RunStreamEvent {
  event: string;
  payload: Record<string, unknown>;
}

export type DraftStatus =
  | "collecting"
  | "composed"
  | "refining"
  | "tagged"
  | "staging"
  | "staged"
  | "abandoned";

export type RevisionKind = "seed" | "composed" | "refined" | "user_edited";

export type BlockKind = "heading" | "paragraph" | "quote" | "image";

export type LlmProviderName = "openai" | "gemini" | "anthropic";

export interface BodyBlock {
  type: BlockKind;
  text?: string;
  image_id?: string;
  caption?: string;
}

export interface DraftImage {
  id: string;
  ordinal: number;
  originalFilename: string;
  byteSize: number;
  mime: string;
  altText: string;
}

export interface DraftRevision {
  id: string;
  roundNo: number;
  kind: RevisionKind;
  provider: string | null;
  model: string | null;
  title: string;
  summary: string;
  isActive: boolean;
  blocks: BodyBlock[];
  createdAt: string | null;
}

export interface DraftTag {
  tag: string;
  ordinal: number;
  source: "generated" | "user";
  selected: boolean;
}

export interface PostDraft {
  id: string;
  title: string;
  categoryNo: number | null;
  status: DraftStatus;
  useImageVision: boolean;
  seedText: string;
  revisions: DraftRevision[];
  images: DraftImage[];
  tags: DraftTag[];
  createdAt: string | null;
  updatedAt: string | null;
}

export type PublishStepName = "title" | "body" | "images" | "tags" | "save";

export interface PublishStep {
  name: PublishStepName;
  position: number;
  state: EngagementStepState;
  resultCode: string | null;
  updatedAt: string | null;
}

export interface PublishRun {
  id: string;
  draftId: string;
  revisionId: string;
  state: EngagementRunState;
  resultCode: string | null;
  steps: PublishStep[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BlogCategory {
  categoryNo: number;
  name: string;
  postCount: number | null;
  syncedAt: string | null;
}

export interface LlmProviderStatus {
  provider: LlmProviderName;
  configured: boolean;
  model: string;
}
