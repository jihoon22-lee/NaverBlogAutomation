"""SQLAlchemy table metadata for the local SQLite database."""

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
)

from naver_blog_assistant.infrastructure.database.serialization import (
    DEFAULT_GENERATION_PREFERENCES_JSON,
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
    Column(
        "generation_preferences_json",
        Text,
        nullable=False,
        server_default=DEFAULT_GENERATION_PREFERENCES_JSON,
    ),
    Column("personalization_mode", String(32), nullable=False, server_default="off"),
    Column("personalization_sample_count", Integer, nullable=False, server_default="0"),
    Column("personalization_eligible", Boolean, nullable=False, server_default="1"),
    CheckConstraint(
        "review_status IN ('drafted', 'approved', 'completed')",
        name="ck_recommendations_review_status",
    ),
    CheckConstraint("length(content_hash) = 64", name="ck_recommendations_content_hash"),
    CheckConstraint("version >= 0", name="ck_recommendations_version"),
    CheckConstraint(
        "personalization_mode IN ('off', 'completed_examples')",
        name="ck_recommendations_personalization_mode",
    ),
    CheckConstraint(
        "personalization_sample_count BETWEEN 0 AND 5",
        name="ck_recommendations_personalization_sample_count",
    ),
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
    Column("failure_snapshot", Text, nullable=True),
    CheckConstraint(
        "state IN ('reserved', 'generating', 'completed', 'failed', 'indeterminate')",
        name="ck_idempotency_state",
    ),
    CheckConstraint("length(request_hash) = 64", name="ck_idempotency_request_hash"),
    CheckConstraint(
        "(state = 'reserved' AND generation_started_at IS NULL "
        "AND completed_at IS NULL AND recommendation_id IS NULL "
        "AND response_snapshot IS NULL AND failure_snapshot IS NULL) OR "
        "(state = 'generating' AND generation_started_at IS NOT NULL "
        "AND completed_at IS NULL AND recommendation_id IS NULL "
        "AND response_snapshot IS NULL AND failure_snapshot IS NULL) OR "
        "(state = 'completed' AND generation_started_at IS NOT NULL "
        "AND completed_at IS NOT NULL AND recommendation_id IS NOT NULL "
        "AND response_snapshot IS NOT NULL AND failure_snapshot IS NULL) OR "
        "(state IN ('failed', 'indeterminate') AND generation_started_at IS NOT NULL "
        "AND completed_at IS NOT NULL AND recommendation_id IS NULL "
        "AND response_snapshot IS NULL AND failure_snapshot IS NOT NULL)",
        name="ck_idempotency_state_payload",
    ),
)

neighbor_blogs = Table(
    "neighbor_blogs",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("name", String(120), nullable=False),
    Column("blog_url", Text, nullable=False, unique=True),
    Column("blog_id", String(100), nullable=False, unique=True),
    Column("enabled", Boolean, nullable=False, server_default="1"),
    Column("feed_status", String(16), nullable=False, server_default="unknown"),
    Column("last_checked_at", String(32), nullable=True),
    Column("created_at", String(32), nullable=False),
    CheckConstraint(
        "feed_status IN ('ready', 'unavailable', 'unknown')", name="ck_neighbor_feed_status"
    ),
)

saved_searches = Table(
    "saved_searches",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("query", String(120), nullable=False, unique=True),
    Column("excluded_terms_json", Text, nullable=False, server_default="[]"),
    Column("freshness_days", Integer, nullable=False, server_default="14"),
    Column("enabled", Boolean, nullable=False, server_default="1"),
    Column("created_at", String(32), nullable=False),
    CheckConstraint("freshness_days BETWEEN 1 AND 90", name="ck_saved_search_freshness_days"),
)

discovered_posts = Table(
    "discovered_posts",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("source", String(16), nullable=False),
    Column("state", String(16), nullable=False, server_default="queued"),
    Column("source_url", Text, nullable=False, unique=True),
    Column("title", String(300), nullable=False),
    Column("publisher_name", String(120), nullable=True),
    Column("publisher_blog_id", String(100), nullable=True),
    Column("published_at", String(32), nullable=True),
    Column(
        "neighbor_id",
        String(36),
        ForeignKey("neighbor_blogs.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column(
        "search_id", String(36), ForeignKey("saved_searches.id", ondelete="SET NULL"), nullable=True
    ),
    Column("created_at", String(32), nullable=False),
    Column("updated_at", String(32), nullable=False),
    CheckConstraint("source IN ('neighbor', 'search')", name="ck_discovered_posts_source"),
    CheckConstraint(
        "state IN ('queued', 'opened', 'completed', 'skipped', 'unavailable')",
        name="ck_discovered_posts_state",
    ),
)

digest_settings = Table(
    "digest_settings",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("timezone", String(64), nullable=False, server_default="Asia/Seoul"),
    Column("hour", Integer, nullable=False, server_default="9"),
    Column("minute", Integer, nullable=False, server_default="0"),
    Column("email_enabled", Boolean, nullable=False, server_default="0"),
    CheckConstraint("id = 1", name="ck_digest_settings_singleton"),
    CheckConstraint("hour BETWEEN 0 AND 23", name="ck_digest_hour"),
    CheckConstraint("minute BETWEEN 0 AND 59", name="ck_digest_minute"),
)

digest_runs = Table(
    "digest_runs",
    metadata,
    Column("local_date", String(10), primary_key=True),
    Column("created_at", String(32), nullable=False),
    Column("neighbor_post_count", Integer, nullable=False),
    Column("email_sent", Boolean, nullable=False, server_default="0"),
)

automatic_discovery_settings = Table(
    "automatic_discovery_settings",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("own_blog_id", String(100), nullable=False, server_default=""),
    Column("enabled", Boolean, nullable=False, server_default="0"),
    Column("timezone", String(64), nullable=False, server_default="Asia/Seoul"),
    Column("hour", Integer, nullable=False, server_default="9"),
    Column("minute", Integer, nullable=False, server_default="0"),
    Column("last_synced_at", String(32), nullable=True),
    Column("last_status", String(16), nullable=False, server_default="never"),
    Column("last_detail", String(300), nullable=False, server_default=""),
    CheckConstraint("id = 1", name="ck_automatic_discovery_settings_singleton"),
    CheckConstraint("hour BETWEEN 0 AND 23", name="ck_automatic_discovery_hour"),
    CheckConstraint("minute BETWEEN 0 AND 59", name="ck_automatic_discovery_minute"),
    CheckConstraint(
        "last_status IN ('never', 'success', 'partial', 'failed')",
        name="ck_automatic_discovery_status",
    ),
)

automatic_discovery_runs = Table(
    "automatic_discovery_runs",
    metadata,
    Column("local_date", String(10), primary_key=True),
    Column("created_at", String(32), nullable=False),
)

engagement_runs = Table(
    "engagement_runs",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("approval_id", String(36), nullable=False, unique=True),
    Column(
        "discovery_post_id",
        String(36),
        ForeignKey("discovered_posts.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    ),
    Column(
        "recommendation_id",
        String(36),
        ForeignKey("recommendations.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("source", String(16), nullable=False),
    Column("state", String(16), nullable=False),
    Column("created_at", String(32), nullable=False),
    Column("updated_at", String(32), nullable=False),
    CheckConstraint("source IN ('neighbor', 'search')", name="ck_engagement_runs_source"),
    CheckConstraint(
        "state IN ('running', 'succeeded', 'failed', 'unconfirmed')",
        name="ck_engagement_runs_state",
    ),
)

engagement_steps = Table(
    "engagement_steps",
    metadata,
    Column(
        "run_id",
        String(36),
        ForeignKey("engagement_runs.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("name", String(32), primary_key=True),
    Column("position", Integer, nullable=False),
    Column("state", String(16), nullable=False),
    Column("result_code", String(64), nullable=True),
    Column("updated_at", String(32), nullable=False),
    UniqueConstraint("run_id", "position", name="uq_engagement_steps_position"),
    CheckConstraint(
        "name IN ('like', 'comment', 'mutual_neighbor')",
        name="ck_engagement_steps_name",
    ),
    CheckConstraint("position BETWEEN 0 AND 2", name="ck_engagement_steps_position"),
    CheckConstraint(
        "state IN ('pending', 'running', 'succeeded', 'skipped', 'failed', 'unconfirmed')",
        name="ck_engagement_steps_state",
    ),
    CheckConstraint(
        "(state IN ('pending', 'running') AND result_code IS NULL) OR "
        "(state IN ('succeeded', 'skipped', 'failed', 'unconfirmed') "
        "AND result_code IS NOT NULL)",
        name="ck_engagement_steps_result",
    ),
)

APP_SETTING_KINDS = (
    "generation_profile",
    "closing_phrase",
    "neighbor_message",
    "automation_consent",
    "safety_policy",
    "schedule_policy",
    "browser_profile",
    "llm_providers",
    "llm_budget",
)

app_settings = Table(
    "app_settings",
    metadata,
    Column("kind", String(32), primary_key=True),
    Column("schema_version", Integer, nullable=False),
    Column("payload_json", Text, nullable=False),
    Column("updated_at", String(32), nullable=False),
    CheckConstraint(
        "kind IN (" + ", ".join(f"'{kind}'" for kind in APP_SETTING_KINDS) + ")",
        name="ck_app_settings_kind",
    ),
    CheckConstraint("schema_version >= 1", name="ck_app_settings_schema_version"),
    CheckConstraint("length(payload_json) > 0", name="ck_app_settings_payload"),
)

LLM_ATTEMPT_STATUSES = ("succeeded", "failed", "indeterminate")

llm_generation_attempts = Table(
    "llm_generation_attempts",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("request_hash", String(64), nullable=False),
    Column("attempt", Integer, nullable=False),
    Column("provider", String(32), nullable=False),
    Column("model", String(100), nullable=False),
    Column("status", String(16), nullable=False),
    Column("result_code", String(64), nullable=True),
    Column("recommendation_id", String(36), nullable=True),
    Column("retry_after", Integer, nullable=True),
    Column("created_at", String(32), nullable=False),
    CheckConstraint("attempt >= 1", name="ck_llm_attempts_attempt"),
    CheckConstraint(
        "status IN (" + ", ".join(f"'{status}'" for status in LLM_ATTEMPT_STATUSES) + ")",
        name="ck_llm_attempts_status",
    ),
    CheckConstraint("length(request_hash) = 64", name="ck_llm_attempts_request_hash"),
    UniqueConstraint(
        "request_hash", "attempt", "provider", "model", name="uq_llm_attempts_selection"
    ),
    Index("ix_llm_attempts_created_at", "created_at"),
)
