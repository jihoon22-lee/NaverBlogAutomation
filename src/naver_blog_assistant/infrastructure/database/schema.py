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

remote_device_sessions = Table(
    "remote_device_sessions",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("device_name", String(80), nullable=False),
    Column("token_hash", String(64), nullable=False, unique=True),
    Column("csrf_hash", String(64), nullable=False),
    Column("created_at", String(32), nullable=False),
    Column("last_seen_at", String(32), nullable=False),
    Column("expires_at", String(32), nullable=False),
    Column("revoked_at", String(32), nullable=True),
    CheckConstraint("length(device_name) BETWEEN 1 AND 80", name="ck_remote_device_name"),
    CheckConstraint("length(token_hash) = 64", name="ck_remote_device_token_hash"),
    CheckConstraint("length(csrf_hash) = 64", name="ck_remote_device_csrf_hash"),
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
    Column("session_id", String(36), nullable=True),
    Column("trigger", String(16), nullable=False, server_default="manual"),
    Column("created_at", String(32), nullable=False),
    Column("updated_at", String(32), nullable=False),
    CheckConstraint("source IN ('neighbor', 'search')", name="ck_engagement_runs_source"),
    Index("ix_engagement_runs_session", "session_id"),
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
    "writing_profile",
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

blog_categories = Table(
    "blog_categories",
    metadata,
    Column("category_no", Integer, primary_key=True),
    Column("name", String(120), nullable=False),
    Column("post_count", Integer, nullable=True),
    Column("synced_at", String(32), nullable=False),
    CheckConstraint("category_no >= 0", name="ck_blog_categories_no"),
    CheckConstraint("length(name) > 0", name="ck_blog_categories_name"),
    CheckConstraint("post_count IS NULL OR post_count >= 0", name="ck_blog_categories_post_count"),
)

blog_reference_posts = Table(
    "blog_reference_posts",
    metadata,
    Column("source_url", String(2048), primary_key=True),
    Column("category_no", Integer, nullable=False),
    Column("title", String(300), nullable=False),
    Column("published_at", String(10), nullable=True),
    Column("synced_at", String(32), nullable=False),
    CheckConstraint("category_no >= 0", name="ck_blog_reference_category_no"),
    CheckConstraint("length(title) > 0", name="ck_blog_reference_title"),
    Index("ix_blog_reference_category", "category_no", "published_at"),
)

DRAFT_STATUSES = (
    "collecting",
    "composed",
    "refining",
    "tagged",
    "staging",
    "staged",
    "abandoned",
)
DRAFT_REVISION_KINDS = ("seed", "composed", "refined", "user_edited")
DRAFT_TAG_SOURCES = ("generated", "user")


def _allowed(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"


post_drafts = Table(
    "post_drafts",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("title", String(300), nullable=False),
    Column("category_no", Integer, nullable=True),
    Column("status", String(16), nullable=False),
    Column("use_image_vision", Boolean, nullable=False),
    Column("seed_text", Text, nullable=False),
    Column("created_at", String(32), nullable=False),
    Column("updated_at", String(32), nullable=False),
    CheckConstraint(_allowed("status", DRAFT_STATUSES), name="ck_post_drafts_status"),
    CheckConstraint("length(title) > 0", name="ck_post_drafts_title"),
    CheckConstraint("category_no IS NULL OR category_no >= 0", name="ck_post_drafts_category_no"),
)

post_draft_revisions = Table(
    "post_draft_revisions",
    metadata,
    Column("id", String(36), primary_key=True),
    Column(
        "draft_id",
        String(36),
        ForeignKey("post_drafts.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("round_no", Integer, nullable=False),
    Column("kind", String(16), nullable=False),
    Column("provider", String(32), nullable=True),
    Column("model", String(100), nullable=True),
    Column("title", String(300), nullable=False),
    Column("body_blocks_json", Text, nullable=False),
    Column("summary", String(800), nullable=False),
    Column("is_active", Boolean, nullable=False),
    Column("created_at", String(32), nullable=False),
    CheckConstraint("round_no >= 0", name="ck_post_draft_revisions_round"),
    CheckConstraint(_allowed("kind", DRAFT_REVISION_KINDS), name="ck_post_draft_revisions_kind"),
    CheckConstraint("length(body_blocks_json) > 0", name="ck_post_draft_revisions_body"),
    UniqueConstraint(
        "draft_id", "round_no", "provider", "model", name="uq_post_draft_revision_round"
    ),
    Index("ix_post_draft_revisions_draft", "draft_id", "round_no"),
)

post_draft_images = Table(
    "post_draft_images",
    metadata,
    Column("id", String(36), primary_key=True),
    Column(
        "draft_id",
        String(36),
        ForeignKey("post_drafts.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("ordinal", Integer, nullable=False),
    Column("stored_path", String(1024), nullable=False),
    Column("original_filename", String(255), nullable=False),
    Column("byte_size", Integer, nullable=False),
    Column("mime", String(64), nullable=False),
    Column("alt_text", String(300), nullable=False),
    CheckConstraint("ordinal >= 0", name="ck_post_draft_images_ordinal"),
    CheckConstraint("byte_size > 0", name="ck_post_draft_images_size"),
    UniqueConstraint("draft_id", "ordinal", name="uq_post_draft_images_ordinal"),
)

post_draft_tags = Table(
    "post_draft_tags",
    metadata,
    Column(
        "draft_id",
        String(36),
        ForeignKey("post_drafts.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("tag", String(30), primary_key=True),
    Column("ordinal", Integer, nullable=False),
    Column("source", String(16), nullable=False),
    Column("selected", Boolean, nullable=False),
    CheckConstraint("ordinal >= 0", name="ck_post_draft_tags_ordinal"),
    CheckConstraint("length(tag) > 0", name="ck_post_draft_tags_tag"),
    CheckConstraint(_allowed("source", DRAFT_TAG_SOURCES), name="ck_post_draft_tags_source"),
)

PUBLISH_RUN_STATES = ("running", "succeeded", "failed", "unconfirmed")
PUBLISH_STEP_NAMES = ("title", "body", "images", "tags", "save")
PUBLISH_STEP_STATES = (
    "pending",
    "running",
    "succeeded",
    "skipped",
    "failed",
    "unconfirmed",
)

publish_runs = Table(
    "publish_runs",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("draft_id", String(36), nullable=False),
    Column("revision_id", String(36), nullable=False),
    Column("state", String(16), nullable=False),
    Column("result_code", String(64), nullable=True),
    Column("created_at", String(32), nullable=False),
    Column("updated_at", String(32), nullable=False),
    CheckConstraint(_allowed("state", PUBLISH_RUN_STATES), name="ck_publish_runs_state"),
    UniqueConstraint("draft_id", "revision_id", name="uq_publish_runs_revision"),
)

publish_run_steps = Table(
    "publish_run_steps",
    metadata,
    Column(
        "run_id",
        String(36),
        ForeignKey("publish_runs.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("name", String(16), primary_key=True),
    Column("position", Integer, nullable=False),
    Column("state", String(16), nullable=False),
    Column("result_code", String(64), nullable=True),
    Column("updated_at", String(32), nullable=False),
    CheckConstraint(_allowed("name", PUBLISH_STEP_NAMES), name="ck_publish_run_steps_name"),
    CheckConstraint(_allowed("state", PUBLISH_STEP_STATES), name="ck_publish_run_steps_state"),
    CheckConstraint("position >= 0 AND position <= 4", name="ck_publish_run_steps_position"),
    UniqueConstraint("run_id", "position", name="uq_publish_run_steps_position"),
)

SESSION_TRIGGERS = ("manual", "session", "schedule")
SESSION_STATES = ("pending", "running", "completed", "aborted", "cancelled")

automation_sessions = Table(
    "automation_sessions",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("trigger", String(16), nullable=False),
    Column("state", String(16), nullable=False),
    Column("approved_steps_json", Text, nullable=False),
    Column("max_posts", Integer, nullable=False),
    Column("source_filter_json", Text, nullable=False),
    Column("processed_count", Integer, nullable=False),
    Column("created_at", String(32), nullable=False),
    Column("started_at", String(32), nullable=True),
    Column("finished_at", String(32), nullable=True),
    Column("abort_reason", String(64), nullable=True),
    CheckConstraint(_allowed("trigger", SESSION_TRIGGERS), name="ck_automation_sessions_trigger"),
    CheckConstraint(_allowed("state", SESSION_STATES), name="ck_automation_sessions_state"),
    CheckConstraint("max_posts >= 1", name="ck_automation_sessions_max_posts"),
    CheckConstraint("processed_count >= 0", name="ck_automation_sessions_processed"),
)

ACTIVITY_ACTIONS = ("like", "comment", "mutual_neighbor")

automation_activity_ledger = Table(
    "automation_activity_ledger",
    metadata,
    Column("date", String(10), primary_key=True),
    Column("action", String(16), primary_key=True),
    Column("count", Integer, nullable=False),
    CheckConstraint(_allowed("action", ACTIVITY_ACTIONS), name="ck_activity_ledger_action"),
    CheckConstraint("count >= 0", name="ck_activity_ledger_count"),
    CheckConstraint("length(date) = 10", name="ck_activity_ledger_date"),
)
