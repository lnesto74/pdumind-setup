"""Thread-local demo DB routing and session detection."""
from __future__ import annotations

import threading
from typing import Optional

from flask import g, request

from demo.config import DEMO_DB_PATH, demo_enabled, is_demo_username

_tls = threading.local()


def activate_demo_db() -> None:
    _tls.db_path = DEMO_DB_PATH


def deactivate_demo_db() -> None:
    _tls.db_path = None


def get_active_db_path() -> Optional[str]:
    """Return demo DB path when demo context is active, else None (use default)."""
    return getattr(_tls, "db_path", None)


def set_demo_mode_flag(active: bool) -> None:
    _tls.demo_mode = active


def is_demo_mode_flag() -> bool:
    return bool(getattr(_tls, "demo_mode", False))


def _token_payload() -> Optional[dict]:
    from auth import _decode_token
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    return _decode_token(auth_header[7:])


def is_demo_session() -> bool:
    """True when demo env is on AND current JWT belongs to the demo user."""
    if not demo_enabled():
        return False
    payload = _token_payload()
    if not payload:
        return False
    if payload.get("demo_mode"):
        return True
    return is_demo_username(payload.get("username", ""))


def _is_localhost_viewer_request() -> bool:
    """Allow /view on this Mac to read demo DB without login (local demos only)."""
    if not demo_enabled() or request.method != "GET":
        return False
    host = (request.host or "").split(":")[0]
    if host not in ("localhost", "127.0.0.1"):
        return False
    path = request.path
    if path.endswith("/fleet-snapshot"):
        return True
    if path.startswith("/api/halls") and (path.endswith("/state") or path == "/api/halls/default"):
        return True
    if path.startswith("/api/pdus/by-ip/") and "/live" in path:
        return True
    if path.startswith("/api/polling/device/"):
        return True
    if path == "/api/hub/info":
        return True
    return False


def bind_request_context() -> None:
    """Call from Flask before_request — switches DB + g.demo_mode."""
    if request.path.startswith("/api/auth/"):
        deactivate_demo_db()
        g.demo_mode = False
        return
    if is_demo_session() or _is_localhost_viewer_request():
        activate_demo_db()
        set_demo_mode_flag(True)
        g.demo_mode = True
    else:
        deactivate_demo_db()
        set_demo_mode_flag(False)
        g.demo_mode = False
