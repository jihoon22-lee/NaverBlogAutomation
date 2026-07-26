"""Store a discovery post's publishing blog for candidate de-duplication.

Revision ID: 20260728_0008
Revises: 20260727_0007
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260728_0008"
down_revision: str | None = "20260727_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add normalized publisher identity to existing metadata-only rows."""
    op.add_column("discovered_posts", sa.Column("publisher_blog_id", sa.String(length=100)))


def downgrade() -> None:
    """Remove the derived publisher identity column."""
    op.drop_column("discovered_posts", "publisher_blog_id")
