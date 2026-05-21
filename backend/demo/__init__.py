"""Mac-only demo simulation — gated by PDUMIND_DEMO_ENABLED + demo user login."""

from demo.config import demo_enabled
from demo.context import is_demo_session, activate_demo_db, deactivate_demo_db
from demo.routes import register_demo_routes

__all__ = [
    "demo_enabled",
    "is_demo_session",
    "activate_demo_db",
    "deactivate_demo_db",
    "register_demo_routes",
]
