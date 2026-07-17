"""Persist safe idempotency failure snapshots.

Revision ID: 20260717_0002
Revises: 20260716_0001
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260717_0002"
down_revision: str | None = "20260716_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("idempotency_records", recreate="always") as batch:
        batch.add_column(sa.Column("failure_snapshot", sa.Text(), nullable=True))
        batch.drop_constraint("ck_idempotency_state", type_="check")
        batch.drop_constraint("ck_idempotency_state_payload", type_="check")
        batch.create_check_constraint(
            "ck_idempotency_state",
            "state IN ('reserved', 'generating', 'completed', 'failed', 'indeterminate')",
        )
        batch.create_check_constraint(
            "ck_idempotency_state_payload",
            "(state = 'reserved' AND generation_started_at IS NULL AND completed_at IS NULL "
            "AND recommendation_id IS NULL AND response_snapshot IS NULL "
            "AND failure_snapshot IS NULL) OR "
            "(state = 'generating' AND generation_started_at IS NOT NULL "
            "AND completed_at IS NULL AND recommendation_id IS NULL "
            "AND response_snapshot IS NULL AND failure_snapshot IS NULL) OR "
            "(state = 'completed' AND generation_started_at IS NOT NULL "
            "AND completed_at IS NOT NULL AND recommendation_id IS NOT NULL "
            "AND response_snapshot IS NOT NULL AND failure_snapshot IS NULL) OR "
            "(state IN ('failed', 'indeterminate') AND generation_started_at IS NOT NULL "
            "AND completed_at IS NOT NULL AND recommendation_id IS NULL "
            "AND response_snapshot IS NULL AND failure_snapshot IS NOT NULL)",
        )


def downgrade() -> None:
    terminal_failures = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT count(*) FROM idempotency_records "
                "WHERE state IN ('failed', 'indeterminate')"
            )
        )
        .scalar_one()
    )
    if terminal_failures:
        raise RuntimeError(
            "cannot downgrade while failed or indeterminate idempotency fences exist"
        )
    with op.batch_alter_table("idempotency_records", recreate="always") as batch:
        batch.drop_constraint("ck_idempotency_state", type_="check")
        batch.drop_constraint("ck_idempotency_state_payload", type_="check")
        batch.create_check_constraint(
            "ck_idempotency_state",
            "state IN ('reserved', 'generating', 'completed')",
        )
        batch.create_check_constraint(
            "ck_idempotency_state_payload",
            "(state = 'reserved' AND generation_started_at IS NULL AND completed_at IS NULL "
            "AND recommendation_id IS NULL AND response_snapshot IS NULL) OR "
            "(state = 'generating' AND generation_started_at IS NOT NULL "
            "AND completed_at IS NULL AND recommendation_id IS NULL "
            "AND response_snapshot IS NULL) OR "
            "(state = 'completed' AND generation_started_at IS NOT NULL "
            "AND completed_at IS NOT NULL AND recommendation_id IS NOT NULL "
            "AND response_snapshot IS NOT NULL)",
        )
        batch.drop_column("failure_snapshot")
