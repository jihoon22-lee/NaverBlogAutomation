import type {
  CommentLength,
  CreateRecommendationRequest,
  RelationshipLevel,
  SpeechStyle,
} from "../api/types";

export interface GenerationPreferences {
  readonly commentLength: CommentLength;
  readonly relationshipLevel: RelationshipLevel;
  readonly speechStyle: SpeechStyle;
}

export const DEFAULT_GENERATION_PREFERENCES: GenerationPreferences = Object.freeze({
  commentLength: "medium",
  relationshipLevel: "friendly",
  speechStyle: "honorific",
});

const COMMENT_LENGTHS = new Set<CommentLength>(["long", "medium", "short"]);
const RELATIONSHIP_LEVELS = new Set<RelationshipLevel>(["close", "friendly", "new", "polite"]);
const SPEECH_STYLES = new Set<SpeechStyle>(["banmal", "honorific"]);

export function isCommentLength(value: unknown): value is CommentLength {
  return typeof value === "string" && COMMENT_LENGTHS.has(value as CommentLength);
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
  "comment_length" | "relationship_level" | "speech_style"
> {
  if (!isValidGenerationPreferences(preferences)) {
    throw new TypeError("Invalid generation preferences");
  }
  return {
    comment_length: preferences.commentLength,
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
    left.relationshipLevel === right.relationshipLevel &&
    left.speechStyle === right.speechStyle
  );
}
