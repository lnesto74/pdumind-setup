"""SQLite persistence layer for PDUMind telemetry.

Creates the full schema (see README) and exposes helper functions to:
    • ensure_pdu() – insert PDU row and outlets if missing
    • insert_*_telemetry() – write telemetry rows
    • store_poll_results() – convenience wrapper that ingests the poller
      snapshot dict produced by backend.app.poller and writes rows in one
      transaction.

Thread-safe via a global lock because sqlite3 connections are not inherently
thread-safe when shared across threads with `check_same_thread=False`.
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Dict

DB_PATH = os.getenv(
    "TELEMETRY_DB", os.path.join(os.getenv("DATA_DIR", "data"), "telemetry.db")
)
SCHEMA_SQL = """
-- PDU / Outlet reference tables ------------------------------------------------
CREATE TABLE IF NOT EXISTS pdu (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname     TEXT,
    ip_address   TEXT UNIQUE NOT NULL,
    location     TEXT,
    model        TEXT,
    install_date DATE
);

CREATE TABLE IF NOT EXISTS outlet (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    pdu_id        INTEGER NOT NULL REFERENCES pdu(id) ON DELETE CASCADE,
    outlet_number INTEGER NOT NULL,
    phase         INTEGER,
    rated_current_a REAL,
    UNIQUE (pdu_id, outlet_number)
);

-- Time-series tables -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS outlet_telemetry (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    outlet_id    INTEGER NOT NULL REFERENCES outlet(id) ON DELETE CASCADE,
    ts_utc       TEXT NOT NULL,
    state        TEXT CHECK(state IN ('on','off')),
    voltage_v    REAL,
    current_a    REAL,
    power_w      REAL,
    apparent_va  REAL,
    power_factor REAL,
    energy_kwh   REAL,
    temperature_c REAL,
    UNIQUE(outlet_id, ts_utc)
);
CREATE INDEX IF NOT EXISTS idx_outlet_ts ON outlet_telemetry(outlet_id, ts_utc DESC);

CREATE TABLE IF NOT EXISTS phase_telemetry (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    pdu_id       INTEGER NOT NULL REFERENCES pdu(id) ON DELETE CASCADE,
    phase        INTEGER NOT NULL,
    ts_utc       TEXT NOT NULL,
    voltage_v    REAL,
    current_a    REAL,
    power_w      REAL,
    apparent_va  REAL,
    power_factor REAL,
    energy_kwh   REAL,
    UNIQUE(pdu_id, phase, ts_utc)
);
CREATE INDEX IF NOT EXISTS idx_phase_ts ON phase_telemetry(pdu_id, phase, ts_utc DESC);

CREATE TABLE IF NOT EXISTS env_telemetry (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    pdu_id       INTEGER NOT NULL REFERENCES pdu(id) ON DELETE CASCADE,
    ts_utc       TEXT NOT NULL,
    temperature_c REAL,
    humidity_pct REAL,
    dewpoint_c   REAL,
    UNIQUE(pdu_id, ts_utc)
);

-- Events ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outlet_state_change (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    outlet_id  INTEGER NOT NULL REFERENCES outlet(id) ON DELETE CASCADE,
    ts_utc     TEXT NOT NULL,
    new_state  TEXT CHECK(new_state IN ('on','off'))
);

-- Predictive maintenance alerts ---------------------------------------------
CREATE TABLE IF NOT EXISTS maintenance_alert (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    outlet_id  INTEGER NOT NULL REFERENCES outlet(id) ON DELETE CASCADE,
    ts_utc     TEXT NOT NULL,
    type       TEXT,
    severity   REAL,
    message    TEXT
);
"""

_db_lock: Lock = Lock()


def _connect() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH, check_same_thread=False)


def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with _connect() as conn, _db_lock:
        conn.executescript(SCHEMA_SQL)
        conn.commit()


# ---------------------------------------------------------------------------
# Helpers to insert / fetch reference rows
# ---------------------------------------------------------------------------

def _get_utc_ts() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ensure_pdu(ip: str) -> int:
    """Return pdu.id for given IP, inserting (and default outlets) if absent."""
    with _connect() as conn, _db_lock:
        cur = conn.execute("SELECT id FROM pdu WHERE ip_address = ?", (ip,))
        row = cur.fetchone()
        if row:
            return row[0]
        # insert minimal PDU row
        cur = conn.execute(
            "INSERT INTO pdu(ip_address, hostname) VALUES (?, ?)", (ip, ip)
        )
        pdu_id = cur.lastrowid
        # create 24 outlets (1-24) by default
        conn.executemany(
            "INSERT INTO outlet(pdu_id, outlet_number) VALUES (?, ?)",
            [(pdu_id, i) for i in range(1, 25)],
        )
        conn.commit()
        return pdu_id


def _get_outlet_id(conn: sqlite3.Connection, pdu_id: int, number: int) -> int:
    cur = conn.execute(
        "SELECT id FROM outlet WHERE pdu_id = ? AND outlet_number = ?",
        (pdu_id, number),
    )
    row = cur.fetchone()
    if row:
        return row[0]
    cur = conn.execute(
        "INSERT INTO outlet(pdu_id, outlet_number) VALUES (?, ?)", (pdu_id, number)
    )
    return cur.lastrowid


# ---------------------------------------------------------------------------
# Insert telemetry rows
# ---------------------------------------------------------------------------

def insert_outlet_telemetry(
    pdu_id: int,
    number: int,
    ts: str,
    state: str | None,
    current_a: float | None,
    energy_kwh: float | None,
) -> None:
    with _connect() as conn, _db_lock:
        outlet_id = _get_outlet_id(conn, pdu_id, number)
        # latest state for change detection
        cur = conn.execute(
            "SELECT state FROM outlet_telemetry WHERE outlet_id = ? ORDER BY ts_utc DESC LIMIT 1",
            (outlet_id,),
        )
        prev = cur.fetchone()
        prev_state = prev[0] if prev else None
        conn.execute(
            """
            INSERT OR IGNORE INTO outlet_telemetry(
                outlet_id, ts_utc, state, current_a, energy_kwh)
            VALUES (?, ?, ?, ?, ?)""",
            (outlet_id, ts, state, current_a, energy_kwh),
        )
        # state change table
        if state and state.lower() in {"on", "off"} and state != prev_state:
            conn.execute(
                "INSERT INTO outlet_state_change(outlet_id, ts_utc, new_state) VALUES (?, ?, ?)",
                (outlet_id, ts, state.lower()),
            )
        conn.commit()


def insert_phase_telemetry(
    pdu_id: int,
    phase: int,
    ts: str,
    voltage_v: float | None,
    current_a: float | None,
    power_w: float | None,
    pf: float | None,
    energy_kwh: float | None,
) -> None:
    with _connect() as conn, _db_lock:
        conn.execute(
            """
            INSERT OR IGNORE INTO phase_telemetry(
                pdu_id, phase, ts_utc, voltage_v, current_a, power_w, power_factor, energy_kwh)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (pdu_id, phase, ts, voltage_v, current_a, power_w, pf, energy_kwh),
        )
        conn.commit()


def insert_env_telemetry(
    pdu_id: int,
    ts: str,
    temperature_c: float | None,
    humidity_pct: float | None,
) -> None:
    with _connect() as conn, _db_lock:
        conn.execute(
            """
            INSERT OR IGNORE INTO env_telemetry(
                pdu_id, ts_utc, temperature_c, humidity_pct)
            VALUES (?, ?, ?, ?)""",
            (pdu_id, ts, temperature_c, humidity_pct),
        )
        conn.commit()


# ---------------------------------------------------------------------------
# High-level ingestion helper for poller results
# ---------------------------------------------------------------------------

_P_OUTLET_STATUS = "Output{n}Status"
_P_OUTLET_CURRENT = "Output{n}Current"
_P_OUTLET_ENERGY = "Output{n}Energy"

_P_PHASE_VOLT = "VoltageP{p}"
_P_PHASE_CURR = "CurrentP{p}"
_P_PHASE_POWER = "PowerP{p}"
_P_PHASE_PF = "PFP{p}"
_P_PHASE_ENERGY = "EnergyP{p}"


def _to_float(v: Any) -> float | None:
    try:
        return float(str(v).replace("\"", "").replace(",", ".")) if v not in (None, "", "\"\"") else None
    except ValueError:
        return None


def store_poll_results(ip: str, results: Dict[str, Dict[str, Any]]) -> None:
    """Persist current poller snapshot to database."""
    if not results:
        return
    ts = _get_utc_ts()
    pdu_id = ensure_pdu(ip)

    # Flatten values map name -> raw_value
    val_map: dict[str, Any] = {k: v["value"] if isinstance(v, dict) and "value" in v else v for k, v in results.items()}

    # Insert per-outlet rows
    for n in range(1, 25):
        state_raw = val_map.get(_P_OUTLET_STATUS.format(n=n))
        state = str(state_raw).strip('"').lower() if state_raw is not None else None
        current = _to_float(val_map.get(_P_OUTLET_CURRENT.format(n=n)))
        energy = _to_float(val_map.get(_P_OUTLET_ENERGY.format(n=n)))
        if any(v is not None for v in (state, current, energy)):
            insert_outlet_telemetry(pdu_id, n, ts, state, current, energy)

    # Insert phase rows (1-3)
    for p in (1, 2, 3):
        v = _to_float(val_map.get(_P_PHASE_VOLT.format(p=p)))
        c = _to_float(val_map.get(_P_PHASE_CURR.format(p=p)))
        w = _to_float(val_map.get(_P_PHASE_POWER.format(p=p)))
        pf = _to_float(val_map.get(_P_PHASE_PF.format(p=p)))
        e = _to_float(val_map.get(_P_PHASE_ENERGY.format(p=p)))
        if any(x is not None for x in (v, c, w, e)):
            insert_phase_telemetry(pdu_id, p, ts, v, c, w, pf, e)

    # Environment (use first probes)
    temp = _to_float(val_map.get("Temperature1"))
    hum = _to_float(val_map.get("Humidity1"))
    if temp is not None or hum is not None:
        insert_env_telemetry(pdu_id, ts, temp, hum)
