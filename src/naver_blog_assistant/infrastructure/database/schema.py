"""SQLAlchemy table metadata for the local SQLite database."""

from sqlalchemy import (
    CheckConstraint,
    Column,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
)

metadata = MetaData()

recommendations = Table(
    "recommendations",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("source_url", Text, nullable=False),
    Column("title", String(300), nullable=False),
    Column("content_hash", String(64), nullable=False),
    Column("excerpt", String(500), nullable=False),
    Column("summary", String(800), nullable=False),
    Column("topics_json", Text, nullable=False),
    Column("review_status", String(16), nullable=False),
    Column("selected_candidate_id", String(36), nullable=True),
    Column("edited_comment", String(500), nullable=True),
    Column("created_at", String(32), nullable=False),
    Column("updated_at", String(32), nullable=True),
    Column("version", Integer, nullable=False),
    CheckConstraint(
        "review_status IN ('drafted', 'approved', 'completed')",
        name="ck_recommendations_review_status",
    ),
    CheckConstraint("length(content_hash) = 64", name="ck_recommendations_content_hash"),
    CheckConstraint("version >= 0", name="ck_recommendations_version"),
)

comment_candidates = Table(
    "comment_candidates",
    metadata,
    Column("id", String(36), primary_key=True),
    Column(
        "recommendation_id",
        String(36),
        ForeignKey("recommendations.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("position", Integer, nullable=False),
    Column("tone", String(16), nullable=False),
    Column("comment", String(500), nullable=False),
    Column("referenced_detail", String(300), nullable=False),
    UniqueConstraint("recommendation_id", "position", name="uq_candidates_position"),
    UniqueConstraint("recommendation_id", "id", name="uq_candidates_recommendation_id"),
    CheckConstraint("position BETWEEN 0 AND 2", name="ck_candidates_position"),
    CheckConstraint(
        "tone IN ('warm', 'curious', 'supportive')",
        name="ck_candidates_tone",
    ),
)

# The composite relationship guarantees that a selection belongs to its recommendation.
recommendations.append_constraint(
    ForeignKeyConstraint(
        [recommendations.c.id, recommendations.c.selected_candidate_id],
        [comment_candidates.c.recommendation_id, comment_candidates.c.id],
        name="fk_recommendations_selected_candidate",
        deferrable=True,
        initially="DEFERRED",
    )
)

idempotency_records = Table(
    "idempotency_records",
    metadata,
    Column("key", String(36), primary_key=True),
    Column("request_hash", String(64), nullable=False),
    Column("attempt_id", String(36), nullable=False),
    Column("state", String(16), nullable=False),
    Column("started_at", String(32), nullable=False),
    Column("generation_started_at", String(32), nullable=True),
    Column("completed_at", String(32), nullable=True),
    Column(
        "recommendation_id",
        String(36),
        ForeignKey("recommendations.id", ondelete="RESTRICT"),
        nullable=True,
        unique=True,
    ),
    Column("response_snapshot", Text, nullable=True),
    CheckConstraint(
        "state IN ('reserved', 'generating', 'completed')",
        name="ck_idempotency_state",
    ),
    CheckConstraint("length(request_hash) = 64", name="ck_idempotency_request_hash"),
    CheckConstraint(
        "(state = 'reserved' AND generation_started_at IS NULL "
        "AND completed_at IS NULL AND recommendation_id IS NULL "
        "AND response_snapshot IS NULL) OR "
        "(state = 'generating' AND generation_started_at IS NOT NULL "
        "AND completed_at IS NULL AND recommendation_id IS NULL "
        "AND response_snapshot IS NULL) OR "
        "(state = 'completed' AND generation_started_at IS NOT NULL "
        "AND completed_at IS NOT NULL AND recommendation_id IS NOT NULL "
        "AND response_snapshot IS NOT NULL)",
        name="ck_idempotency_state_payload",
    ),
)
