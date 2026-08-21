"""Record a production hall (layout + recorded telemetry) and replay it in the demo session.

Two halves:

  CAPTURE (runs against the MAIN db, admin session):
    build_snapshot(hall_id) -> bundle dict   # hall + config + racks + pdus + telemetry frames
    save_snapshot(bundle)   -> writes data/snapshots/<name>-<ts>.json
    list_snapshots()        -> [{filename, ...}]

  REPLAY (runs in the demo session, against the DEMO db):
    load_bundle(bundle)     -> restores the hall into the demo db + arms the in-memory replayer
    get_live(ip) / get_poll_status(ip) / get_fleet_telemetry()
                            -> serve the recorded telemetry, looping over the recording window
    stop() / status()

The recorded telemetry is also written into the demo db `telemetry` table (timestamps
shifted so the recording ends "now"), so the existing /telemetry/chart and /latest
endpoints render the real curves without any extra interception.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Any, Dict, List, Optional

SNAPSHOT_DIR = os.path.join(os.getenv("DATA_DIR", "data"), "snapshots")

_lock = Lock()
_state: Dict[str, Any] = {
    "active": False,
    "hall_id": None,
    "hall_name": None,
    "started_at": 0.0,
    "duration": 1.0,
    "frames": {},   # ip -> list[(offset_seconds, payload_dict)]
    "devices": {},  # ip -> {"label", "hostname", "seq"}
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _safe_name(name: str) -> str:
    keep = "".join(c if c.isalnum() or c in "-_" else "-" for c in (name or "hall"))
    return keep.strip("-").lower() or "hall"


def _parse_ts(ts: str) -> Optional[float]:
    """Parse a stored ISO timestamp into epoch seconds."""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except Exception:
        try:
            return datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
        except Exception:
            return None


# ---------------------------------------------------------------------------
# CAPTURE (main db)
# ---------------------------------------------------------------------------
def build_snapshot(hall_id: int, window_hours: int = 24, max_points: int = 3000) -> Dict[str, Any]:
    """Read the current hall + its recorded telemetry from the active db into a bundle."""
    from db import HallRepo, RackRepo, PDURepo, TelemetryRepo

    hall = HallRepo.get(hall_id)
    if not hall:
        raise ValueError(f"Hall {hall_id} not found")

    cfg = HallRepo.get_latest_config(hall_id)
    config = cfg.get("config") if cfg else {}
    racks = RackRepo.get_by_hall(hall_id)
    pdus = PDURepo.get_by_hall(hall_id)

    from_ts = (datetime.now(timezone.utc) - timedelta(hours=window_hours)).isoformat()

    raw: Dict[str, List[Dict[str, Any]]] = {}
    epochs: List[float] = []
    for p in pdus:
        ip = p.get("ip_address")
        if not ip:
            continue
        hist = TelemetryRepo.get_history(p["id"], from_ts=from_ts, to_ts=None, limit=max_points)
        hist = list(reversed(hist))  # ascending by time
        frames = []
        for h in hist:
            e = _parse_ts(h.get("ts_utc"))
            if e is None:
                continue
            frames.append({"e": e, "p": h.get("payload") or {}})
            epochs.append(e)
        if frames:
            raw[ip] = frames

    earliest = min(epochs) if epochs else 0.0
    latest = max(epochs) if epochs else 0.0
    duration = max(1.0, latest - earliest)

    telemetry: Dict[str, List[Dict[str, Any]]] = {}
    for ip, frames in raw.items():
        telemetry[ip] = [{"t": round(f["e"] - earliest, 2), "p": f["p"]} for f in frames]

    snap_racks = [{
        "rack_code": r.get("rack_code"),
        "row_index": r.get("row_index"),
        "position_index": r.get("position_index"),
        "x_m": r.get("x_m"), "y_m": r.get("y_m"), "z_m": r.get("z_m"),
        "width_mm": r.get("width_mm"), "depth_mm": r.get("depth_mm"),
        "height_u": r.get("height_u"), "model": r.get("model"), "label": r.get("label"),
    } for r in racks]

    snap_pdus = [{
        "ip_address": p.get("ip_address"),
        "rack_code": p.get("rack_code"),
        "mount_position": p.get("mount_position", "A"),
        "hostname": p.get("hostname"),
        "label": p.get("label"),
        "mac_address": p.get("mac_address"),
        "snmp_port": p.get("snmp_port", 161),
        "snmp_version": p.get("snmp_version", "2c"),
    } for p in pdus if p.get("ip_address")]

    return {
        "version": 1,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "source_hall": hall.get("name"),
        "hall_name": f"{hall.get('name')} (recorded)",
        "config": config,
        "racks": snap_racks,
        "pdus": snap_pdus,
        "duration_s": round(duration, 2),
        "frame_count": sum(len(v) for v in telemetry.values()),
        "telemetry": telemetry,
    }


def save_snapshot(bundle: Dict[str, Any]) -> Dict[str, Any]:
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    fname = f"{_safe_name(bundle.get('source_hall'))}-{ts}.json"
    path = os.path.join(SNAPSHOT_DIR, fname)
    with open(path, "w") as fh:
        json.dump(bundle, fh)
    return {
        "filename": fname,
        "path": path,
        "pdu_count": len(bundle.get("pdus", [])),
        "frame_count": bundle.get("frame_count", 0),
        "duration_s": bundle.get("duration_s", 0),
        "source_hall": bundle.get("source_hall"),
    }


def list_snapshots() -> List[Dict[str, Any]]:
    if not os.path.isdir(SNAPSHOT_DIR):
        return []
    out = []
    for fn in sorted(os.listdir(SNAPSHOT_DIR), reverse=True):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(SNAPSHOT_DIR, fn)
        try:
            with open(path) as fh:
                b = json.load(fh)
            out.append({
                "filename": fn,
                "source_hall": b.get("source_hall"),
                "hall_name": b.get("hall_name"),
                "captured_at": b.get("captured_at"),
                "pdu_count": len(b.get("pdus", [])),
                "frame_count": b.get("frame_count", 0),
                "duration_s": b.get("duration_s", 0),
            })
        except Exception:
            continue
    return out


def read_snapshot(filename: str) -> Dict[str, Any]:
    # Guard against path traversal
    safe = os.path.basename(filename)
    path = os.path.join(SNAPSHOT_DIR, safe)
    with open(path) as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# RESTORE + REPLAY (demo db)
# ---------------------------------------------------------------------------
def load_bundle(bundle: Dict[str, Any]) -> Dict[str, Any]:
    """Restore the recorded hall into the demo db and arm the in-memory replayer."""
    from demo.context import activate_demo_db
    activate_demo_db()

    from db import HallRepo, PDURepo
    from db.persistence import save_hall_state, _connect

    name = bundle.get("hall_name") or "Recorded Hall"
    hall_id = None
    for h in HallRepo.get_all():
        if h.get("name") == name:
            hall_id = h["id"]
            break
    if hall_id is None:
        hall_id = HallRepo.create(name, f"Recorded from {bundle.get('source_hall')}")

    config = bundle.get("config") or {}
    racks = bundle.get("racks") or []
    pdus = []
    for p in bundle.get("pdus") or []:
        pdus.append({
            "ip_address": p.get("ip_address"),
            "rack_code": p.get("rack_code"),
            "mount_position": p.get("mount_position", "A"),
            "hostname": p.get("hostname"),
            "label": p.get("label"),
            "mac_address": p.get("mac_address"),
            "snmp_port": p.get("snmp_port", 161),
            "snmp_version": p.get("snmp_version", "2c"),
            "web_admin_port": 443,
            "web_admin_https": True,
            "web_admin_user": "admin",
            "web_admin_pass": "demo",
            "is_active": True,
        })

    save_hall_state(hall_id, config, racks, pdus)

    telemetry = bundle.get("telemetry") or {}
    duration = float(bundle.get("duration_s") or 1.0)

    # Map ip -> demo pdu id (after restore) and write recorded rows (shifted to end "now")
    demo_pdus = {p["ip_address"]: p["id"] for p in PDURepo.get_by_hall(hall_id) if p.get("ip_address")}
    now = datetime.now(timezone.utc)
    base = now - timedelta(seconds=duration)

    frames: Dict[str, List] = {}
    devices: Dict[str, Dict[str, Any]] = {}

    conn = _connect()
    try:
        for seq, (ip, flist) in enumerate(telemetry.items()):
            pdu_id = demo_pdus.get(ip)
            mem_frames = []
            for f in flist:
                t = float(f.get("t", 0))
                payload = f.get("p") or {}
                mem_frames.append((t, payload))
                if pdu_id is not None:
                    ts = (base + timedelta(seconds=t)).isoformat()
                    conn.execute(
                        """INSERT INTO telemetry (pdu_id, ts_utc, payload_json, status)
                           VALUES (?, ?, ?, 'ok')""",
                        (pdu_id, ts, json.dumps(payload)),
                    )
            mem_frames.sort(key=lambda x: x[0])
            frames[ip] = mem_frames
            devices[ip] = {
                "label": next((p.get("label") for p in (bundle.get("pdus") or []) if p.get("ip_address") == ip), ip),
                "hostname": next((p.get("hostname") for p in (bundle.get("pdus") or []) if p.get("ip_address") == ip), ip),
                "seq": seq + 1,
            }
        conn.commit()
    finally:
        conn.close()

    with _lock:
        _state.update({
            "active": True,
            "hall_id": hall_id,
            "hall_name": name,
            "started_at": time.time(),
            "duration": duration if duration > 0 else 1.0,
            "frames": frames,
            "devices": devices,
        })

    return {
        "success": True,
        "hall_id": hall_id,
        "hall_name": name,
        "pdu_count": len(frames),
        "duration_s": duration,
    }


def stop() -> None:
    with _lock:
        _state.update({"active": False, "frames": {}, "devices": {}, "hall_id": None, "hall_name": None})


def is_active() -> bool:
    return bool(_state.get("active"))


def is_replay_ip(ip: str) -> bool:
    return is_active() and ip in _state.get("frames", {})


def status() -> Dict[str, Any]:
    return {
        "active": is_active(),
        "hall_id": _state.get("hall_id"),
        "hall_name": _state.get("hall_name"),
        "pdu_count": len(_state.get("frames", {})),
        "duration_s": _state.get("duration"),
    }


def _payload_for(ip: str, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
    frames = _state.get("frames", {}).get(ip)
    if not frames:
        return None
    now = now if now is not None else time.time()
    duration = _state.get("duration") or 1.0
    elapsed = (now - _state.get("started_at", now)) % duration
    # last frame whose offset <= elapsed (linear scan; recordings are small)
    chosen = frames[0][1]
    for t, payload in frames:
        if t <= elapsed:
            chosen = payload
        else:
            break
    return chosen


def get_live(ip: str) -> Dict[str, Any]:
    payload = _payload_for(ip)
    if payload is None:
        return {"ip": ip, "results": [], "errors": [{"name": "_replay", "error": "No recorded data"}],
                "status": "pending", "source": "replay"}
    results = [{"name": k, "oid": "replay", "value": str(v)} for k, v in payload.items()]
    return {"ip": ip, "results": results, "errors": [], "status": "success", "source": "replay"}


def get_poll_status(ip: str) -> Dict[str, Any]:
    if is_replay_ip(ip):
        return {"state": "online", "source": "replay"}
    return {"state": "offline", "source": "replay"}


def _alarm_summary(payload: Dict[str, Any]):
    flags = []
    for k, v in payload.items():
        if k.startswith("alarm_") and k not in ("alarm_status", "alarm_color") and not k.endswith("_color"):
            if v and str(v).strip().lower() not in ("normal", "ok", "0", "closed", "false"):
                flags.append({"param": k})
    return len(flags), flags


def get_fleet_telemetry() -> Dict[str, Any]:
    pdus = []
    now = time.time()
    for ip, dev in _state.get("devices", {}).items():
        payload = _payload_for(ip, now) or {}
        count, flags = _alarm_summary(payload)
        pdus.append({
            "ip": ip,
            "seq": dev.get("seq"),
            "online": True,
            "state": "online",
            "label": dev.get("label") or ip,
            "results": [{"name": k, "oid": "replay", "value": str(v)} for k, v in payload.items()],
            "alarm_count": count,
            "alarm_flags": flags,
            "alarm_entries": [{"key": f["param"], "value": str(payload.get(f["param"], ""))} for f in flags],
            "env": {
                "temp": payload.get("Temperature1"),
                "temp2": payload.get("Temperature2"),
                "hum": payload.get("Humidity1"),
                "door": payload.get("DoorStatus"),
            },
        })
    online_n = len(pdus)
    return {
        "pdus": pdus,
        "summary": {
            "total": len(pdus),
            "online": online_n,
            "offline": 0,
            "alarm_total": sum(p["alarm_count"] for p in pdus),
        },
    }
