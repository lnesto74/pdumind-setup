"""Demo incident tokens — secured public mobile views (no login)."""
from __future__ import annotations

import json
import os
import secrets
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from demo.config import DATA_DIR, DEMO_HALL_NAME, demo_enabled, ops_enabled, store_path, is_ops_namespace

_INCIDENTS_PATH = os.path.join(DATA_DIR, "demo_incidents.json")  # legacy default (demo)


def _layer_enabled() -> bool:
    """Namespace-aware 'is this layer active' gate (ops vs demo)."""
    return ops_enabled() if is_ops_namespace() else demo_enabled()
_lock = threading.Lock()
_TOKEN_TTL_HOURS = 72
_MAX_STORED = 500
_RETENTION_DAYS = 365

LEDGER_LABELS = {
    "ALARM_DETECTED": "Alarm detected",
    "ASSIGNED_PRIMARY": "Round-robin primary assigned",
    "NOTIFY_TELEGRAM": "Telegram alert sent",
    "REMINDER_SENT": "Reminder sent to primary",
    "ESCALATED_LEAD": "Escalated to hall lead",
    "ESCALATED_SECONDARY": "Escalated to secondary pool",
    "ESCALATED_ADMIN": "Escalated to all ops + admin",
    "NOTIFY_EMAIL": "Email alert sent",
    "LINK_OPENED": "Mobile link opened",
    "ACK_DISPATCH": "Technician acknowledged — en route",
    "RESOLVED_CLAIMED": "Technician marked resolved on-site",
    "SYSTEM_VERIFIED": "System verified — telemetry normal",
    "INCIDENT_CLOSED": "Incident closed — stone report saved",
    "TELEMETRY_CLEAR": "Telemetry cleared — awaiting ops",
}


def _append_ledger(rec: Dict[str, Any], step: str, detail: str, actor: str = "system", meta: Optional[Dict] = None) -> None:
    ledger = rec.setdefault("ledger", [])
    if step == "LINK_OPENED" and any(e.get("step") == step for e in ledger):
        return
    if step == "SYSTEM_VERIFIED" and any(e.get("step") == step for e in ledger):
        return
    ledger.append({
        "ts": _utc_iso(),
        "step": step,
        "label": LEDGER_LABELS.get(step, step),
        "detail": detail,
        "actor": actor,
        "meta": meta or {},
    })
    rec["status"] = step
    rec["updated_at"] = _utc_iso()


def _stone_report(rec: Dict[str, Any]) -> Dict[str, Any]:
    inc = rec.get("incident") or {}
    return {
        "fingerprint": rec.get("fingerprint"),
        "incident_id": (rec.get("fingerprint") or "")[:32],
        "pdu": inc.get("label") or inc.get("ip"),
        "rack": inc.get("rack"),
        "severity": inc.get("severity"),
        "issue": f"{_alarm_label(inc.get('key', ''))}: {inc.get('value', '')}",
        "opened_at": rec.get("created_at"),
        "closed_at": rec.get("closed_at"),
        "status": rec.get("status"),
        "acknowledged_at": rec.get("acknowledged_at"),
        "resolved_at": rec.get("resolved_at"),
        "verified_at": rec.get("verified_at"),
        "timeline": rec.get("ledger") or [],
    }


def append_incident_ledger(token: str, step: str, detail: str, actor: str = "system", meta: Optional[Dict] = None) -> None:
    with _lock:
        data = _load_store()
        incidents = data.get("incidents") or {}
        rec = incidents.get(token)
        if not rec:
            return
        _append_ledger(rec, step, detail, actor, meta)
        incidents[token] = rec
        data["incidents"] = incidents
        _save_store(data)


def append_ledger_by_fingerprint(fingerprint: str, step: str, detail: str, actor: str = "system", meta: Optional[Dict] = None) -> None:
    with _lock:
        data = _load_store()
        incidents = data.get("incidents") or {}
        for token, rec in incidents.items():
            if rec.get("fingerprint") == fingerprint and not rec.get("closed"):
                _append_ledger(rec, step, detail, actor, meta)
                if step in ("SYSTEM_VERIFIED", "INCIDENT_CLOSED"):
                    if step == "SYSTEM_VERIFIED":
                        rec["verified_at"] = _utc_iso()
                    if step == "INCIDENT_CLOSED":
                        rec["closed"] = True
                        rec["closed_at"] = _utc_iso()
                        rec["stone_report"] = _stone_report(rec)
                incidents[token] = rec
        data["incidents"] = incidents
        _save_store(data)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_iso(dt: datetime | None = None) -> str:
    return (dt or _utc_now()).isoformat(timespec="seconds")


def _duration_sec(start_iso: Optional[str], end_iso: Optional[str]) -> Optional[int]:
    if not start_iso or not end_iso:
        return None
    try:
        start = datetime.fromisoformat(start_iso)
        end = datetime.fromisoformat(end_iso)
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        return max(0, int((end - start).total_seconds()))
    except ValueError:
        return None


def _load_store() -> Dict[str, Any]:
    path = store_path("incidents.json")
    if not os.path.exists(path):
        return {"incidents": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        data = {}
    if "incidents" not in data:
        data["incidents"] = {}
    return data


def _save_store(data: Dict[str, Any]) -> None:
    path = store_path("incidents.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    incidents = data.get("incidents") or {}
    if len(incidents) > _MAX_STORED:
        sorted_keys = sorted(
            incidents.keys(),
            key=lambda k: incidents[k].get("created_at", ""),
            reverse=True,
        )
        data["incidents"] = {k: incidents[k] for k in sorted_keys[:_MAX_STORED]}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def _purge_expired(incidents: Dict[str, Any]) -> Dict[str, Any]:
    now = _utc_now()
    retention_cutoff = now - timedelta(days=_RETENTION_DAYS)
    kept = {}
    for token, rec in incidents.items():
        exp = rec.get("expires_at")
        if exp:
            try:
                if datetime.fromisoformat(exp) < now:
                    continue
            except ValueError:
                pass
        if rec.get("closed"):
            created = rec.get("created_at")
            if created:
                try:
                    c = datetime.fromisoformat(created)
                    if c.tzinfo is None:
                        c = c.replace(tzinfo=timezone.utc)
                    if c < retention_cutoff:
                        continue
                except ValueError:
                    pass
        kept[token] = rec
    return kept


def _alarm_label(key: str, incident: Optional[Dict[str, Any]] = None) -> str:
    labels = {
        "alarm_temp1": "Temperature Sensor 1",
        "alarm_hum1": "Humidity Sensor 1",
        "alarm_sensor1": "Door / IO Sensor",
        "alarm_l1_current": "Phase L1 Current",
    }
    if incident and incident.get("outlet_code"):
        return f"Cable unplugged — Outlet {incident['outlet_code']}"
    if key.endswith("_load"):
        return "Cable unplugged"
    return labels.get(key, key.replace("alarm_", "").replace("_", " ").title())


def _category_for(key: str) -> str:
    if "temp" in key:
        return "Environment"
    if "hum" in key:
        return "Environment"
    if "sensor" in key:
        return "Access"
    if "current" in key or "voltage" in key:
        return "Power"
    return "Device"


def _demo_hall_id(ip: Optional[str] = None) -> Optional[int]:
    from db import HallRepo

    if is_ops_namespace():
        # Production: resolve the real hall for this PDU's rack; fallback to first hall.
        if ip:
            try:
                from db import PDURepo, RackRepo
                pdu = PDURepo.get_by_ip(ip)
                if pdu and pdu.get("rack_id"):
                    rack = RackRepo.get(pdu["rack_id"])
                    if rack and rack.get("hall_id"):
                        return rack["hall_id"]
            except Exception:
                pass
        halls = HallRepo.get_all()
        return halls[0]["id"] if halls else None

    from demo.context import activate_demo_db
    activate_demo_db()
    for h in HallRepo.get_all():
        if h.get("name") == DEMO_HALL_NAME:
            return h["id"]
    halls = HallRepo.get_all()
    return halls[0]["id"] if halls else None


def create_test_incident_token() -> tuple[str, Dict[str, Any]]:
    """Fresh secure token for test Telegram — opens mobile wireframe, no login."""
    from demo.integrations import _collect_incidents

    incidents = _collect_incidents()
    if incidents:
        incident = dict(incidents[0])
    else:
        incident = {
            "fingerprint": f"demo:preview:{secrets.token_hex(6)}",
            "ip": "10.99.1.207",
            "label": "Demo PDU-2",
            "rack": "Row-01/Rack-02",
            "key": "alarm_l1_current",
            "value": "High",
            "severity": "warning",
        }
    # Integration tests should hit the electrician round-robin (live Telegram subs).
    incident["key"] = "alarm_l1_current"
    incident["fingerprint"] = f"demo:test:{secrets.token_hex(8)}"

    token = secrets.token_urlsafe(24)
    expires = _utc_now() + timedelta(hours=_TOKEN_TTL_HOURS)
    with _lock:
        data = _load_store()
        incidents_map = _purge_expired(data.get("incidents") or {})
        incidents_map[token] = {
            "fingerprint": incident.get("fingerprint"),
            "incident": incident,
            "kind": "test",
            "created_at": _utc_iso(),
            "updated_at": _utc_iso(),
            "expires_at": _utc_iso(expires),
            "views": 0,
            "acknowledged": False,
            "acknowledged_at": None,
            "resolved": False,
            "resolved_at": None,
            "cleared": False,
            "closed": False,
            "ledger": [],
            "participants": [],
            "dispatch": {},
            "status": "OPEN",
        }
        _append_ledger(incidents_map[token], "ALARM_DETECTED", f"{incident.get('label')} — {_alarm_label(incident.get('key',''))}: {incident.get('value')}")
        data["incidents"] = incidents_map
        _save_store(data)
    return token, incident


def incident_public_url(base_url: str, token: str) -> str:
    return f"{base_url.rstrip('/')}/incident/{token}"


def get_or_create_token(incident: Dict[str, Any]) -> str:
    """Return stable token for an active incident fingerprint."""
    fp = incident.get("fingerprint") or ""
    with _lock:
        data = _load_store()
        incidents = _purge_expired(data.get("incidents") or {})
        for token, rec in incidents.items():
            if rec.get("fingerprint") == fp and not rec.get("closed"):
                rec["incident"] = incident
                rec["updated_at"] = _utc_iso()
                incidents[token] = rec
                data["incidents"] = incidents
                _save_store(data)
                return token

        token = secrets.token_urlsafe(24)
        expires = _utc_now() + timedelta(hours=_TOKEN_TTL_HOURS)
        incidents[token] = {
            "fingerprint": fp,
            "incident": incident,
            "created_at": _utc_iso(),
            "updated_at": _utc_iso(),
            "expires_at": _utc_iso(expires),
            "views": 0,
            "acknowledged": False,
            "acknowledged_at": None,
            "resolved": False,
            "resolved_at": None,
            "cleared": False,
            "closed": False,
            "ledger": [],
            "participants": [],
            "dispatch": {},
            "status": "OPEN",
        }
        _append_ledger(incidents[token], "ALARM_DETECTED", f"{incident.get('label')} — {_alarm_label(incident.get('key',''))}: {incident.get('value')}")
        data["incidents"] = incidents
        _save_store(data)
        return token


def _find_open_incident_by_fingerprint(fingerprint: str) -> tuple[Optional[str], Optional[Dict[str, Any]]]:
    if not fingerprint:
        return None, None
    with _lock:
        incidents = (_load_store().get("incidents") or {})
        for token, rec in incidents.items():
            if rec.get("fingerprint") == fingerprint and not rec.get("closed"):
                return token, rec
    return None, None


def _ledger_has_step(rec: Dict[str, Any], step: str) -> bool:
    return any(e.get("step") == step for e in (rec.get("ledger") or []))


def handle_alarm_telemetry_cleared(fingerprint: str) -> bool:
    """PDU telemetry no longer shows this alarm.

    Returns True when the alarm should be removed from active_incidents tracking.
    Incidents stay OPEN until the technician acknowledges (and resolves for auto-close).
    """
    token, rec = _find_open_incident_by_fingerprint(fingerprint)
    if not rec:
        return True

    inc = rec.get("incident") or {}
    inc_label = inc.get("label") or fingerprint

    if not rec.get("acknowledged"):
        if not _ledger_has_step(rec, "TELEMETRY_CLEAR"):
            with _lock:
                data = _load_store()
                row = (data.get("incidents") or {}).get(token)
                if row and not row.get("closed"):
                    _append_ledger(
                        row,
                        "TELEMETRY_CLEAR",
                        "PDU telemetry normal — still awaiting technician ack",
                        "pdumind",
                    )
                    row["status"] = "AWAITING_ACK"
                    (data.get("incidents") or {})[token] = row
                    _save_store(data)
        return False

    if not rec.get("resolved"):
        if not _ledger_has_step(rec, "TELEMETRY_CLEAR"):
            with _lock:
                data = _load_store()
                row = (data.get("incidents") or {}).get(token)
                if row and not row.get("closed"):
                    _append_ledger(
                        row,
                        "TELEMETRY_CLEAR",
                        "PDU telemetry normal — awaiting on-site resolve",
                        "pdumind",
                    )
                    row["status"] = "AWAITING_RESOLVE"
                    (data.get("incidents") or {})[token] = row
                    _save_store(data)
        return False

    mark_incident_cleared(fingerprint)
    return True


def mark_incident_cleared(fingerprint: str) -> None:
    inc_label = fingerprint
    with _lock:
        data = _load_store()
        incidents = data.get("incidents") or {}
        for token, rec in incidents.items():
            if rec.get("fingerprint") == fingerprint and not rec.get("closed"):
                inc = rec.get("incident") or {}
                inc_label = inc.get("label") or fingerprint
                _finalize_incident_record(rec, verify_detail=(
                    f"PDU telemetry confirms {inc.get('key', 'alarm')} returned to normal"
                ))
                incidents[token] = rec
        data["incidents"] = incidents
        _save_store(data)

    _clear_active_alarm(fingerprint, reason="telemetry_normal", inc_label=inc_label)

    from demo.integrations import _append_workflow, _load_raw, _save_raw
    with _lock:
        cfg = _load_raw()
        _append_workflow(cfg, "SYSTEM_VERIFIED", f"Auto-verified cleared — {inc_label}", {"fingerprint": fingerprint})
        _save_raw(cfg)


def repair_premature_auto_closed_incidents() -> int:
    """Re-open incidents that were auto-closed from telemetry before technician ack."""
    reopened = 0
    with _lock:
        data = _load_store()
        incidents = data.get("incidents") or {}
        for token, rec in list(incidents.items()):
            if not rec.get("closed"):
                continue
            if rec.get("acknowledged") or rec.get("resolved"):
                continue
            steps = {e.get("step") for e in (rec.get("ledger") or [])}
            if "INCIDENT_CLOSED" not in steps and "SYSTEM_VERIFIED" not in steps:
                continue
            if "ACK_DISPATCH" in steps:
                continue
            rec["closed"] = False
            rec["cleared"] = False
            rec["closed_at"] = None
            rec["verified_at"] = None
            rec["stone_report"] = None
            _append_ledger(
                rec,
                "ALARM_DETECTED",
                "Re-opened — awaiting technician acknowledge",
                "pdumind",
            )
            rec["status"] = "ALARM_DETECTED"
            incidents[token] = rec
            reopened += 1
        data["incidents"] = incidents
        _save_store(data)
    return reopened


def _finalize_incident_record(rec: Dict[str, Any], verify_detail: str) -> None:
    """Append verify + close ledger steps and stone report on an open incident record."""
    if rec.get("closed"):
        return
    inc = rec.get("incident") or {}
    ledger = rec.get("ledger") or []
    if not any(e.get("step") == "SYSTEM_VERIFIED" for e in ledger):
        _append_ledger(rec, "SYSTEM_VERIFIED", verify_detail, "pdumind")
        rec["verified_at"] = _utc_iso()
    if not rec.get("closed"):
        _append_ledger(rec, "INCIDENT_CLOSED", "Stone report archived for audit", "pdumind")
        rec["closed"] = True
        rec["closed_at"] = _utc_iso()
        rec["cleared"] = True
        rec["stone_report"] = _stone_report(rec)


def _clear_active_alarm(fingerprint: str, *, reason: str, inc_label: str = "") -> None:
    if not fingerprint:
        return
    from demo.integrations import _append_workflow, _load_raw, _save_raw
    with _lock:
        cfg = _load_raw()
        active = dict(cfg.get("active_incidents") or {})
        if fingerprint not in active:
            return
        cleared = active.pop(fingerprint)
        label = inc_label or cleared.get("label") or "PDU"
        msg = f"{label} — resolved on-site" if reason == "technician_resolved" else f"{label} — telemetry normal"
        _append_workflow(cfg, "ALARM_CLEARED", msg, cleared)
        cfg["active_incidents"] = active
        _save_raw(cfg)


def finalize_incident_after_resolve(token: str, actor: str = "technician") -> None:
    """Demo: trust on-site resolution — verify and close immediately after technician marks done."""
    with _lock:
        data = _load_store()
        incidents = data.get("incidents") or {}
        rec = incidents.get(token)
        if not rec or rec.get("closed"):
            return
        inc = rec.get("incident") or {}
        label = inc.get("label") or inc.get("ip") or "PDU"
        _finalize_incident_record(
            rec,
            verify_detail=f"{actor} resolved on-site — {label} @ {inc.get('rack', '—')}",
        )
        fp = rec.get("fingerprint")
        incidents[token] = rec
        data["incidents"] = incidents
        _save_store(data)

    if fp:
        _clear_active_alarm(fp, reason="technician_resolved", inc_label=label)
        from demo.integrations import suppress_alarm_redispatch
        suppress_alarm_redispatch(fp)

    from demo.integrations import _append_workflow, _load_raw, _save_raw
    with _lock:
        cfg = _load_raw()
        _append_workflow(
            cfg,
            "INCIDENT_CLOSED",
            f"Auto-closed after on-site fix — {label}",
            {"token": token[:8] + "…", "fingerprint": fp},
        )
        _save_raw(cfg)


def repair_stale_resolved_incidents() -> int:
    """Close incidents stuck at RESOLVED from before auto-finalize was deployed."""
    with _lock:
        data = _load_store()
        incidents = data.get("incidents") or {}
        stale_tokens = [
            token
            for token, rec in incidents.items()
            if rec.get("resolved") and not rec.get("closed")
            and "RESOLVED_CLAIMED" in {e.get("step") for e in (rec.get("ledger") or [])}
            and "INCIDENT_CLOSED" not in {e.get("step") for e in (rec.get("ledger") or [])}
        ]

    for token in stale_tokens:
        finalize_incident_after_resolve(token, actor="pdumind")

    return len(stale_tokens)


def repair_superseded_open_incidents() -> int:
    """Close orphan re-dispatches for alarms already closed by a technician."""
    from demo.integrations import suppress_alarm_redispatch

    with _lock:
        data = _load_store()
        incidents = data.get("incidents") or {}
        closed_fps = {
            rec.get("fingerprint")
            for rec in incidents.values()
            if rec.get("closed") and rec.get("fingerprint")
        }
        tokens = [
            token
            for token, rec in incidents.items()
            if not rec.get("closed")
            and rec.get("fingerprint") in closed_fps
            and not rec.get("acknowledged")
            and "RESOLVED_CLAIMED" not in {e.get("step") for e in (rec.get("ledger") or [])}
        ]

    repaired = 0
    for token in tokens:
        with _lock:
            data = _load_store()
            rec = (data.get("incidents") or {}).get(token)
            if not rec or rec.get("closed"):
                continue
            fp = rec.get("fingerprint")
            _finalize_incident_record(
                rec,
                verify_detail="Duplicate dispatch suppressed — original incident already closed",
            )
            (data.get("incidents") or {})[token] = rec
            _save_store(data)
        if fp:
            suppress_alarm_redispatch(fp)
        repaired += 1

    with _lock:
        data = _load_store()
        for rec in (data.get("incidents") or {}).values():
            if not rec.get("closed") or not rec.get("fingerprint"):
                continue
            if "RESOLVED_CLAIMED" in {e.get("step") for e in (rec.get("ledger") or [])}:
                suppress_alarm_redispatch(rec["fingerprint"])

    return repaired


def _build_issues() -> List[Dict[str, Any]]:
    from demo.integrations import _collect_incidents

    issues = []
    for inc in _collect_incidents():
        issues.append({
            "severity": inc.get("severity", "warning"),
            "title": _alarm_label(inc.get("key", "")),
            "message": f"{_alarm_label(inc.get('key', ''))}: {inc.get('value', '')}",
            "pdu_ip": inc.get("ip"),
            "pdu_label": inc.get("label"),
            "rack_code": inc.get("rack"),
            "category": _category_for(inc.get("key", "")),
            "fingerprint": inc.get("fingerprint"),
        })
    return sorted(issues, key=lambda i: (0 if i["severity"] == "critical" else 1, i.get("rack_code") or ""))


def _rack_severity(rack_code: str, issues: List[Dict], primary_rack: str) -> Optional[str]:
    sevs = [i["severity"] for i in issues if i.get("rack_code") == rack_code]
    if not sevs:
        return None
    if "critical" in sevs:
        return "critical"
    return "warning"


def list_incidents_for_dashboard() -> Dict[str, Any]:
    """All demo incidents with full stone-report timelines (coordinator UI)."""
    from demo.integrations import _load_raw

    with _lock:
        data = _load_store()
        incidents = _purge_expired(data.get("incidents") or {})

    try:
        cfg = _load_raw()
        base = (cfg.get("frontend_base_url") or "").strip()
    except Exception:
        base = ""

    rows: List[Dict[str, Any]] = []
    for token, rec in incidents.items():
        inc = rec.get("incident") or {}
        ledger = list(rec.get("ledger") or [])
        if not ledger and inc:
            ledger = [{
                "ts": rec.get("created_at") or _utc_iso(),
                "step": "ALARM_DETECTED",
                "label": LEDGER_LABELS["ALARM_DETECTED"],
                "detail": f"{inc.get('label', 'PDU')} — {_alarm_label(inc.get('key', ''))}: {inc.get('value', '')}",
                "actor": "pdumind",
                "meta": {},
            }]
        rows.append({
            "token": token,
            "mobile_url": incident_public_url(base, token) if base else None,
            "fingerprint": rec.get("fingerprint"),
            "status": rec.get("status") or (ledger[-1]["step"] if ledger else "ALARM_DETECTED"),
            "closed": bool(rec.get("closed")),
            "cleared": bool(rec.get("cleared")),
            "kind": rec.get("kind"),
            "created_at": rec.get("created_at"),
            "updated_at": rec.get("updated_at"),
            "acknowledged": bool(rec.get("acknowledged")),
            "acknowledged_at": rec.get("acknowledged_at"),
            "resolved": bool(rec.get("resolved")),
            "resolved_at": rec.get("resolved_at"),
            "verified_at": rec.get("verified_at"),
            "closed_at": rec.get("closed_at"),
            "incident": inc,
            "ledger": ledger,
            "participants": rec.get("participants") or [],
            "dispatch": rec.get("dispatch") or {},
            "stone_report": rec.get("stone_report"),
            "owner_subscriber_id": (rec.get("dispatch") or {}).get("owner_subscriber_id"),
        })

    rows.sort(key=lambda r: r.get("updated_at") or r.get("created_at") or "", reverse=True)
    return {"incidents": rows, "count": len(rows)}


def build_snapshot(token: str, record_view: bool = True) -> Dict[str, Any]:
    if not _layer_enabled():
        return {"error": "Incident layer disabled", "code": "DEMO_DISABLED"}

    with _lock:
        data = _load_store()
        incidents = _purge_expired(data.get("incidents") or {})
        data["incidents"] = incidents
        rec = incidents.get(token)
        if not rec:
            _save_store(data)
            return {"error": "Incident not found or expired", "code": "NOT_FOUND"}
        if record_view:
            rec["views"] = int(rec.get("views") or 0) + 1
            rec["last_viewed_at"] = _utc_iso()
            _append_ledger(rec, "LINK_OPENED", "Mobile incident page viewed", "mobile")
            incidents[token] = rec
            data["incidents"] = incidents
            _save_store(data)

    primary = rec.get("incident") or {}
    primary_rack = primary.get("rack") or ""
    primary_ip = primary.get("ip") or ""

    from db import HallRepo, PDURepo, RackRepo

    if not is_ops_namespace():
        from demo.context import activate_demo_db
        activate_demo_db()
    hall_id = _demo_hall_id(primary_ip)
    if not hall_id:
        return {"error": "Hall not found", "code": "NO_HALL"}

    hall = HallRepo.get(hall_id)
    config_row = HallRepo.get_latest_config(hall_id)
    config = (config_row or {}).get("config") or {}
    hall_dims = config.get("hall") or {}
    length = float(hall_dims.get("length") or 20)
    width = float(hall_dims.get("width") or 12)

    issues = _build_issues()
    pdu_by_rack: Dict[str, List[str]] = {}
    for pdu in PDURepo.get_by_hall(hall_id):
        if pdu.get("rack_id"):
            rack = RackRepo.get(pdu["rack_id"])
            if rack:
                code = rack.get("rack_code")
                pdu_by_rack.setdefault(code, []).append(pdu.get("label") or pdu.get("ip_address"))

    racks_out = []
    for rack in RackRepo.get_by_hall(hall_id):
        code = rack.get("rack_code")
        sev = _rack_severity(code, issues, primary_rack)
        racks_out.append({
            "rack_code": code,
            "row_index": rack.get("row_index"),
            "position_index": rack.get("position_index"),
            "x_m": rack.get("x_m"),
            "z_m": rack.get("z_m"),
            "width_mm": rack.get("width_mm") or 600,
            "depth_mm": rack.get("depth_mm") or 1000,
            "label": rack.get("label") or code,
            "severity": sev,
            "is_primary": code == primary_rack,
            "pdus": pdu_by_rack.get(code, []),
        })

    critical = sum(1 for i in issues if i["severity"] == "critical")
    warning = sum(1 for i in issues if i["severity"] == "warning")

    return {
        "token": token,
        "hall": {
            "name": hall.get("name") if hall else DEMO_HALL_NAME,
            "length_m": length,
            "width_m": width,
        },
        "primary": {
            "ip": primary_ip,
            "label": primary.get("label") or primary_ip,
            "rack_code": primary_rack,
            "severity": primary.get("severity", "warning"),
            "title": _alarm_label(primary.get("key", ""), primary),
            "value": primary.get("value"),
            "outlet_code": primary.get("outlet_code"),
            "message": (
                f"{_alarm_label(primary.get('key', ''), primary)}"
                + (f" — {primary.get('value')}" if primary.get("value") else "")
            ),
            "fingerprint": primary.get("fingerprint"),
        },
        "issues": issues,
        "racks": racks_out,
        "summary": {
            "total": len(issues),
            "critical": critical,
            "warning": warning,
        },
        "expires_at": rec.get("expires_at"),
        "acknowledged": bool(rec.get("acknowledged")),
        "acknowledged_at": rec.get("acknowledged_at"),
        "resolved": bool(rec.get("resolved")),
        "resolved_at": rec.get("resolved_at"),
        "verified_at": rec.get("verified_at"),
        "closed": bool(rec.get("closed")),
        "cleared": bool(rec.get("cleared")),
        "resolution_duration_sec": _duration_sec(rec.get("acknowledged_at"), rec.get("resolved_at")),
        "status": rec.get("status", "OPEN"),
        "ledger": rec.get("ledger") or [],
        "stone_report": rec.get("stone_report"),
        "created_at": rec.get("created_at"),
        "views": rec.get("views", 0),
    }


def acknowledge_incident(token: str, actor: str = "technician", subscriber_id: Optional[str] = None) -> Dict[str, Any]:
    if not _layer_enabled():
        return {"success": False, "error": "Incident layer disabled"}

    with _lock:
        data = _load_store()
        incidents = data.get("incidents") or {}
        rec = incidents.get(token)
        if not rec:
            return {"success": False, "error": "Incident not found"}
        if rec.get("closed"):
            return {"success": False, "error": "Incident already closed"}
        rec["acknowledged"] = True
        rec["acknowledged_at"] = _utc_iso()
        inc = rec.get("incident") or {}
        dispatch = rec.setdefault("dispatch", {})
        if subscriber_id:
            dispatch["owner_subscriber_id"] = subscriber_id
            pool_key = dispatch.get("pool_key")
            if pool_key:
                from demo import ops_teams
                ops_teams.advance_pool_cursor(pool_key)
        _append_ledger(
            rec,
            "ACK_DISPATCH",
            f"{inc.get('label', 'PDU')} @ {inc.get('rack', '—')} — {actor} en route",
            actor,
            {"subscriber_id": subscriber_id} if subscriber_id else {},
        )
        parts = rec.setdefault("participants", [])
        parts.append({"role": "owner", "actor": actor, "subscriber_id": subscriber_id, "ts": _utc_iso()})
        incidents[token] = rec
        data["incidents"] = incidents
        _save_store(data)

    from demo.integrations import _append_workflow, _load_raw, _save_raw

    with _lock:
        cfg = _load_raw()
        _append_workflow(
            cfg,
            "INCIDENT_ACK",
            f"Mobile ack — {inc.get('label', 'PDU')} @ {inc.get('rack', '—')}",
            {"token": token[:8] + "…", "fingerprint": inc.get("fingerprint")},
        )
        _save_raw(cfg)

    return {"success": True, "acknowledged_at": rec["acknowledged_at"], "ledger": rec.get("ledger")}


def resolve_incident(token: str, actor: str = "technician") -> Dict[str, Any]:
    if not _layer_enabled():
        return {"success": False, "error": "Incident layer disabled"}

    with _lock:
        data = _load_store()
        incidents = data.get("incidents") or {}
        rec = incidents.get(token)
        if not rec:
            return {"success": False, "error": "Incident not found"}
        if rec.get("closed"):
            return {"success": False, "error": "Incident already closed"}
        if not rec.get("acknowledged"):
            return {"success": False, "error": "Acknowledge dispatch before marking resolved"}
        rec["resolved"] = True
        rec["resolved_at"] = _utc_iso()
        inc = rec.get("incident") or {}
        _append_ledger(rec, "RESOLVED_CLAIMED", f"On-site fix completed for {inc.get('rack', 'rack')}", actor)
        incidents[token] = rec
        data["incidents"] = incidents
        _save_store(data)

    # Demo: always verify + close once technician confirms on-site fix.
    finalize_incident_after_resolve(token, actor=actor)

    fp = inc.get("fingerprint")
    from demo.integrations import _append_workflow, _load_raw, _save_raw
    with _lock:
        cfg = _load_raw()
        _append_workflow(cfg, "RESOLVED_CLAIMED", f"Technician resolved — {inc.get('label', 'PDU')}", {"fingerprint": fp})
        _save_raw(cfg)

    with _lock:
        data = _load_store()
        rec = (data.get("incidents") or {}).get(token, rec)

    return {
        "success": True,
        "resolved_at": rec.get("resolved_at"),
        "acknowledged_at": rec.get("acknowledged_at"),
        "resolution_duration_sec": _duration_sec(rec.get("acknowledged_at"), rec.get("resolved_at")),
        "verified": bool(rec.get("verified_at")),
        "closed": bool(rec.get("closed")),
        "cleared": bool(rec.get("cleared")),
        "ledger": rec.get("ledger"),
        "stone_report": rec.get("stone_report"),
    }


def incident_report_html(token: str) -> Optional[str]:
    """Printable stone report (PDF via browser print)."""
    with _lock:
        data = _load_store()
        rec = (data.get("incidents") or {}).get(token)
    if not rec:
        return None

    report = rec.get("stone_report") or _stone_report(rec)
    inc = rec.get("incident") or {}
    ledger = rec.get("ledger") or []
    rows = ""
    for entry in ledger:
        rows += (
            f"<tr><td>{entry.get('ts', '')}</td>"
            f"<td>{entry.get('label') or entry.get('step', '')}</td>"
            f"<td>{entry.get('detail', '')}</td>"
            f"<td>{entry.get('actor', 'system')}</td></tr>"
        )

    title = f"Stone Report — {inc.get('label') or inc.get('ip') or token[:8]}"
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>{title}</title>
<style>
  body {{ font-family: system-ui, sans-serif; margin: 2rem; color: #111; }}
  h1 {{ font-size: 1.25rem; margin-bottom: 0.25rem; }}
  .meta {{ color: #555; font-size: 0.85rem; margin-bottom: 1.5rem; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.8rem; }}
  th, td {{ border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }}
  th {{ background: #f3f4f6; }}
  @media print {{ body {{ margin: 1cm; }} }}
</style></head><body>
<h1>{title}</h1>
<p class="meta">
  Rack: {inc.get('rack', '—')} · Severity: {inc.get('severity', '—')}<br/>
  Opened: {report.get('opened_at', '—')} · Closed: {report.get('closed_at') or '—'}<br/>
  Issue: {report.get('issue', '—')}
</p>
<table>
  <thead><tr><th>Time (UTC)</th><th>Step</th><th>Detail</th><th>Actor</th></tr></thead>
  <tbody>{rows}</tbody>
</table>
<script>window.onload = function() {{ window.print(); }};</script>
</body></html>"""
