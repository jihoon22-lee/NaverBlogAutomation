import type {
  CommentLength,
  CommentMood,
  CreateRecommendationRequest,
  RelationshipLevel,
  SpeechStyle,
} from "../api/types";

export interface GenerationPreferences {
  readonly commentLength: CommentLength;
  readonly commentMood: CommentMood;
  readonly relationshipLevel: RelationshipLevel;
  readonly speechStyle: SpeechStyle;
}

export const DEFAULT_GENERATION_PREFERENCES: GenerationPreferences = Object.freeze({
  commentLength: "medium",
  commentMood: "warm",
  relationshipLevel: "friendly",
  speechStyle: "honorific",
});

const COMMENT_LENGTHS = new Set<CommentLength>(["long", "medium", "short"]);
const COMMENT_MOODS = new Set<CommentMood>(["calm", "lively", "warm"]);
const RELATIONSHIP_LEVELS = new Set<RelationshipLevel>(["close", "friendly", "new", "polite"]);
const SPEECH_STYLES = new Set<SpeechStyle>(["banmal", "honorific"]);

export function isCommentLength(value: unknown): value is CommentLength {
  return typeof value === "string" && COMMENT_LENGTHS.has(value as CommentLength);
}

export function isCommentMood(value: unknown): value is CommentMood {
  return typeof value === "string" && COMMENT_MOODS.has(value as CommentMood);
}

export function isRelationshipLevel(value: unknown): value is RelationshipLevel {
  return typeof value === "string" && RELATIONSHIP_LEVELS.has(value as RelationshipLevel);
}

export function isSpeechStyle(value: unknown): value is SpeechStyle {
  return typeof value === "string" && SPEECH_STYLES.has(value as SpeechStyle);
}

export function isValidGenerationPreferences(value: GenerationPreferences): boolean {
  return (
    isCommentLength(value.commentLength) &&
    isCommentMood(value.commentMood) &&
    isRelationshipLevel(value.relationshipLevel) &&
    isSpeechStyle(value.speechStyle) &&
    (value.speechStyle !== "banmal" || value.relationshipLevel === "close")
  );
}

export function preferencesFromRequest(
  request: CreateRecommendationRequest,
): GenerationPreferences | null {
  const value: GenerationPreferences = {
    commentLength:
      request.comment_length === undefined
        ? DEFAULT_GENERATION_PREFERENCES.commentLength
        : request.comment_length,
    commentMood:
      request.comment_mood === undefined
        ? DEFAULT_GENERATION_PREFERENCES.commentMood
        : request.comment_mood,
    relationshipLevel:
      request.relationship_level === undefined
        ? DEFAULT_GENERATION_PREFERENCES.relationshipLevel
        : request.relationship_level,
    speechStyle:
      request.speech_style === undefined
        ? DEFAULT_GENERATION_PREFERENCES.speechStyle
        : request.speech_style,
  };
  return isValidGenerationPreferences(value) ? value : null;
}

export function requestPreferenceFields(
  preferences: GenerationPreferences,
): Pick<
  Required<CreateRecommendationRequest>,
  "comment_length" | "comment_mood" | "relationship_level" | "speech_style"
> {
  if (!isValidGenerationPreferences(preferences)) {
    throw new TypeError("Invalid generation preferences");
  }
  return {
    comment_length: preferences.commentLength,
    comment_mood: preferences.commentMood,
    relationship_level: preferences.relationshipLevel,
    speech_style: preferences.speechStyle,
  };
}

export function samePreferences(
  left: GenerationPreferences,
  right: GenerationPreferences,
): boolean {
  return (
    left.commentLength === right.commentLength &&
    left.commentMood === right.commentMood &&
    left.relationshipLevel === right.relationshipLevel &&
    left.speechStyle === right.speechStyle
  );
}
