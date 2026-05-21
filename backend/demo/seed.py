"""Seed demo database with empty hall ready for batch commissioning."""
from __future__ import annotations

import json
import os

from demo.config import DEMO_DB_PATH, DEMO_HALL_NAME, DEMO_USERNAME, DEMO_PASSWORD, demo_enabled
from demo.context import activate_demo_db, deactivate_demo_db
from demo.simulator import reset_simulator_state, start_demo_poller


DEFAULT_HALL_CONFIG = {
    "hall": {"length": 20, "width": 12, "height": 3.5, "floorTileSize": 0.6},
    "layout": {
        "numberOfRows": 2,
        "racksPerRow": 4,
        "rowOrientation": "lengthwise",
        "aisleWidth": 1.2,
        "wallClearance": 1.5,
    },
    "rack": {"width": 600, "depth": 1000, "heightU": 42, "model": "Standard 42U"},
    "pdu": {"pdusPerRack": 1, "modelId": "DPDU-V3-C1308-10A", "mounting": "A/B"},
    "ipPlanning": {"subnet": "10.99.1.0/28", "assignmentStrategy": "sequential"},
}


def _ensure_demo_db_file() -> None:
    os.makedirs(os.path.dirname(DEMO_DB_PATH) or "data", exist_ok=True)
    activate_demo_db()
    from db.persistence import init_db
    init_db()
    deactivate_demo_db()


def seed_demo_hall(force: bool = False) -> int:
    """Create demo hall with layout. Returns hall_id."""
    activate_demo_db()
    try:
        from db import HallRepo
        from db.persistence import save_hall_state
        from db.persistence import _connect

        if force:
            conn = _connect()
            try:
                for table in ("telemetry", "events", "pdus", "racks", "hall_configs", "halls"):
                    try:
                        conn.execute(f"DELETE FROM {table}")
                    except Exception:
                        pass
                conn.commit()
            finally:
                conn.close()
            reset_simulator_state()

        halls = HallRepo.get_all()
        for h in halls:
            if h.get("name") == DEMO_HALL_NAME:
                if not force:
                    return h["id"]

        hall_id = HallRepo.create(DEMO_HALL_NAME, "Simulated Agoda cage — demo user only")

        # Generate minimal rack layout (8 racks for 8 PDUs)
        racks = []
        for i in range(8):
            row = i // 4
            col = i % 4
            rack_code = f"R{row + 1}{chr(65 + col)}"
            racks.append({
                "rack_code": rack_code,
                "row_index": row,
                "position_index": col,
                "x_m": 2 + col * 2.2,
                "y_m": 0,
                "z_m": 2 + row * 3.5,
                "width_mm": 600,
                "depth_mm": 1000,
                "height_u": 42,
                "model": "Standard 42U",
                "label": rack_code,
            })

        save_hall_state(hall_id, DEFAULT_HALL_CONFIG, racks, [])
        reset_simulator_state()
        start_demo_poller()
        print(f"[Demo] Seeded hall '{DEMO_HALL_NAME}' id={hall_id}")
        return hall_id
    finally:
        deactivate_demo_db()


def ensure_demo_user() -> None:
    """Create demo user with role=demo in the MAIN database (Mac local only)."""
    if not demo_enabled():
        return
    from auth import _hash_password
    from db.persistence import DB_PATH
    import sqlite3

    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin'")
        conn.commit()
    except Exception:
        pass

    cur = conn.execute("SELECT id FROM users WHERE username = ?", (DEMO_USERNAME,))
    row = cur.fetchone()
    pw = _hash_password(DEMO_PASSWORD)
    if row:
        conn.execute(
            "UPDATE users SET password_hash = ?, role = 'demo', display_name = 'Demo Presenter', is_active = 1, must_change_pw = 0 WHERE username = ?",
            (pw, DEMO_USERNAME),
        )
    else:
        conn.execute(
            "INSERT INTO users (username, password_hash, display_name, role, must_change_pw) VALUES (?, ?, ?, 'demo', 0)",
            (DEMO_USERNAME, pw, "Demo Presenter"),
        )
    conn.commit()
    conn.close()
    print(f"[Demo] User '{DEMO_USERNAME}' ready (password: {DEMO_PASSWORD})")


def setup_demo_environment(force_seed: bool = False) -> None:
    if not demo_enabled():
        return
    _ensure_demo_db_file()
    activate_demo_db()
    try:
        from db.persistence import init_db
        init_db()
    finally:
        deactivate_demo_db()
    ensure_demo_user()
    seed_demo_hall(force=force_seed)
