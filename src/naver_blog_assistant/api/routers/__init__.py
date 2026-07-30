"""Route registration modules kept separate from application composition."""

from naver_blog_assistant.api.routers.automation import register_automation_session_routes
from naver_blog_assistant.api.routers.comments import register_comment_routes
from naver_blog_assistant.api.routers.settings import register_settings_routes
from naver_blog_assistant.api.routers.spa import (
    APP_MOUNT_PATH,
    register_app_mount,
    resolve_app_directory,
)

__all__ = [
    "APP_MOUNT_PATH",
    "register_app_mount",
    "register_automation_session_routes",
    "register_comment_routes",
    "register_settings_routes",
    "resolve_app_directory",
]
