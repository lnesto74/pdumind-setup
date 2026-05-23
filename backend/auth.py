"""Authentication module — local user auth with JWT tokens and access logging."""
from __future__ import annotations

import os
import re
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from functools import wraps
from typing import Any, Dict, Optional

_USERNAME_RE = re.compile(r"^[a-zA-Z0-9._-]{3,32}$")

import bcrypt
import jwt
from flask import request, jsonify, g

JWT_SECRET = os.getenv("JWT_SECRET", "pdumind-local-secret-change-in-production")
JWT_EXPIRY_HOURS = int(os.getenv("JWT_EXPIRY_HOURS", "24"))
DEFAULT_ADMIN_USER = "admin"
DEFAULT_ADMIN_PASS = "admin"


def _get_db() -> sqlite3.Connection:
    """Auth always uses the main database (never the demo sandbox)."""
    from db.persistence import DB_PATH
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _check_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def _validate_username(username: str) -> Optional[str]:
    if not username:
        return "Username is required"
    if not _USERNAME_RE.match(username):
        return "Username must be 3-32 characters (letters, numbers, . _ -)"
    return None


def _fetch_user_row(conn: sqlite3.Connection, user_id: int) -> Optional[Dict[str, Any]]:
    cur = conn.execute(
        "SELECT id, username, password_hash, display_name, must_change_pw, is_active, role FROM users WHERE id = ?",
        (user_id,),
    )
    row = cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0], "username": row[1], "password_hash": row[2],
        "display_name": row[3], "must_change_pw": row[4], "is_active": row[5],
        "role": row[6] or "admin",
    }


def _user_response(user: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "must_change_pw": bool(user["must_change_pw"]),
        "demo_mode": user.get("role") == "demo",
        "role": user.get("role", "admin"),
    }


def _generate_token(user: Dict[str, Any]) -> str:
    payload = {
        "user_id": user["id"],
        "username": user["username"],
        "display_name": user.get("display_name", ""),
        "demo_mode": user.get("role") == "demo",
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRY_HOURS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def _decode_token(token: str) -> Optional[Dict]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def ensure_default_admin():
    """Create the default admin user if no users exist."""
    conn = _get_db()
    cur = conn.execute("SELECT COUNT(*) FROM users")
    count = cur.fetchone()[0]
    if count == 0:
        pw_hash = _hash_password(DEFAULT_ADMIN_PASS)
        conn.execute(
            "INSERT INTO users (username, password_hash, display_name, must_change_pw) VALUES (?, ?, ?, ?)",
            (DEFAULT_ADMIN_USER, pw_hash, "Administrator", 1),
        )
        conn.commit()
        print(f"[Auth] Created default admin user (username: {DEFAULT_ADMIN_USER})")


def _log_access(user_id: Optional[int], username: str, action: str):
    """Record an access log entry."""
    try:
        conn = _get_db()
        ip = request.remote_addr or "unknown"
        ua = request.headers.get("User-Agent", "")[:200]
        conn.execute(
            "INSERT INTO access_log (user_id, username, action, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)",
            (user_id, username, action, ip, ua),
        )
        conn.commit()
    except Exception as e:
        print(f"[Auth] Failed to log access: {e}")


def require_auth(f):
    """Flask route decorator that requires a valid JWT token."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"error": "Authentication required"}), 401
        token = auth_header[7:]
        payload = _decode_token(token)
        if not payload:
            return jsonify({"error": "Invalid or expired token"}), 401
        g.current_user = payload
        return f(*args, **kwargs)
    return decorated


def register_auth_routes(app):
    """Register all /api/auth/* routes on the Flask app."""

    @app.route("/api/auth/login", methods=["POST"])
    def auth_login():
        data = request.get_json(force=True) if request.data else {}
        username = data.get("username", "").strip()
        password = data.get("password", "")

        if not username or not password:
            return jsonify({"error": "Username and password required"}), 400

        conn = _get_db()
        cur = conn.execute(
            "SELECT id, username, password_hash, display_name, must_change_pw, is_active, role FROM users WHERE username = ?",
            (username,),
        )
        row = cur.fetchone()
        if not row:
            _log_access(None, username, "login_failed")
            return jsonify({"error": "Invalid credentials"}), 401

        user = {
            "id": row[0], "username": row[1], "password_hash": row[2],
            "display_name": row[3], "must_change_pw": row[4], "is_active": row[5],
            "role": row[6] or "admin",
        }

        if not user["is_active"]:
            _log_access(user["id"], username, "login_blocked_inactive")
            return jsonify({"error": "Account is disabled"}), 403

        if not _check_password(password, user["password_hash"]):
            _log_access(user["id"], username, "login_failed")
            return jsonify({"error": "Invalid credentials"}), 401

        token = _generate_token(user)
        _log_access(user["id"], username, "login")

        return jsonify({
            "success": True,
            "token": token,
            "user": {
                "id": user["id"],
                "username": user["username"],
                "display_name": user["display_name"],
                "must_change_pw": bool(user["must_change_pw"]),
                "demo_mode": user.get("role") == "demo",
                "role": user.get("role", "admin"),
            },
        })

    @app.route("/api/auth/logout", methods=["POST"])
    @require_auth
    def auth_logout():
        _log_access(g.current_user["user_id"], g.current_user["username"], "logout")
        return jsonify({"success": True})

    @app.route("/api/auth/me", methods=["GET"])
    @require_auth
    def auth_me():
        conn = _get_db()
        cur = conn.execute(
            "SELECT id, username, display_name, must_change_pw, role FROM users WHERE id = ?",
            (g.current_user["user_id"],),
        )
        row = cur.fetchone()
        if not row:
            return jsonify({"error": "User not found"}), 404
        return jsonify({
            "user": {
                "id": row[0], "username": row[1],
                "display_name": row[2], "must_change_pw": bool(row[3]),
                "demo_mode": (row[4] or "admin") == "demo",
                "role": row[4] or "admin",
            }
        })

    @app.route("/api/auth/change-password", methods=["POST"])
    @require_auth
    def auth_change_password():
        data = request.get_json(force=True) if request.data else {}
        current_pw = data.get("current_password", "")
        new_pw = data.get("new_password", "")

        if not new_pw or len(new_pw) < 4:
            return jsonify({"error": "New password must be at least 4 characters"}), 400

        conn = _get_db()
        cur = conn.execute("SELECT password_hash FROM users WHERE id = ?", (g.current_user["user_id"],))
        row = cur.fetchone()
        if not row or not _check_password(current_pw, row[0]):
            return jsonify({"error": "Current password is incorrect"}), 401

        new_hash = _hash_password(new_pw)
        conn.execute(
            "UPDATE users SET password_hash = ?, must_change_pw = 0, updated_at = datetime('now') WHERE id = ?",
            (new_hash, g.current_user["user_id"]),
        )
        conn.commit()
        _log_access(g.current_user["user_id"], g.current_user["username"], "password_changed")
        return jsonify({"success": True})

    @app.route("/api/auth/complete-setup", methods=["POST"])
    @require_auth
    def auth_complete_setup():
        """First-login flow: set username and password before entering the app."""
        data = request.get_json(force=True) if request.data else {}
        current_pw = data.get("current_password", "")
        new_username = data.get("new_username", "").strip()
        new_pw = data.get("new_password", "")

        conn = _get_db()
        user = _fetch_user_row(conn, g.current_user["user_id"])
        if not user:
            return jsonify({"error": "User not found"}), 404
        if not user["must_change_pw"]:
            return jsonify({"error": "Account setup already completed"}), 400
        if not _check_password(current_pw, user["password_hash"]):
            return jsonify({"error": "Current password is incorrect"}), 401
        if not new_pw or len(new_pw) < 4:
            return jsonify({"error": "New password must be at least 4 characters"}), 400

        new_username = new_username or user["username"]
        username_err = _validate_username(new_username)
        if username_err:
            return jsonify({"error": username_err}), 400

        if new_username != user["username"]:
            existing = conn.execute(
                "SELECT id FROM users WHERE username = ? AND id != ?",
                (new_username, user["id"]),
            ).fetchone()
            if existing:
                return jsonify({"error": "Username already exists"}), 409

        display_name = user["display_name"]
        if not display_name or display_name == user["username"] or display_name == "Administrator":
            display_name = new_username

        new_hash = _hash_password(new_pw)
        conn.execute(
            """UPDATE users SET username = ?, password_hash = ?, display_name = ?,
               must_change_pw = 0, updated_at = datetime('now') WHERE id = ?""",
            (new_username, new_hash, display_name, user["id"]),
        )
        conn.commit()

        user["username"] = new_username
        user["display_name"] = display_name
        user["password_hash"] = new_hash
        user["must_change_pw"] = 0

        token = _generate_token(user)
        _log_access(user["id"], new_username, "account_setup_completed")
        if new_username != g.current_user["username"]:
            _log_access(user["id"], new_username, f"username_changed:{g.current_user['username']}->{new_username}")

        return jsonify({
            "success": True,
            "token": token,
            "user": _user_response(user),
        })

    @app.route("/api/auth/users", methods=["GET"])
    @require_auth
    def auth_list_users():
        conn = _get_db()
        cur = conn.execute("SELECT id, username, display_name, is_active, created_at FROM users ORDER BY id")
        users = [{"id": r[0], "username": r[1], "display_name": r[2], "is_active": bool(r[3]), "created_at": r[4]} for r in cur.fetchall()]
        return jsonify({"users": users})

    @app.route("/api/auth/users", methods=["POST"])
    @require_auth
    def auth_create_user():
        data = request.get_json(force=True) if request.data else {}
        username = data.get("username", "").strip()
        password = data.get("password", "")
        display_name = data.get("display_name", "").strip() or username

        if not username or not password:
            return jsonify({"error": "Username and password required"}), 400

        username_err = _validate_username(username)
        if username_err:
            return jsonify({"error": username_err}), 400

        conn = _get_db()
        existing = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if existing:
            return jsonify({"error": "Username already exists"}), 409

        pw_hash = _hash_password(password)
        conn.execute(
            "INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)",
            (username, pw_hash, display_name),
        )
        conn.commit()
        _log_access(g.current_user["user_id"], g.current_user["username"], f"created_user:{username}")
        return jsonify({"success": True})

    @app.route("/api/auth/users/<int:user_id>", methods=["PUT"])
    @require_auth
    def auth_update_user(user_id: int):
        data = request.get_json(force=True) if request.data else {}
        username = data.get("username", "").strip()
        display_name = data.get("display_name", "").strip()
        password = data.get("password", "")

        conn = _get_db()
        cur = conn.execute(
            "SELECT id, username, display_name, role FROM users WHERE id = ?",
            (user_id,),
        )
        row = cur.fetchone()
        if not row:
            return jsonify({"error": "User not found"}), 404

        old_username = row[1]
        updates = []
        params = []

        if username and username != old_username:
            username_err = _validate_username(username)
            if username_err:
                return jsonify({"error": username_err}), 400
            existing = conn.execute(
                "SELECT id FROM users WHERE username = ? AND id != ?",
                (username, user_id),
            ).fetchone()
            if existing:
                return jsonify({"error": "Username already exists"}), 409
            updates.append("username = ?")
            params.append(username)

        if display_name:
            updates.append("display_name = ?")
            params.append(display_name)

        if password:
            if len(password) < 4:
                return jsonify({"error": "Password must be at least 4 characters"}), 400
            updates.append("password_hash = ?")
            params.append(_hash_password(password))

        if not updates:
            return jsonify({"error": "No changes provided"}), 400

        updates.append("updated_at = datetime('now')")
        params.append(user_id)
        conn.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()

        new_username = username or old_username
        action = f"updated_user:{old_username}"
        if username and username != old_username:
            action = f"username_changed:{old_username}->{new_username}"
        if password:
            action += ":password_reset"
        _log_access(g.current_user["user_id"], g.current_user["username"], action)
        return jsonify({"success": True})

    @app.route("/api/auth/users/<int:user_id>", methods=["DELETE"])
    @require_auth
    def auth_delete_user(user_id: int):
        if user_id == g.current_user["user_id"]:
            return jsonify({"error": "Cannot delete your own account"}), 400

        conn = _get_db()
        cur = conn.execute("SELECT username FROM users WHERE id = ?", (user_id,))
        row = cur.fetchone()
        if not row:
            return jsonify({"error": "User not found"}), 404

        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        _log_access(g.current_user["user_id"], g.current_user["username"], f"deleted_user:{row[0]}")
        return jsonify({"success": True})

    @app.route("/api/auth/access-log", methods=["GET"])
    @require_auth
    def auth_access_log():
        limit = min(int(request.args.get("limit", 100)), 500)
        conn = _get_db()
        cur = conn.execute(
            "SELECT id, username, action, ip_address, created_at FROM access_log ORDER BY created_at DESC LIMIT ?",
            (limit,),
        )
        logs = [{"id": r[0], "username": r[1], "action": r[2], "ip": r[3], "timestamp": r[4]} for r in cur.fetchall()]
        return jsonify({"logs": logs})
