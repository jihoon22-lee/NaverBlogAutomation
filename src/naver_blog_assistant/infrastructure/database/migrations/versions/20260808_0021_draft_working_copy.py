"""Add optimistic working copies for block-editor drafts.

Revision ID: 20260808_0021
Revises: 20260801_0020
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260808_0021"
down_revision: str | None = "20260801_0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Keep editable content separate from immutable compose/refine checkpoints."""
    # Do not use `batch_alter_table` here.  SQLite implements it by replacing `post_drafts`; the
    # old table's drop can cascade-delete every `post_draft_revisions` row.  SQLite supports these
    # additive columns directly, which preserves the immutable revision history during upgrade.
    op.add_column("post_drafts", sa.Column("working_title", sa.String(length=300), nullable=True))
    op.add_column("post_drafts", sa.Column("working_blocks_json", sa.Text(), nullable=True))
    op.add_column(
        "post_drafts",
        sa.Column("working_summary", sa.String(length=800), nullable=False, server_default=""),
    )
    op.add_column(
        "post_drafts",
        sa.Column("content_version", sa.Integer(), nullable=False, server_default="0"),
    )

    # Use one correlated update rather than a Python cursor loop.  SQLite can invalidate a live
    # SELECT cursor when writes occur on the same migration connection, silently leaving defaults.
    connection = op.get_bind()
    connection.execute(
        sa.text(
            """
        UPDATE post_drafts
        SET working_title = (
                SELECT revision.title FROM post_draft_revisions AS revision
                WHERE revision.draft_id = post_drafts.id AND revision.is_active
            ),
            working_blocks_json = (
                SELECT revision.body_blocks_json FROM post_draft_revisions AS revision
                WHERE revision.draft_id = post_drafts.id AND revision.is_active
            ),
            working_summary = (
                SELECT revision.summary FROM post_draft_revisions AS revision
                WHERE revision.draft_id = post_drafts.id AND revision.is_active
            ),
            content_version = 1
        WHERE EXISTS (
            SELECT 1 FROM post_draft_revisions AS revision
            WHERE revision.draft_id = post_drafts.id AND revision.is_active
        )
        """
        )
    )


def downgrade() -> None:
    """Remove working copies; immutable revision history remains intact."""
    # Direct drops avoid the same replacement/cascade hazard described in upgrade.  The supported
    # SQLite runtime accepts DROP COLUMN; revision history must remain untouched on rollback.
    op.drop_column("post_drafts", "content_version")
    op.drop_column("post_drafts", "working_summary")
    op.drop_column("post_drafts", "working_blocks_json")
    op.drop_column("post_drafts", "working_title")
