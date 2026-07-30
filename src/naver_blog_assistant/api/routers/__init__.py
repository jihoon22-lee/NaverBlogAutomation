"""Route registration modules kept separate from application composition."""

from naver_blog_assistant.api.routers.automation import register_automation_session_routes

__all__ = ["register_automation_session_routes"]
