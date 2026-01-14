"""PDUMind Persistence Layer - Full Database Operations

Provides repository classes for:
- HallRepo: Data hall configuration persistence
- RackRepo: Rack instances with 3D coordinates
- PDURepo: PDU instances and IP assignments
- TelemetryRepo: SNMP telemetry storage with full JSON payloads
- EventRepo: Warnings, alarms, and events
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Dict, List, Optional, Tuple

# Database path from environment or default
DB_PATH = os.getenv(
    "PDUMIND_DB", 
    os.path.join(os.getenv("DATA_DIR", "data"), "pdumind.db")
)

# Global lock for thread safety
_db_lock = Lock()

def _get_schema_path() -> str:
    return os.path.join(os.path.dirname(__file__), "schema.sql")

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def init_db() -> None:
    """Initialize database with schema. Idempotent."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    schema_path = _get_schema_path()
    
    with _db_lock:
        conn = _connect()
        try:
            with open(schema_path, "r") as f:
                conn.executescript(f.read())
            conn.commit()
            print(f"[DB] Initialized database at {DB_PATH}")
        finally:
            conn.close()


# =============================================================================
# HALL REPOSITORY
# =============================================================================

class HallRepo:
    """Repository for Data Hall configuration persistence."""
    
    @staticmethod
    def create(name: str, description: str = None) -> int:
        """Create a new hall. Returns hall_id."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute(
                    "INSERT INTO halls (name, description) VALUES (?, ?)",
                    (name, description)
                )
                conn.commit()
                return cur.lastrowid
            finally:
                conn.close()
    
    @staticmethod
    def get(hall_id: int) -> Optional[Dict[str, Any]]:
        """Get hall by ID."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute("SELECT * FROM halls WHERE id = ?", (hall_id,))
                row = cur.fetchone()
                return dict(row) if row else None
            finally:
                conn.close()
    
    @staticmethod
    def get_all() -> List[Dict[str, Any]]:
        """Get all halls."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute("SELECT * FROM halls ORDER BY created_at DESC")
                return [dict(row) for row in cur.fetchall()]
            finally:
                conn.close()
    
    @staticmethod
    def get_or_create_default() -> int:
        """Get default hall or create one if none exists."""
        halls = HallRepo.get_all()
        if halls:
            return halls[0]["id"]
        return HallRepo.create("Default Hall", "Auto-created default data hall")
    
    @staticmethod
    def save_config(hall_id: int, config: Dict[str, Any]) -> int:
        """Save hall configuration. Creates new version. Returns config_id."""
        with _db_lock:
            conn = _connect()
            try:
                # Get next version number
                cur = conn.execute(
                    "SELECT COALESCE(MAX(version), 0) + 1 FROM hall_configs WHERE hall_id = ?",
                    (hall_id,)
                )
                version = cur.fetchone()[0]
                
                cur = conn.execute(
                    "INSERT INTO hall_configs (hall_id, config_json, version) VALUES (?, ?, ?)",
                    (hall_id, json.dumps(config), version)
                )
                
                # Update hall timestamp
                conn.execute(
                    "UPDATE halls SET updated_at = ? WHERE id = ?",
                    (_utc_now(), hall_id)
                )
                conn.commit()
                return cur.lastrowid
            finally:
                conn.close()
    
    @staticmethod
    def get_latest_config(hall_id: int) -> Optional[Dict[str, Any]]:
        """Get latest configuration for a hall."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute(
                    """SELECT * FROM hall_configs 
                       WHERE hall_id = ? 
                       ORDER BY version DESC LIMIT 1""",
                    (hall_id,)
                )
                row = cur.fetchone()
                if row:
                    result = dict(row)
                    result["config"] = json.loads(result["config_json"])
                    return result
                return None
            finally:
                conn.close()
    
    @staticmethod
    def get_full_state(hall_id: int) -> Optional[Dict[str, Any]]:
        """Get complete hall state including config, racks, and PDUs."""
        hall = HallRepo.get(hall_id)
        if not hall:
            return None
        
        config_row = HallRepo.get_latest_config(hall_id)
        racks = RackRepo.get_by_hall(hall_id)
        pdus = PDURepo.get_by_hall(hall_id)
        
        return {
            "hall": hall,
            "config": config_row["config"] if config_row else None,
            "config_version": config_row["version"] if config_row else 0,
            "racks": racks,
            "pdus": pdus
        }


# =============================================================================
# RACK REPOSITORY
# =============================================================================

class RackRepo:
    """Repository for rack instances."""
    
    @staticmethod
    def upsert(hall_id: int, rack_code: str, data: Dict[str, Any]) -> int:
        """Insert or update a rack. Returns rack_id."""
        with _db_lock:
            conn = _connect()
            try:
                # Check if exists
                cur = conn.execute(
                    "SELECT id FROM racks WHERE hall_id = ? AND rack_code = ?",
                    (hall_id, rack_code)
                )
                existing = cur.fetchone()
                
                if existing:
                    # Update
                    conn.execute(
                        """UPDATE racks SET 
                           row_index = ?, position_index = ?,
                           x_m = ?, y_m = ?, z_m = ?,
                           rotation_deg = ?, width_mm = ?, depth_mm = ?, height_u = ?,
                           model = ?, label = ?, metadata_json = ?, updated_at = ?
                           WHERE id = ?""",
                        (
                            data.get("row_index", 0),
                            data.get("position_index", 0),
                            data.get("x_m", 0),
                            data.get("y_m", 0),
                            data.get("z_m", 0),
                            data.get("rotation_deg", 0),
                            data.get("width_mm", 600),
                            data.get("depth_mm", 1000),
                            data.get("height_u", 42),
                            data.get("model"),
                            data.get("label"),
                            json.dumps(data.get("metadata")) if data.get("metadata") else None,
                            _utc_now(),
                            existing["id"]
                        )
                    )
                    conn.commit()
                    return existing["id"]
                else:
                    # Insert
                    cur = conn.execute(
                        """INSERT INTO racks 
                           (hall_id, rack_code, row_index, position_index,
                            x_m, y_m, z_m, rotation_deg,
                            width_mm, depth_mm, height_u, model, label, metadata_json)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            hall_id,
                            rack_code,
                            data.get("row_index", 0),
                            data.get("position_index", 0),
                            data.get("x_m", 0),
                            data.get("y_m", 0),
                            data.get("z_m", 0),
                            data.get("rotation_deg", 0),
                            data.get("width_mm", 600),
                            data.get("depth_mm", 1000),
                            data.get("height_u", 42),
                            data.get("model"),
                            data.get("label"),
                            json.dumps(data.get("metadata")) if data.get("metadata") else None
                        )
                    )
                    conn.commit()
                    return cur.lastrowid
            finally:
                conn.close()
    
    @staticmethod
    def get_by_hall(hall_id: int) -> List[Dict[str, Any]]:
        """Get all racks in a hall."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute(
                    """SELECT * FROM racks WHERE hall_id = ? 
                       ORDER BY row_index, position_index""",
                    (hall_id,)
                )
                return [dict(row) for row in cur.fetchall()]
            finally:
                conn.close()
    
    @staticmethod
    def get(rack_id: int) -> Optional[Dict[str, Any]]:
        """Get rack by ID."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute("SELECT * FROM racks WHERE id = ?", (rack_id,))
                row = cur.fetchone()
                return dict(row) if row else None
            finally:
                conn.close()
    
    @staticmethod
    def delete_by_hall(hall_id: int) -> int:
        """Delete all racks in a hall. Returns count deleted."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute("DELETE FROM racks WHERE hall_id = ?", (hall_id,))
                conn.commit()
                return cur.rowcount
            finally:
                conn.close()


# =============================================================================
# PDU REPOSITORY
# =============================================================================

class PDURepo:
    """Repository for PDU instances."""
    
    @staticmethod
    def upsert(hall_id: int, ip_address: str, data: Dict[str, Any]) -> int:
        """Insert or update a PDU by IP address. Returns pdu_id."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute(
                    "SELECT id FROM pdus WHERE ip_address = ?",
                    (ip_address,)
                )
                existing = cur.fetchone()
                
                if existing:
                    conn.execute(
                        """UPDATE pdus SET 
                           hall_id = ?, rack_id = ?, pdu_model_id = ?,
                           mount_position = ?, snmp_port = ?, snmp_version = ?,
                           snmp_community_ref = ?, mac_address = ?, hostname = ?,
                           label = ?, location = ?, metadata_json = ?,
                           is_active = ?, updated_at = ?
                           WHERE id = ?""",
                        (
                            hall_id,
                            data.get("rack_id"),
                            data.get("pdu_model_id"),
                            data.get("mount_position", "A"),
                            data.get("snmp_port", 161),
                            data.get("snmp_version", "2c"),
                            data.get("snmp_community_ref"),
                            data.get("mac_address"),
                            data.get("hostname"),
                            data.get("label"),
                            data.get("location"),
                            json.dumps(data.get("metadata")) if data.get("metadata") else None,
                            1 if data.get("is_active", True) else 0,
                            _utc_now(),
                            existing["id"]
                        )
                    )
                    conn.commit()
                    return existing["id"]
                else:
                    cur = conn.execute(
                        """INSERT INTO pdus 
                           (hall_id, rack_id, pdu_model_id, mount_position, ip_address,
                            snmp_port, snmp_version, snmp_community_ref, mac_address,
                            hostname, label, location, metadata_json, is_active)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            hall_id,
                            data.get("rack_id"),
                            data.get("pdu_model_id"),
                            data.get("mount_position", "A"),
                            ip_address,
                            data.get("snmp_port", 161),
                            data.get("snmp_version", "2c"),
                            data.get("snmp_community_ref"),
                            data.get("mac_address"),
                            data.get("hostname"),
                            data.get("label"),
                            data.get("location"),
                            json.dumps(data.get("metadata")) if data.get("metadata") else None,
                            1 if data.get("is_active", True) else 0
                        )
                    )
                    conn.commit()
                    return cur.lastrowid
            finally:
                conn.close()
    
    @staticmethod
    def get_by_ip(ip_address: str) -> Optional[Dict[str, Any]]:
        """Get PDU by IP address."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute(
                    "SELECT * FROM pdus WHERE ip_address = ?", (ip_address,)
                )
                row = cur.fetchone()
                return dict(row) if row else None
            finally:
                conn.close()
    
    @staticmethod
    def get_by_hall(hall_id: int) -> List[Dict[str, Any]]:
        """Get all PDUs in a hall."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute(
                    """SELECT p.*, r.rack_code 
                       FROM pdus p
                       LEFT JOIN racks r ON p.rack_id = r.id
                       WHERE p.hall_id = ? AND p.is_active = 1
                       ORDER BY r.row_index, r.position_index, p.mount_position""",
                    (hall_id,)
                )
                return [dict(row) for row in cur.fetchall()]
            finally:
                conn.close()
    
    @staticmethod
    def get(pdu_id: int) -> Optional[Dict[str, Any]]:
        """Get PDU by ID."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute("SELECT * FROM pdus WHERE id = ?", (pdu_id,))
                row = cur.fetchone()
                return dict(row) if row else None
            finally:
                conn.close()
    
    @staticmethod
    def ensure_outlets(pdu_id: int, count: int = 24) -> None:
        """Ensure outlets exist for a PDU."""
        with _db_lock:
            conn = _connect()
            try:
                for n in range(1, count + 1):
                    conn.execute(
                        """INSERT OR IGNORE INTO outlets (pdu_id, outlet_number) 
                           VALUES (?, ?)""",
                        (pdu_id, n)
                    )
                conn.commit()
            finally:
                conn.close()


# =============================================================================
# TELEMETRY REPOSITORY
# =============================================================================

class TelemetryRepo:
    """Repository for telemetry data."""
    
    @staticmethod
    def insert_raw(pdu_id: int, payload: Dict[str, Any], 
                   duration_ms: int = None, status: str = "ok",
                   error_msg: str = None) -> int:
        """Insert raw telemetry with full JSON payload."""
        ts = _utc_now()
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute(
                    """INSERT INTO telemetry 
                       (pdu_id, ts_utc, payload_json, poll_duration_ms, status, error_message)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (pdu_id, ts, json.dumps(payload), duration_ms, status, error_msg)
                )
                conn.commit()
                return cur.lastrowid
            finally:
                conn.close()
    
    @staticmethod
    def get_latest(pdu_id: int) -> Optional[Dict[str, Any]]:
        """Get latest telemetry for a PDU."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute(
                    """SELECT * FROM telemetry 
                       WHERE pdu_id = ? 
                       ORDER BY ts_utc DESC LIMIT 1""",
                    (pdu_id,)
                )
                row = cur.fetchone()
                if row:
                    result = dict(row)
                    result["payload"] = json.loads(result["payload_json"])
                    return result
                return None
            finally:
                conn.close()
    
    @staticmethod
    def get_history(pdu_id: int, from_ts: str = None, to_ts: str = None,
                    limit: int = 1000) -> List[Dict[str, Any]]:
        """Get telemetry history for a PDU within time range."""
        with _db_lock:
            conn = _connect()
            try:
                query = "SELECT * FROM telemetry WHERE pdu_id = ?"
                params = [pdu_id]
                
                if from_ts:
                    query += " AND ts_utc >= ?"
                    params.append(from_ts)
                if to_ts:
                    query += " AND ts_utc <= ?"
                    params.append(to_ts)
                
                query += " ORDER BY ts_utc DESC LIMIT ?"
                params.append(limit)
                
                cur = conn.execute(query, params)
                results = []
                for row in cur.fetchall():
                    r = dict(row)
                    r["payload"] = json.loads(r["payload_json"])
                    results.append(r)
                return results
            finally:
                conn.close()
    
    @staticmethod
    def insert_outlet_telemetry(outlet_id: int, ts: str, data: Dict[str, Any]) -> None:
        """Insert parsed outlet telemetry."""
        with _db_lock:
            conn = _connect()
            try:
                conn.execute(
                    """INSERT OR REPLACE INTO outlet_telemetry
                       (outlet_id, ts_utc, state, voltage_v, current_a, power_w,
                        apparent_va, power_factor, energy_kwh, temperature_c)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        outlet_id, ts,
                        data.get("state"),
                        data.get("voltage_v"),
                        data.get("current_a"),
                        data.get("power_w"),
                        data.get("apparent_va"),
                        data.get("power_factor"),
                        data.get("energy_kwh"),
                        data.get("temperature_c")
                    )
                )
                conn.commit()
            finally:
                conn.close()


# =============================================================================
# EVENT REPOSITORY
# =============================================================================

class EventRepo:
    """Repository for events, warnings, and alarms."""
    
    @staticmethod
    def create(event_type: str, title: str, severity: str = "warning",
               message: str = None, hall_id: int = None, rack_id: int = None,
               pdu_id: int = None, metadata: Dict[str, Any] = None) -> int:
        """Create a new event. Returns event_id."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute(
                    """INSERT INTO events 
                       (hall_id, rack_id, pdu_id, severity, event_type, title, message, metadata_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        hall_id, rack_id, pdu_id,
                        severity, event_type, title, message,
                        json.dumps(metadata) if metadata else None
                    )
                )
                conn.commit()
                return cur.lastrowid
            finally:
                conn.close()
    
    @staticmethod
    def get_active(pdu_id: int = None, hall_id: int = None) -> List[Dict[str, Any]]:
        """Get active events, optionally filtered by PDU or hall."""
        with _db_lock:
            conn = _connect()
            try:
                query = "SELECT * FROM events WHERE status = 'active'"
                params = []
                
                if pdu_id:
                    query += " AND pdu_id = ?"
                    params.append(pdu_id)
                if hall_id:
                    query += " AND hall_id = ?"
                    params.append(hall_id)
                
                query += " ORDER BY created_at DESC"
                cur = conn.execute(query, params)
                
                results = []
                for row in cur.fetchall():
                    r = dict(row)
                    if r.get("metadata_json"):
                        r["metadata"] = json.loads(r["metadata_json"])
                    results.append(r)
                return results
            finally:
                conn.close()
    
    @staticmethod
    def clear(event_id: int) -> None:
        """Clear an event (mark as resolved)."""
        with _db_lock:
            conn = _connect()
            try:
                conn.execute(
                    "UPDATE events SET status = 'cleared', cleared_at = ? WHERE id = ?",
                    (_utc_now(), event_id)
                )
                conn.commit()
            finally:
                conn.close()
    
    @staticmethod
    def acknowledge(event_id: int, acknowledged_by: str = None) -> None:
        """Acknowledge an event."""
        with _db_lock:
            conn = _connect()
            try:
                conn.execute(
                    """UPDATE events SET 
                       status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?
                       WHERE id = ?""",
                    (_utc_now(), acknowledged_by, event_id)
                )
                conn.commit()
            finally:
                conn.close()
    
    @staticmethod
    def clear_by_type(pdu_id: int, event_type: str) -> int:
        """Clear all active events of a type for a PDU. Returns count cleared."""
        with _db_lock:
            conn = _connect()
            try:
                cur = conn.execute(
                    """UPDATE events SET status = 'cleared', cleared_at = ?
                       WHERE pdu_id = ? AND event_type = ? AND status = 'active'""",
                    (_utc_now(), pdu_id, event_type)
                )
                conn.commit()
                return cur.rowcount
            finally:
                conn.close()
    
    @staticmethod
    def get_history(limit: int = 100, offset: int = 0,
                    status: str = None) -> List[Dict[str, Any]]:
        """Get event history."""
        with _db_lock:
            conn = _connect()
            try:
                query = "SELECT * FROM events"
                params = []
                
                if status:
                    query += " WHERE status = ?"
                    params.append(status)
                
                query += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
                params.extend([limit, offset])
                
                cur = conn.execute(query, params)
                results = []
                for row in cur.fetchall():
                    r = dict(row)
                    if r.get("metadata_json"):
                        r["metadata"] = json.loads(r["metadata_json"])
                    results.append(r)
                return results
            finally:
                conn.close()


# =============================================================================
# HIGH-LEVEL OPERATIONS
# =============================================================================

def save_hall_state(hall_id: int, config: Dict[str, Any], 
                    racks: List[Dict[str, Any]], pdus: List[Dict[str, Any]]) -> None:
    """Save complete hall state in a transaction."""
    # Save config
    HallRepo.save_config(hall_id, config)
    
    # Upsert racks
    rack_id_map = {}
    for rack in racks:
        rack_id = RackRepo.upsert(hall_id, rack["rack_code"], rack)
        rack_id_map[rack["rack_code"]] = rack_id
    
    # Upsert PDUs with rack references
    for pdu in pdus:
        rack_code = pdu.get("rack_code")
        pdu_data = {**pdu}
        if rack_code and rack_code in rack_id_map:
            pdu_data["rack_id"] = rack_id_map[rack_code]
        PDURepo.upsert(hall_id, pdu["ip_address"], pdu_data)


def store_poll_snapshot(ip_address: str, results: Dict[str, Any], 
                        duration_ms: int = None) -> None:
    """Store a complete poll snapshot. Creates PDU if needed."""
    # Get or create PDU
    pdu = PDURepo.get_by_ip(ip_address)
    if not pdu:
        hall_id = HallRepo.get_or_create_default()
        pdu_id = PDURepo.upsert(hall_id, ip_address, {"mount_position": "A"})
        PDURepo.ensure_outlets(pdu_id, 24)
    else:
        pdu_id = pdu["id"]
    
    # Flatten results to simple dict
    payload = {}
    for name, data in results.items():
        if isinstance(data, dict) and "value" in data:
            payload[name] = data["value"]
        else:
            payload[name] = data
    
    # Check for errors
    has_errors = any(
        v is None or (isinstance(v, str) and "Error" in v)
        for v in payload.values()
    )
    status = "partial" if has_errors else "ok"
    
    # Insert raw telemetry
    TelemetryRepo.insert_raw(pdu_id, payload, duration_ms, status)
