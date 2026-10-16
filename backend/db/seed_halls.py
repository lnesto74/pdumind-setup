"""Import shipped data halls (racks, PDUs, layout) into the local database.

Runs once per seed file at startup. Halls, racks, and PDUs that already exist
are never modified; only missing ones are added. Passwords and SNMP keys are
not part of the seed — PDUs fall back to the default web login until edited.
"""
from __future__ import annotations

import json
import os
import sqlite3
from typing import Any, Dict

from db.persistence import DB_PATH, _db_lock

SEED_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "seed")


def _ensure_meta(conn: sqlite3.Connection) -> None:
    conn.execute("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)")


def _seed_applied(conn: sqlite3.Connection, seed_id: str) -> bool:
    row = conn.execute("SELECT 1 FROM app_meta WHERE key = ?", (f"seed:{seed_id}",)).fetchone()
    return row is not None


def _import_hall(conn: sqlite3.Connection, hall: Dict[str, Any]) -> Dict[str, int]:
    added = {"hall": 0, "racks": 0, "pdus": 0}
    row = conn.execute("SELECT id FROM halls WHERE name = ?", (hall["name"],)).fetchone()
    if row:
        hall_id = row[0]
    else:
        hall_id = conn.execute(
            "INSERT INTO halls (name, description) VALUES (?, ?)",
            (hall["name"], hall.get("description")),
        ).lastrowid
        added["hall"] = 1

    if hall.get("config") is not None:
        has_cfg = conn.execute("SELECT 1 FROM hall_configs WHERE hall_id = ?", (hall_id,)).fetchone()
        if not has_cfg:
            conn.execute(
                "INSERT INTO hall_configs (hall_id, config_json, version) VALUES (?, ?, 1)",
                (hall_id, json.dumps(hall["config"])),
            )

    rack_ids: Dict[str, int] = {
        code: rid for rid, code in conn.execute(
            "SELECT id, rack_code FROM racks WHERE hall_id = ?", (hall_id,)
        )
    }
    for r in hall.get("racks") or []:
        if r["rack_code"] in rack_ids:
            continue
        rack_ids[r["rack_code"]] = conn.execute(
            """INSERT INTO racks (hall_id, rack_code, row_index, position_index, x_m, y_m, z_m,
                   rotation_deg, width_mm, depth_mm, height_u, model, label, metadata_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                hall_id, r["rack_code"], r.get("row_index", 0), r.get("position_index", 0),
                r.get("x_m", 0), r.get("y_m", 0), r.get("z_m", 0), r.get("rotation_deg", 0),
                r.get("width_mm", 600), r.get("depth_mm", 1000), r.get("height_u", 42),
                r.get("model"), r.get("label"), r.get("metadata_json"),
            ),
        ).lastrowid
        added["racks"] += 1

    existing_ips = {
        ip for (ip,) in conn.execute("SELECT ip_address FROM pdus WHERE hall_id = ?", (hall_id,))
    }
    for p in hall.get("pdus") or []:
        if p["ip_address"] in existing_ips:
            continue
        meta = p.get("metadata")
        conn.execute(
            """INSERT INTO pdus (hall_id, rack_id, mount_position, ip_address, snmp_port, snmp_version,
                   snmp_community_ref, mac_address, hostname, label, location, metadata_json, is_active,
                   web_admin_port, web_admin_user, web_admin_pass, remote_host, web_admin_https)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                hall_id, rack_ids.get(p.get("rack_code") or ""), p.get("mount_position"),
                p["ip_address"], p.get("snmp_port") or 161, p.get("snmp_version"),
                p.get("snmp_community_ref"), p.get("mac_address"), p.get("hostname"),
                p.get("label"), p.get("location"), json.dumps(meta) if meta else None,
                1 if p.get("is_active", 1) else 0,
                p.get("web_admin_port"), p.get("web_admin_user"), None,
                p.get("remote_host"), p.get("web_admin_https"),
            ),
        )
        existing_ips.add(p["ip_address"])
        added["pdus"] += 1
    return added


def apply_shipped_halls() -> None:
    if not os.path.isdir(SEED_DIR):
        return
    for fname in sorted(os.listdir(SEED_DIR)):
        if not fname.endswith(".json"):
            continue
        path = os.path.join(SEED_DIR, fname)
        try:
            with open(path, encoding="utf-8") as f:
                seed = json.load(f)
        except Exception as e:
            print(f"[seed] skip {fname}: {e}")
            continue
        seed_id = seed.get("seed_id") or fname
        with _db_lock:
            conn = sqlite3.connect(DB_PATH)
            try:
                _ensure_meta(conn)
                if _seed_applied(conn, seed_id):
                    continue
                for hall in seed.get("halls") or []:
                    added = _import_hall(conn, hall)
                    print(
                        f"[seed] {hall['name']}: hall +{added['hall']}, "
                        f"racks +{added['racks']}, pdus +{added['pdus']}"
                    )
                conn.execute(
                    "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, datetime('now'))",
                    (f"seed:{seed_id}",),
                )
                conn.commit()
            except Exception as e:
                conn.rollback()
                print(f"[seed] {fname} failed, nothing imported: {e}")
            finally:
                conn.close()
