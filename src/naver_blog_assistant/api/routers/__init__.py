"""HTTP routers grouped by responsibility."""

from naver_blog_assistant.api.routers.automation import register_automation_session_routes
from naver_blog_assistant.api.routers.blog import register_blog_routes
from naver_blog_assistant.api.routers.comments import register_comment_routes
from naver_blog_assistant.api.routers.drafts import register_draft_routes
from naver_blog_assistant.api.routers.engagement import register_engagement_routes
from naver_blog_assistant.api.routers.llm import register_llm_routes
from naver_blog_assistant.api.routers.remote import register_remote_access_routes
from naver_blog_assistant.api.routers.runtime_configuration import (
    register_runtime_configuration_routes,
)
from naver_blog_assistant.api.routers.runtime_data import register_runtime_data_routes
from naver_blog_assistant.api.routers.sessions import register_session_routes
from naver_blog_assistant.api.routers.settings import register_settings_routes
from naver_blog_assistant.api.routers.spa import register_app_mount
from naver_blog_assistant.api.routers.staging import register_staging_routes

__all__ = [
    "register_app_mount",
    "register_automation_session_routes",
    "register_blog_routes",
    "register_comment_routes",
    "register_draft_routes",
    "register_engagement_routes",
    "register_llm_routes",
    "register_remote_access_routes",
    "register_runtime_configuration_routes",
    "register_runtime_data_routes",
    "register_session_routes",
    "register_settings_routes",
    "register_staging_routes",
]
