"""HTTP routers grouped by responsibility."""

from naver_blog_assistant.api.routers.automation import register_automation_session_routes
from naver_blog_assistant.api.routers.comments import register_comment_routes
from naver_blog_assistant.api.routers.engagement import register_engagement_routes
from naver_blog_assistant.api.routers.llm import register_llm_routes
from naver_blog_assistant.api.routers.settings import register_settings_routes
from naver_blog_assistant.api.routers.spa import register_app_mount

__all__ = [
    "register_app_mount",
    "register_automation_session_routes",
    "register_comment_routes",
    "register_engagement_routes",
    "register_llm_routes",
    "register_settings_routes",
]
