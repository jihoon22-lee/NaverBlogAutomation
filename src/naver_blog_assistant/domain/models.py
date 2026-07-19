"""Framework-independent domain models for comment recommendations."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, replace
from datetime import datetime
from enum import StrEnum
from typing import Final
from uuid import UUID

MAX_COMMENT_LENGTH: Final = 500
MAX_EXCERPT_LENGTH: Final = 500
REQUIRED_TONES: Final = frozenset({"warm", "curious", "supportive"})


class DomainValidationError(ValueError):
    """Raised when a domain object would violate a business invariant."""


class CandidateSelectionError(DomainValidationError):
    """Raised when a selected candidate does not belong to a recommendation."""


class ReviewTransitionError(DomainValidationError):
    """Raised when a review attempts an unsupported state transition."""


class CandidateTone(StrEnum):
    """Required perspectives for the three generated comments."""

    WARM = "warm"
    CURIOUS = "curious"
    SUPPORTIVE = "supportive"


class ReviewStatus(StrEnum):
    """Human-review lifecycle for a recommendation."""

    DRAFTED = "drafted"
    APPROVED = "approved"
    COMPLETED = "completed"


class Relationship(StrEnum):
    """Writer relationship used to calibrate a generated comment."""

    NEW = "new"
    POLITE = "polite"
    FRIENDLY = "friendly"
    CLOSE = "close"


class SpeechStyle(StrEnum):
    """Requested Korean speech level for a generated comment."""

    HONORIFIC = "honorific"
    BANMAL = "banmal"


class CommentLength(StrEnum):
    """Requested relative length of a generated comment."""

    SHORT = "short"
    MEDIUM = "medium"
    LONG = "long"


@dataclass(frozen=True, slots=True)
class GenerationPreferences:
    """Immutable generation provenance attached to a recommendation."""

    relationship: Relationship
    speech: SpeechStyle
    length: CommentLength

    def __post_init__(self) -> None:
        if not isinstance(self.relationship, Relationship):
            raise DomainValidationError("relationship must be a Relationship")
        if not isinstance(self.speech, SpeechStyle):
            raise DomainValidationError("speech must be a SpeechStyle")
        if not isinstance(self.length, CommentLength):
            raise DomainValidationError("length must be a CommentLength")
        if self.speech is SpeechStyle.BANMAL and self.relationship is not Relationship.CLOSE:
            raise DomainValidationError("banmal is allowed only for a close relationship")


DEFAULT_GENERATION_PREFERENCES: Final = GenerationPreferences(
    relationship=Relationship.FRIENDLY,
    speech=SpeechStyle.HONORIFIC,
    length=CommentLength.MEDIUM,
)


@dataclass(frozen=True, slots=True)
class CapturedPost:
    """Article content held only for the duration of generation."""

    source_url: str
    title: str
    body: str = field(repr=False, compare=False)

    def __post_init__(self) -> None:
        if not self.source_url.strip():
            raise DomainValidationError("source_url must not be empty")
        if not self.title.strip():
            raise DomainValidationError("title must not be empty")
        if not self.body.strip():
            raise DomainValidationError("body must not be empty")

    @property
    def content_hash(self) -> str:
        """Return a stable digest without retaining the article body."""
        return hashlib.sha256(self.body.encode()).hexdigest()

    @property
    def request_hash(self) -> str:
        """Return a stable digest for idempotency comparisons."""
        payload = json.dumps(
            {
                "source_url": self.source_url,
                "title": self.title,
                "body": self.body,
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode()).hexdigest()

    def request_hash_for(self, preferences: GenerationPreferences) -> str:
        """Bind idempotency to effective preferences while preserving legacy defaults."""
        if not isinstance(preferences, GenerationPreferences):
            raise DomainValidationError("preferences must be GenerationPreferences")
        if preferences == DEFAULT_GENERATION_PREFERENCES:
            return self.request_hash
        payload = json.dumps(
            {
                "schema": "generation-preferences-v1",
                "post_hash": self.request_hash,
                "relationship_level": preferences.relationship.value,
                "speech_style": preferences.speech.value,
                "comment_length": preferences.length.value,
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode()).hexdigest()

    @property
    def excerpt(self) -> str:
        """Return a bounded preview that can never reconstruct the complete body."""
        preview_length = min(MAX_EXCERPT_LENGTH, len(self.body) // 2)
        return self.body[:preview_length]


@dataclass(frozen=True, slots=True)
class GeneratedComment:
    """Generator output before the application assigns a persistent identity."""

    tone: CandidateTone
    comment: str
    referenced_detail: str


@dataclass(frozen=True, slots=True)
class GenerationOutput:
    """Framework-neutral output returned by a comment generator port."""

    summary: str
    topics: tuple[str, ...]
    candidates: tuple[GeneratedComment, ...]


@dataclass(frozen=True, slots=True)
class CommentCandidate:
    """One grounded comment candidate awaiting human review."""

    id: UUID
    tone: CandidateTone
    comment: str
    referenced_detail: str

    def __post_init__(self) -> None:
        _require_bounded_text("comment", self.comment, MAX_COMMENT_LENGTH)
        _require_bounded_text("referenced_detail", self.referenced_detail, 300)


@dataclass(frozen=True, slots=True)
class ReviewPatch:
    """A framework-neutral partial update to a recommendation review."""

    selected_candidate_id: UUID | None = None
    selected_candidate_index: int | None = None
    clear_selection: bool = False
    edited_comment: str | None = None
    clear_edited_comment: bool = False
    review_status: ReviewStatus | None = None

    def __post_init__(self) -> None:
        selectors = sum(
            (
                self.selected_candidate_id is not None,
                self.selected_candidate_index is not None,
                self.clear_selection,
            )
        )
        if selectors > 1:
            raise DomainValidationError("only one candidate selection operation is allowed")
        if self.edited_comment is not None and self.clear_edited_comment:
            raise DomainValidationError("edited_comment cannot be set and cleared together")
        if self.selected_candidate_index is not None and self.selected_candidate_index < 0:
            raise CandidateSelectionError("candidate index must not be negative")
        if self.edited_comment is not None:
            _require_bounded_text("edited_comment", self.edited_comment, MAX_COMMENT_LENGTH)
        if not self.has_changes:
            raise DomainValidationError("review patch must contain at least one change")

    @property
    def has_changes(self) -> bool:
        """Return whether the patch contains an observable operation."""
        return any(
            (
                self.selected_candidate_id is not None,
                self.selected_candidate_index is not None,
                self.clear_selection,
                self.edited_comment is not None,
                self.clear_edited_comment,
                self.review_status is not None,
            )
        )


@dataclass(frozen=True, slots=True)
class Recommendation:
    """Persistable recommendation that deliberately excludes the full article body."""

    id: UUID
    source_url: str
    title: str
    content_hash: str
    excerpt: str
    summary: str
    topics: tuple[str, ...]
    candidates: tuple[CommentCandidate, ...]
    review_status: ReviewStatus
    created_at: datetime
    preferences: GenerationPreferences
    selected_candidate_id: UUID | None = None
    edited_comment: str | None = None
    updated_at: datetime | None = None
    version: int = 0

    def __post_init__(self) -> None:
        if not self.source_url.strip():
            raise DomainValidationError("source_url must not be empty")
        _require_bounded_text("title", self.title, 300)
        _require_bounded_text("summary", self.summary, 800)
        if len(self.content_hash) != 64:
            raise DomainValidationError("content_hash must be a SHA-256 hex digest")
        try:
            int(self.content_hash, 16)
        except ValueError as error:
            raise DomainValidationError("content_hash must be a SHA-256 hex digest") from error
        if len(self.excerpt) > MAX_EXCERPT_LENGTH:
            raise DomainValidationError("excerpt exceeds the persistence limit")
        if not 1 <= len(self.topics) <= 5:
            raise DomainValidationError("topics must contain between one and five values")
        if len(set(self.topics)) != len(self.topics):
            raise DomainValidationError("topics must be unique")
        for topic in self.topics:
            _require_bounded_text("topic", topic, 80)
        if len(self.candidates) != 3:
            raise DomainValidationError("recommendation must contain exactly three candidates")
        tones = {candidate.tone.value for candidate in self.candidates}
        if tones != REQUIRED_TONES:
            raise DomainValidationError("recommendation must contain all required tones")
        candidate_ids = {candidate.id for candidate in self.candidates}
        if len(candidate_ids) != len(self.candidates):
            raise DomainValidationError("candidate ids must be unique")
        if (
            self.selected_candidate_id is not None
            and self.selected_candidate_id not in candidate_ids
        ):
            raise CandidateSelectionError("selected candidate does not belong to recommendation")
        if self.edited_comment is not None:
            _require_bounded_text("edited_comment", self.edited_comment, MAX_COMMENT_LENGTH)
        if not isinstance(self.preferences, GenerationPreferences):
            raise DomainValidationError("preferences must be GenerationPreferences")
        if self.created_at.tzinfo is None:
            raise DomainValidationError("created_at must be timezone-aware")
        if self.updated_at is not None and self.updated_at.tzinfo is None:
            raise DomainValidationError("updated_at must be timezone-aware")
        if self.version < 0:
            raise DomainValidationError("version must not be negative")

    def apply_review(self, patch: ReviewPatch, *, reviewed_at: datetime) -> Recommendation:
        """Apply a validated, forward-only human-review operation."""
        if reviewed_at.tzinfo is None:
            raise DomainValidationError("reviewed_at must be timezone-aware")
        if self.review_status is ReviewStatus.COMPLETED and _changes_review_content(patch):
            raise ReviewTransitionError("completed recommendations cannot be edited")

        selected_candidate_id = self.selected_candidate_id
        if patch.clear_selection:
            selected_candidate_id = None
        elif patch.selected_candidate_id is not None:
            self._candidate_by_id(patch.selected_candidate_id)
            selected_candidate_id = patch.selected_candidate_id
        elif patch.selected_candidate_index is not None:
            selected_candidate_id = self._candidate_by_index(patch.selected_candidate_index).id

        edited_comment = self.edited_comment
        if patch.clear_edited_comment:
            edited_comment = None
        elif patch.edited_comment is not None:
            edited_comment = patch.edited_comment

        review_status = self.review_status
        if patch.review_status is not None:
            _validate_transition(self.review_status, patch.review_status)
            review_status = patch.review_status

        return replace(
            self,
            selected_candidate_id=selected_candidate_id,
            edited_comment=edited_comment,
            review_status=review_status,
            updated_at=reviewed_at,
        )

    def _candidate_by_id(self, candidate_id: UUID) -> CommentCandidate:
        for candidate in self.candidates:
            if candidate.id == candidate_id:
                return candidate
        raise CandidateSelectionError("selected candidate does not belong to recommendation")

    def _candidate_by_index(self, index: int) -> CommentCandidate:
        try:
            return self.candidates[index]
        except IndexError as error:
            raise CandidateSelectionError("candidate index is out of range") from error


def _require_bounded_text(name: str, value: str, maximum: int) -> None:
    if not value.strip():
        raise DomainValidationError(f"{name} must not be empty")
    if len(value) > maximum:
        raise DomainValidationError(f"{name} exceeds its maximum length")


def _changes_review_content(patch: ReviewPatch) -> bool:
    return any(
        (
            patch.selected_candidate_id is not None,
            patch.selected_candidate_index is not None,
            patch.clear_selection,
            patch.edited_comment is not None,
            patch.clear_edited_comment,
        )
    )


def _validate_transition(current: ReviewStatus, requested: ReviewStatus) -> None:
    if requested is current:
        return
    allowed = {
        ReviewStatus.DRAFTED: ReviewStatus.APPROVED,
        ReviewStatus.APPROVED: ReviewStatus.COMPLETED,
    }
    if allowed.get(current) is not requested:
        raise ReviewTransitionError(f"cannot transition from {current} to {requested}")
