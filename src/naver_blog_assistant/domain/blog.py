"""The author's own blog catalog and how a similar category is chosen.

Similarity is decided here with a deterministic rule instead of a model call: the same two names
always produce the same score and the user makes the final choice. Reference bodies are never
stored; only the metadata needed to read them again.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime

from naver_blog_assistant.domain.models import DomainValidationError

MAX_CATEGORY_NAME_LENGTH = 120
MAX_REFERENCE_TITLE_LENGTH = 300
DEFAULT_REFERENCE_POST_COUNT = 5
MAX_REFERENCE_POST_COUNT = 10
_TOKEN = re.compile(r"[0-9A-Za-z\uac00-\ud7a3]+")


@dataclass(frozen=True, slots=True)
class BlogCategory:
    """One category of the author's own blog."""

    category_no: int
    name: str
    post_count: int | None = None
    synced_at: datetime | None = None

    def __post_init__(self) -> None:
        if self.category_no < 0:
            raise DomainValidationError("category_no must not be negative")
        normalized = self.name.strip()
        if not normalized or len(normalized) > MAX_CATEGORY_NAME_LENGTH:
            raise DomainValidationError(
                f"category name must be between 1 and {MAX_CATEGORY_NAME_LENGTH} characters"
            )
        if normalized != self.name:
            raise DomainValidationError("category name must be normalized before use")
        if self.post_count is not None and self.post_count < 0:
            raise DomainValidationError("post_count must not be negative")
        if self.synced_at is not None and self.synced_at.tzinfo is None:
            raise DomainValidationError("synced_at must be timezone-aware")


@dataclass(frozen=True, slots=True)
class ReferencePost:
    """One of the author's own posts, kept as metadata only."""

    category_no: int
    source_url: str
    title: str
    published_at: date | None = None
    synced_at: datetime | None = None

    def __post_init__(self) -> None:
        if self.category_no < 0:
            raise DomainValidationError("category_no must not be negative")
        if not self.source_url.strip():
            raise DomainValidationError("source_url must not be empty")
        normalized = self.title.strip()
        if not normalized or len(normalized) > MAX_REFERENCE_TITLE_LENGTH:
            raise DomainValidationError(
                f"title must be between 1 and {MAX_REFERENCE_TITLE_LENGTH} characters"
            )
        if self.synced_at is not None and self.synced_at.tzinfo is None:
            raise DomainValidationError("synced_at must be timezone-aware")


@dataclass(frozen=True, slots=True)
class CategoryMatch:
    """One candidate category and how close its name is to the target."""

    category: BlogCategory
    score: float

    @property
    def related(self) -> bool:
        """Report whether the score is high enough to offer as a similar category."""
        return self.score >= SIMILAR_CATEGORY_THRESHOLD


SIMILAR_CATEGORY_THRESHOLD = 0.34


def tokens(name: str) -> tuple[str, ...]:
    """Split one category name into comparable tokens."""
    folded = unicodedata.normalize("NFC", name).casefold()
    return tuple(match.group() for match in _TOKEN.finditer(folded))


def bigrams(name: str) -> frozenset[str]:
    """Return the character bigrams of one name, ignoring separators."""
    joined = "".join(tokens(name))
    if len(joined) < 2:
        return frozenset({joined} if joined else set())
    return frozenset(joined[index : index + 2] for index in range(len(joined) - 1))


def similarity(left: str, right: str) -> float:
    """Return a stable 0..1 score combining token overlap and character bigrams."""
    left_tokens, right_tokens = set(tokens(left)), set(tokens(right))
    if not left_tokens or not right_tokens:
        return 0.0
    if left_tokens == right_tokens:
        return 1.0
    token_score = len(left_tokens & right_tokens) / len(left_tokens | right_tokens)
    left_grams, right_grams = bigrams(left), bigrams(right)
    gram_score = (
        len(left_grams & right_grams) / len(left_grams | right_grams)
        if left_grams and right_grams
        else 0.0
    )
    return round((token_score * 2 + gram_score) / 3, 6)


def rank_similar_categories(
    target: BlogCategory, categories: tuple[BlogCategory, ...]
) -> tuple[CategoryMatch, ...]:
    """Rank other categories by name similarity, breaking ties by category number."""
    matches = [
        CategoryMatch(category=category, score=similarity(target.name, category.name))
        for category in categories
        if category.category_no != target.category_no
    ]
    matches.sort(key=lambda match: (-match.score, match.category.category_no))
    return tuple(matches)


def reference_category_numbers(
    target: BlogCategory, categories: tuple[BlogCategory, ...], *, limit: int = 2
) -> tuple[int, ...]:
    """Return the target plus the closest related categories, in preference order."""
    if limit < 0:
        raise DomainValidationError("limit must not be negative")
    related = [
        match.category.category_no
        for match in rank_similar_categories(target, categories)[:limit]
        if match.related
    ]
    return (target.category_no, *related)
