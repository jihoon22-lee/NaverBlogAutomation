"""Create recommendation and idempotency tables.

Revision ID: 20260716_0001
Revises: None
Create Date: 2026-07-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260716_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the initial local persistence schema."""
    op.create_table(
        "recommendations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("excerpt", sa.String(length=500), nullable=False),
        sa.Column("summary", sa.String(length=800), nullable=False),
        sa.Column("topics_json", sa.Text(), nullable=False),
        sa.Column("review_status", sa.String(length=16), nullable=False),
        sa.Column("selected_candidate_id", sa.String(length=36), nullable=True),
        sa.Column("edited_comment", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.String(length=32), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.CheckConstraint("length(content_hash) = 64", name="ck_recommendations_content_hash"),
        sa.CheckConstraint(
            "review_status IN ('drafted', 'approved', 'completed')",
            name="ck_recommendations_review_status",
        ),
        sa.CheckConstraint("version >= 0", name="ck_recommendations_version"),
        sa.ForeignKeyConstraint(
            ["id", "selected_candidate_id"],
            ["comment_candidates.recommendation_id", "comment_candidates.id"],
            name="fk_recommendations_selected_candidate",
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "comment_candidates",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("recommendation_id", sa.String(length=36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("tone", sa.String(length=16), nullable=False),
        sa.Column("comment", sa.String(length=500), nullable=False),
        sa.Column("referenced_detail", sa.String(length=300), nullable=False),
        sa.CheckConstraint("position BETWEEN 0 AND 2", name="ck_candidates_position"),
        sa.CheckConstraint("tone IN ('warm', 'curious', 'supportive')", name="ck_candidates_tone"),
        sa.ForeignKeyConstraint(["recommendation_id"], ["recommendations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("recommendation_id", "id", name="uq_candidates_recommendation_id"),
        sa.UniqueConstraint("recommendation_id", "position", name="uq_candidates_position"),
    )
    op.create_table(
        "idempotency_records",
        sa.Column("key", sa.String(length=36), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("attempt_id", sa.String(length=36), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("started_at", sa.String(length=32), nullable=False),
        sa.Column("generation_started_at", sa.String(length=32), nullable=True),
        sa.Column("completed_at", sa.String(length=32), nullable=True),
        sa.Column("recommendation_id", sa.String(length=36), nullable=True),
        sa.Column("response_snapshot", sa.Text(), nullable=True),
        sa.CheckConstraint("length(request_hash) = 64", name="ck_idempotency_request_hash"),
        sa.CheckConstraint(
            "state IN ('reserved', 'generating', 'completed')",
            name="ck_idempotency_state",
        ),
        sa.CheckConstraint(
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
        sa.ForeignKeyConstraint(["recommendation_id"], ["recommendations.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("key"),
        sa.UniqueConstraint("recommendation_id"),
    )


def downgrade() -> None:
    """Remove all initial persistence tables."""
    op.drop_table("idempotency_records")
    # Break the intentional circular relationship before SQLite performs the implicit
    # DELETE associated with dropping the candidate table.
    op.execute("UPDATE recommendations SET selected_candidate_id = NULL")
    op.drop_table("comment_candidates")
    op.drop_table("recommendations")
