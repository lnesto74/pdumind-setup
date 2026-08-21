"""Live dispatch feed — real-time incident state for admin command view."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from demo import ops_teams
from demo.incidents import LEDGER_LABELS, list_incidents_for_dashboard

PHASES = [
    ("detect", "ALARM_DETECTED", "Detected"),
    ("assign", "ASSIGNED_PRIMARY", "Assigned"),
    ("notify", "NOTIFY_TELEGRAM", "Notified"),
    ("ack", "ACK_DISPATCH", "Acknowledged"),
    ("resolve", "RESOLVED_CLAIMED", "Resolved"),
    ("verify", "SYSTEM_VERIFIED", "Verified"),
    ("close", "INCIDENT_CLOSED", "Closed"),
]

MAX_LIVE_CARDS = 12
RECENT_HOURS = 48


def _parse_iso(iso: str) -> Optional[datetime]:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def _seconds_since(iso: str) -> float:
    dt = _parse_iso(iso)
    if not dt:
        return 0.0
    return max(0.0, (datetime.now(timezone.utc) - dt).total_seconds())


def _is_recent(rec: Dict[str, Any]) -> bool:
    ref = rec.get("updated_at") or rec.get("created_at")
    dt = _parse_iso(ref or "")
    if not dt:
        return True
    return datetime.now(timezone.utc) - dt <= timedelta(hours=RECENT_HOURS)


def _open_dispatch_rows(all_rows: List[Dict[str, Any]], active_fps: set) -> List[Dict[str, Any]]:
    """Only open incidents — closed history belongs in Stone Reports / Analytics."""
    open_rows = [r for r in all_rows if not r.get("closed")]
    open_rows.sort(key=lambda r: r.get("updated_at") or r.get("created_at") or "", reverse=True)
    def _is_live_alarm_row(row: Dict[str, Any]) -> bool:
        fp = row.get("fingerprint") or ""
        if fp in active_fps or row.get("kind") == "test":
            return True
        inc = row.get("incident") or {}
        key = (inc.get("key") or "").lower()
        return key.endswith("_load") or bool(inc.get("outlet_code"))

    live_rows = [r for r in open_rows if _is_live_alarm_row(r)]
    awaiting_rows = [
        r for r in open_rows
        if r not in live_rows and not r.get("acknowledged")
    ]
    other_rows = [r for r in open_rows if r not in live_rows and r not in awaiting_rows]
    return live_rows + awaiting_rows + other_rows


def _active_fingerprints() -> set:
    from demo.integrations import _load_raw
    try:
        raw = _load_raw()
        return set((raw.get("active_incidents") or {}).keys())
    except Exception:
        return set()


def _ledger_steps(ledger: List[Dict[str, Any]], rec: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    steps_done = {e.get("step") for e in ledger}
    current = ledger[-1].get("step") if ledger else None

    if rec:
        if rec.get("closed") or "INCIDENT_CLOSED" in steps_done:
            current = "INCIDENT_CLOSED"
        elif rec.get("resolved") or "RESOLVED_CLAIMED" in steps_done:
            current = "RESOLVED_CLAIMED" if "INCIDENT_CLOSED" not in steps_done else "INCIDENT_CLOSED"
        elif rec.get("acknowledged") or "ACK_DISPATCH" in steps_done:
            if current in ("REMINDER_SENT", "ESCALATED_LEAD", "ESCALATED_SECONDARY", "ESCALATED_ADMIN"):
                current = "ACK_DISPATCH"

    rows = []
    for step_id, step_key, label in PHASES:
        entry = next((e for e in ledger if e.get("step") == step_key), None)
        done = step_key in steps_done
        rows.append({
            "id": step_id,
            "step": step_key,
            "label": label,
            "done": done,
            "current": step_key == current or (
                step_id == "ack"
                and current in ("REMINDER_SENT", "ESCALATED_LEAD", "ESCALATED_SECONDARY", "ESCALATED_ADMIN")
                and not done
            ),
            "ts": entry.get("ts") if entry else None,
            "detail": entry.get("detail") if entry else None,
        })

    for extra in ("REMINDER_SENT", "ESCALATED_LEAD", "ESCALATED_SECONDARY", "ESCALATED_ADMIN"):
        if extra in steps_done:
            entry = next(e for e in ledger if e.get("step") == extra)
            rows.insert(4, {
                "id": extra.lower(),
                "step": extra,
                "label": LEDGER_LABELS.get(extra, extra),
                "done": True,
                "current": current == extra,
                "ts": entry.get("ts"),
                "detail": entry.get("detail"),
            })

    if "INCIDENT_CLOSED" in steps_done:
        for row in rows:
            row["done"] = row["step"] in steps_done
            row["current"] = False

    return rows


def _resolve_phase(rec: Dict[str, Any], ledger: List[Dict[str, Any]]) -> str:
    if rec.get("closed"):
        return "closed"
    steps = {e.get("step") for e in ledger}
    if "INCIDENT_CLOSED" in steps:
        return "closed"
    if rec.get("resolved") or "RESOLVED_CLAIMED" in steps:
        if "SYSTEM_VERIFIED" in steps:
            return "verified"
        return "resolved"
    if rec.get("acknowledged") or "ACK_DISPATCH" in steps:
        return "en_route"
    if any(s in steps for s in ("ESCALATED_ADMIN", "ESCALATED_SECONDARY", "ESCALATED_LEAD")):
        return "escalated"
    if "REMINDER_SENT" in steps:
        return "reminder"
    if "NOTIFY_TELEGRAM" in steps or "ASSIGNED_PRIMARY" in steps:
        return "awaiting_ack"
    if "ALARM_DETECTED" in steps:
        return "detected"
    return "open"


PHASE_LABELS = {
    "detected": "Alarm detected",
    "awaiting_ack": "Waiting for ack",
    "reminder": "Reminder sent",
    "escalated": "Escalated",
    "en_route": "En route",
    "resolved": "Resolved on-site",
    "verified": "System verified",
    "closed": "Closed",
    "open": "Open",
}


def _member_presence(s: Dict[str, Any]) -> str:
    if s.get("status") == "paused":
        return "paused"
    if s.get("status") == "active" and s.get("telegram_chat_id"):
        return "live"
    if s.get("status") == "demo_seed":
        return "demo_roster"
    return "offline"


def _pool_view(rec: Dict[str, Any], inc: Dict[str, Any]) -> Dict[str, Any]:
    dispatch = rec.get("dispatch") or {}
    hall_id = dispatch.get("hall_id") or ops_teams.ensure_hall_from_db()
    alarm_key = inc.get("key", "")
    disciplines = ops_teams.resolve_disciplines_for_alarm(alarm_key)

    with ops_teams._lock:
        data = ops_teams._load()
        subs = {s["id"]: s for s in data.get("subscribers") or []}

    primary_id = dispatch.get("primary_subscriber_id")
    pool_key = dispatch.get("pool_key")

    if not pool_key and primary_id:
        sub = subs.get(primary_id)
        if sub:
            pool_key = ops_teams._pool_key(hall_id, sub.get("discipline") or "electrician")

    if not pool_key:
        for entry in reversed(rec.get("ledger") or []):
            if entry.get("step") != "ASSIGNED_PRIMARY":
                continue
            sid = (entry.get("meta") or {}).get("subscriber_id")
            sub = subs.get(sid or "")
            if sub:
                primary_id = primary_id or sid
                pool_key = ops_teams._pool_key(hall_id, sub.get("discipline") or "electrician")
                break

    if not pool_key:
        pick = ops_teams.pick_primary_subscriber(hall_id, alarm_key)
        if pick:
            pool_key = pick.get("pool_key")
            primary_id = primary_id or pick.get("id")
        else:
            primary_disc = disciplines[0] if disciplines else "electrician"
            pool_key = ops_teams._pool_key(hall_id, primary_disc)

    primary_disc = (pool_key or "").split(":")[-1] or (disciplines[0] if disciplines else "electrician")

    with ops_teams._lock:
        data = ops_teams._load()
        pool = data.get("pools", {}).get(pool_key) or {"member_ids": [], "cursor": 0}
    owner_id = dispatch.get("owner_subscriber_id")

    members = []
    live_members = []
    for mid in pool.get("member_ids") or []:
        s = subs.get(mid)
        if not s:
            continue
        presence = _member_presence(s)
        row = {
            "id": s.get("id"),
            "display_name": s.get("display_name"),
            "discipline": s.get("discipline"),
            "status": s.get("status"),
            "presence": presence,
            "telegram_linked": bool(s.get("telegram_chat_id")),
            "telegram_user_id": s.get("telegram_user_id"),
            "live_eligible": presence == "live",
            "is_demo_seed": s.get("status") == "demo_seed",
            "is_primary_target": mid == primary_id,
            "is_owner": mid == owner_id,
            "paused": presence == "paused",
            "subscribed_at": s.get("subscribed_at"),
        }
        members.append(row)
        if row["live_eligible"]:
            live_members.append(row)

    return {
        "discipline": primary_disc,
        "discipline_label": ops_teams.DISCIPLINE_LABELS.get(primary_disc, primary_disc),
        "pool_key": pool_key,
        "cursor": int(pool.get("cursor") or 0),
        "members": members,
        "live_members": live_members,
        "live_count": len(live_members),
    }


def _escalation_view(rec: Dict[str, Any], policy: Dict[str, int]) -> Dict[str, Any]:
    dispatch = rec.get("dispatch") or {}
    notify_at = dispatch.get("last_notify_at") or rec.get("updated_at") or rec.get("created_at")
    elapsed = _seconds_since(notify_at)
    level = int(dispatch.get("escalation_level") or 0)

    reminder = int(policy.get("reminder_sec", 180))
    lead = int(policy.get("lead_sec", 300))
    secondary = int(policy.get("secondary_sec", 480))
    admin = int(policy.get("admin_sec", 720))

    def _remaining(threshold: float) -> float:
        return max(0.0, threshold - elapsed)

    def _pct(threshold: float) -> float:
        if threshold <= 0:
            return 1.0
        return min(1.0, elapsed / threshold)

    return {
        "level": level,
        "elapsed_sec": elapsed,
        "notify_at": notify_at,
        "reminder_sec": reminder,
        "lead_sec": lead,
        "secondary_sec": secondary,
        "admin_sec": admin,
        "reminder_in_sec": _remaining(reminder),
        "lead_in_sec": _remaining(lead),
        "secondary_in_sec": _remaining(secondary),
        "admin_in_sec": _remaining(admin),
        "reminder_pct": _pct(reminder),
        "lead_pct": _pct(lead),
        "secondary_pct": _pct(secondary),
        "admin_pct": _pct(admin),
        "reminder_fired": elapsed >= reminder,
        "lead_fired": elapsed >= lead,
        "secondary_fired": elapsed >= secondary,
        "admin_fired": elapsed >= admin,
    }


def get_live_dispatch() -> Dict[str, Any]:
    from demo.incidents import (
        repair_premature_auto_closed_incidents,
        repair_stale_resolved_incidents,
        repair_superseded_open_incidents,
    )

    repair_premature_auto_closed_incidents()
    repair_stale_resolved_incidents()
    repair_superseded_open_incidents()
    policy = ops_teams._load().get("escalation_policy") or ops_teams.DEFAULT_ESCALATION
    active_fps = _active_fingerprints()
    all_rows = list_incidents_for_dashboard().get("incidents") or []
    ordered = _open_dispatch_rows(all_rows, active_fps)
    total_open = len(ordered)
    display_rows = ordered[:MAX_LIVE_CARDS]

    incidents = []
    for rec in display_rows:
        inc = rec.get("incident") or {}
        ledger = rec.get("ledger") or []
        phase = _resolve_phase(rec, ledger)
        dispatch = rec.get("dispatch") or {}
        pool = _pool_view(rec, inc)
        owner_id = dispatch.get("owner_subscriber_id")
        owner = next((m for m in pool["members"] if m["id"] == owner_id), None)
        primary = next((m for m in pool["members"] if m.get("is_primary_target")), None)
        if not primary and pool["live_members"]:
            primary = pool["live_members"][0]

        incidents.append({
            "token": rec.get("token"),
            "mobile_url": rec.get("mobile_url"),
            "fingerprint": rec.get("fingerprint"),
            "kind": rec.get("kind"),
            "is_active_alarm": (
                (rec.get("fingerprint") or "") in active_fps
                or (
                    not rec.get("closed")
                    and not rec.get("acknowledged")
                    and (
                        (inc.get("key") or "").lower().endswith("_load")
                        or bool(inc.get("outlet_code"))
                    )
                )
            ),
            "incident": inc,
            "phase": phase,
            "phase_label": PHASE_LABELS.get(phase, phase),
            "lottery_active": (
                not rec.get("closed")
                and phase in ("awaiting_ack", "reminder", "escalated")
                and not rec.get("acknowledged")
                and len(pool.get("live_members") or []) > 1
            ),
            "single_live_primary": (
                not rec.get("closed")
                and phase in ("awaiting_ack", "reminder", "escalated")
                and not rec.get("acknowledged")
                and len(pool.get("live_members") or []) == 1
            ),
            "acknowledged": bool(rec.get("acknowledged")),
            "resolved": bool(rec.get("resolved")),
            "created_at": rec.get("created_at"),
            "updated_at": rec.get("updated_at"),
            "elapsed_sec": _seconds_since(rec.get("created_at") or ""),
            "owner": owner,
            "primary": primary,
            "pool": pool,
            "escalation": _escalation_view(rec, policy),
            "steps": _ledger_steps(ledger, rec),
            "ledger": ledger[-8:],
            "status": rec.get("status"),
        })

    return {
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "open_count": total_open,
        "display_count": len(incidents),
        "truncated": total_open > len(incidents),
        "escalation_policy": policy,
        "hall_layout": _hall_map_for_dispatch(),
        "incidents": incidents,
    }


def _hall_map_for_dispatch() -> Dict[str, Any]:
    """Interactive hall wireframe — rack severities from live fleet alarms."""
    from demo.ops_teams import _hall_layout_snapshot
    from demo.integrations import _collect_incidents

    layout = _hall_layout_snapshot()
    by_rack: Dict[str, str] = {}
    for inc in _collect_incidents():
        code = inc.get("rack")
        if not code:
            continue
        sev = inc.get("severity") or "warning"
        if code not in by_rack or sev == "critical":
            by_rack[code] = sev

    racks = []
    for rack in layout.get("racks") or []:
        row = dict(rack)
        code = row.get("rack_code")
        if code in by_rack:
            row["severity"] = by_rack[code]
        racks.append(row)
    layout["racks"] = racks
    return layout
