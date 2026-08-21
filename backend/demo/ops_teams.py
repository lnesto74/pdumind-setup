"""Demo ops teams — subscribers, rotation pools, routing, escalation policies."""
from __future__ import annotations

import json
import os
import secrets
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from demo.config import DATA_DIR, DEMO_HALL_NAME, store_path, is_ops_namespace

_STORE_PATH = os.path.join(DATA_DIR, "demo_ops_teams.json")  # legacy default (demo)
_lock = threading.Lock()

DISCIPLINES = ["electrician", "network", "hardware", "facilities", "hall_lead"]
DISCIPLINE_LABELS = {
    "electrician": "Electrician",
    "network": "Network",
    "hardware": "Hardware",
    "facilities": "Facilities",
    "hall_lead": "Hall Lead",
}

DEFAULT_ROUTING = [
    {"alarm_keys": ["alarm_temp1", "alarm_hum1"], "disciplines": ["facilities", "electrician"]},
    {"alarm_keys": ["alarm_sensor1"], "disciplines": ["hardware", "hall_lead"]},
    {"alarm_keys": ["alarm_l1_current", "alarm_l2_current", "alarm_l3_current"], "disciplines": ["electrician"]},
    {"alarm_keys": ["*offline*", "*unreachable*"], "disciplines": ["network", "hall_lead"]},
    {"alarm_keys": ["*_load", "alarm_outlet", "cable", "outlet"], "disciplines": ["electrician", "network", "hardware", "hall_lead"]},
]

DEFAULT_ESCALATION = {
    "reminder_sec": 180,
    "lead_sec": 300,
    "secondary_sec": 480,
    "admin_sec": 720,
}

DEFAULT_STORE: Dict[str, Any] = {
    "site_name": "Bangkok DC1",
    "halls": [],
    "subscribers": [],
    "pools": {},
    "routing_rules": DEFAULT_ROUTING,
    "escalation_policy": DEFAULT_ESCALATION,
    "onboarding": {},
}


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load() -> Dict[str, Any]:
    path = store_path("ops_teams.json")
    if not os.path.exists(path):
        return json.loads(json.dumps(DEFAULT_STORE))
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        data = {}
    merged = json.loads(json.dumps(DEFAULT_STORE))
    merged.update(data)
    if not merged.get("routing_rules"):
        merged["routing_rules"] = DEFAULT_ROUTING
    if not merged.get("escalation_policy"):
        merged["escalation_policy"] = DEFAULT_ESCALATION
    return merged


def _save(data: Dict[str, Any]) -> None:
    path = store_path("ops_teams.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def _pool_key(hall_id: str, discipline: str) -> str:
    return f"{hall_id}:{discipline}"


def ensure_hall_from_db() -> str:
    """Ensure ops-hall entries exist in the store; return the primary hall slug.

    - demo namespace: single Agoda demo hall (slug 'agoda-cage'), demo DB.
    - ops namespace: one ops-hall per REAL hall (slug 'hall-<db_id>'), main DB.
    """
    from db import HallRepo

    if is_ops_namespace():
        return _ensure_ops_halls_from_db()

    from demo.context import activate_demo_db
    activate_demo_db()
    hall_db_id = None
    hall_name = DEMO_HALL_NAME
    for h in HallRepo.get_all():
        if h.get("name") == DEMO_HALL_NAME:
            hall_db_id = h["id"]
            hall_name = h.get("name") or DEMO_HALL_NAME
            break
    if not hall_db_id:
        halls = HallRepo.get_all()
        if halls:
            hall_db_id = halls[0]["id"]
            hall_name = halls[0].get("name") or DEMO_HALL_NAME

    slug = "agoda-cage"
    with _lock:
        data = _load()
        halls = data.get("halls") or []
        found = next((h for h in halls if h.get("id") == slug), None)
        if not found:
            halls.append({
                "id": slug,
                "name": hall_name,
                "hall_db_id": hall_db_id,
                "invite_token": secrets.token_urlsafe(16),
            })
            data["halls"] = halls
            _save(data)
        else:
            slug = found["id"]
    _ensure_pools_for_hall(slug)
    return slug


def hall_slug_for_db_id(hall_db_id: Optional[int]) -> str:
    """Stable ops-hall slug for a real hall DB id."""
    return f"hall-{hall_db_id}" if hall_db_id else "hall-default"


def _ensure_ops_halls_from_db() -> str:
    """Register an ops-hall (with invite token + pools) for every real hall."""
    from db import HallRepo

    real_halls = HallRepo.get_all() or []
    primary_slug = "hall-default"
    with _lock:
        data = _load()
        halls = data.get("halls") or []
        by_slug = {h.get("id"): h for h in halls}
        for idx, h in enumerate(real_halls):
            slug = hall_slug_for_db_id(h.get("id"))
            if idx == 0:
                primary_slug = slug
            if slug not in by_slug:
                halls.append({
                    "id": slug,
                    "name": h.get("name") or slug,
                    "hall_db_id": h.get("id"),
                    "invite_token": secrets.token_urlsafe(16),
                })
                by_slug[slug] = halls[-1]
        if not real_halls and "hall-default" not in by_slug:
            halls.append({
                "id": "hall-default",
                "name": "Production Hall",
                "hall_db_id": None,
                "invite_token": secrets.token_urlsafe(16),
            })
        data["halls"] = halls
        _save(data)
    for h in (real_halls or [{"id": None}]):
        _ensure_pools_for_hall(hall_slug_for_db_id(h.get("id")))
    return primary_slug


def _ensure_pools_for_hall(hall_id: str) -> None:
    with _lock:
        data = _load()
        pools = data.setdefault("pools", {})
        for disc in DISCIPLINES:
            pk = _pool_key(hall_id, disc)
            if pk not in pools:
                pools[pk] = {"member_ids": [], "cursor": 0}
        _save(data)


def seed_demo_subscribers() -> None:
    """Fictional roster for demo UI (no real Telegram ids until live subscribe).

    Hard guard: never write the fictional roster into the production ops store.
    Production subscribers only ever arrive via real Telegram subscribe flow.
    """
    if is_ops_namespace():
        return
    hall_id = ensure_hall_from_db()
    demo_roster = [
        ("sub_somchai", "Somchai K.", "electrician", ["agoda-cage", "cloud-b"]),
        ("sub_priya", "Priya N.", "network", ["agoda-cage"]),
        ("sub_wei", "Wei L.", "hardware", ["agoda-cage"]),
        ("sub_marc", "Marc D.", "facilities", ["agoda-cage", "cloud-b"]),
        ("sub_anita", "Anita R.", "hall_lead", ["agoda-cage"]),
        ("sub_jira", "Jirawat P.", "electrician", ["agoda-cage"]),
        ("sub_kanya", "Kanya S.", "electrician", ["agoda-cage"]),
    ]
    with _lock:
        data = _load()
        existing = {s["id"] for s in data.get("subscribers") or []}
        subs = list(data.get("subscribers") or [])
        for sid, name, disc, halls in demo_roster:
            if sid in existing:
                continue
            subs.append({
                "id": sid,
                "display_name": name,
                "discipline": disc,
                "hall_ids": halls,
                "telegram_user_id": None,
                "telegram_chat_id": None,
                "status": "demo_seed",
                "subscribed_at": _utc_iso(),
                "source": "seed",
            })
        data["subscribers"] = subs
        pools = data.setdefault("pools", {})
        for disc in DISCIPLINES:
            pk = _pool_key(hall_id, disc)
            member_ids = [
                s["id"] for s in subs
                if disc in (s.get("discipline"),) and hall_id in (s.get("hall_ids") or [])
            ]
            pools[pk] = {"member_ids": member_ids, "cursor": 0}
        if not any(h.get("id") == "cloud-b" for h in data.get("halls") or []):
            data.setdefault("halls", []).append({
                "id": "cloud-b",
                "name": "Cloud Cage B",
                "hall_db_id": None,
                "invite_token": secrets.token_urlsafe(16),
            })
        _save(data)


def get_teams_dashboard() -> Dict[str, Any]:
    from demo.integrations import get_frontend_base_url, subscribe_landing_url

    ensure_hall_from_db()
    base_url = get_frontend_base_url()
    with _lock:
        data = _load()
    halls = data.get("halls") or []
    subs = data.get("subscribers") or []
    pools = data.get("pools") or {}
    org = {
        "site_name": data.get("site_name") or "Bangkok DC1",
        "halls": [],
        "subscriber_count": len(subs),
        "active_count": len([s for s in subs if s.get("status") in ("active", "demo_seed")]),
    }
    for hall in halls:
        hid = hall["id"]
        disciplines = []
        for disc in DISCIPLINES:
            pk = _pool_key(hid, disc)
            pool = pools.get(pk) or {"member_ids": [], "cursor": 0}
            members = [s for s in subs if s["id"] in pool.get("member_ids", [])]
            next_id = None
            if pool.get("member_ids"):
                idx = int(pool.get("cursor") or 0) % len(pool["member_ids"])
                next_id = pool["member_ids"][idx]
            next_name = next((s["display_name"] for s in subs if s["id"] == next_id), None)
            disciplines.append({
                "id": disc,
                "label": DISCIPLINE_LABELS.get(disc, disc),
                "count": len(members),
                "next_primary_id": next_id,
                "next_primary_name": next_name,
                "member_ids": pool.get("member_ids") or [],
            })
        org["halls"].append({
            **hall,
            "disciplines": disciplines,
            "invite_url_token": hall.get("invite_token"),
            "subscribe_url": subscribe_landing_url(hall.get("invite_token", "")),
        })
    return {
        "org": org,
        "frontend_base_url": base_url,
        "subscribers": [_public_subscriber(s) for s in subs],
        "routing_rules": data.get("routing_rules") or DEFAULT_ROUTING,
        "escalation_policy": data.get("escalation_policy") or DEFAULT_ESCALATION,
    }


def _public_subscriber(s: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": s.get("id"),
        "display_name": s.get("display_name"),
        "discipline": s.get("discipline"),
        "discipline_label": DISCIPLINE_LABELS.get(s.get("discipline", ""), s.get("discipline")),
        "hall_ids": s.get("hall_ids") or [],
        "status": s.get("status"),
        "subscribed_at": s.get("subscribed_at"),
        "telegram_linked": bool(s.get("telegram_chat_id")),
        "is_demo_seed": s.get("status") == "demo_seed",
    }


def update_pool_order(hall_id: str, discipline: str, member_ids: List[str]) -> Dict[str, Any]:
    with _lock:
        data = _load()
        pk = _pool_key(hall_id, discipline)
        pool = data.setdefault("pools", {}).setdefault(pk, {"member_ids": [], "cursor": 0})
        pool["member_ids"] = member_ids
        if pool["cursor"] >= len(member_ids):
            pool["cursor"] = 0
        _save(data)
    return get_teams_dashboard()


def update_escalation_policy(policy: Dict[str, Any]) -> Dict[str, Any]:
    with _lock:
        data = _load()
        cur = data.get("escalation_policy") or {}
        cur.update({k: int(v) for k, v in policy.items() if k in DEFAULT_ESCALATION})
        data["escalation_policy"] = cur
        _save(data)
    return get_teams_dashboard()


def get_invite_by_token(token: str) -> Optional[Dict[str, Any]]:
    with _lock:
        data = _load()
    for hall in data.get("halls") or []:
        if hall.get("invite_token") == token:
            return hall
    return None


def resolve_disciplines_for_alarm(alarm_key: str) -> List[str]:
    key = (alarm_key or "").lower()
    if "_load" in key or "outlet" in key:
        return ["electrician", "network", "hardware", "hall_lead"]
    with _lock:
        rules = (_load().get("routing_rules") or DEFAULT_ROUTING)
    for rule in rules:
        for pattern in rule.get("alarm_keys") or []:
            p = pattern.lower().replace("*", "")
            if p and p in key:
                return list(rule.get("disciplines") or [])
    return ["electrician"]


def hall_id_for_pdu_ip(ip: str) -> str:
    """Ops hall slug for the PDU's actual data hall (not the default/first hall)."""
    from db import PDURepo
    pdu = PDURepo.get_by_ip(ip) if ip else None
    if pdu and pdu.get("hall_id"):
        return hall_slug_for_db_id(pdu["hall_id"])
    return ensure_hall_from_db()


def active_subscribers_for_hall(hall_id: str) -> List[Dict[str, Any]]:
    """All active Telegram-linked subscribers assigned to a hall."""
    with _lock:
        data = _load()
        subs = data.get("subscribers") or []
    return [
        s for s in subs
        if hall_id in (s.get("hall_ids") or [])
        and s.get("telegram_chat_id")
        and s.get("status") == "active"
    ]


def pick_primary_subscriber(hall_id: str, alarm_key: str) -> Optional[Dict[str, Any]]:
    disciplines = resolve_disciplines_for_alarm(alarm_key)
    if not disciplines:
        disciplines = ["electrician"]
    with _lock:
        data = _load()
        subs = {s["id"]: s for s in data.get("subscribers") or []}

        def _live_ids(pool: Dict[str, Any]) -> List[str]:
            return [
                mid for mid in pool.get("member_ids") or []
                if subs.get(mid, {}).get("telegram_chat_id")
                and subs.get(mid, {}).get("status") == "active"
            ]

        for primary_disc in disciplines:
            pk = _pool_key(hall_id, primary_disc)
            pool = data.get("pools", {}).get(pk) or {"member_ids": [], "cursor": 0}
            ids = _live_ids(pool)
            if not ids:
                continue
            idx = int(pool.get("cursor") or 0) % len(ids)
            sub_id = ids[idx]
            sub = subs.get(sub_id)
            if sub:
                return {**sub, "pool_discipline": primary_disc, "pool_key": pk}

        # Routed pools empty — fall back to any active subscriber in this hall
        for sub in subs.values():
            if (
                hall_id in (sub.get("hall_ids") or [])
                and sub.get("telegram_chat_id")
                and sub.get("status") == "active"
            ):
                return {**sub, "pool_discipline": sub.get("discipline"), "pool_key": None}
    return None


def advance_pool_cursor(pool_key: str) -> None:
    with _lock:
        data = _load()
        pool = data.get("pools", {}).get(pool_key)
        if not pool or not pool.get("member_ids"):
            return
        pool["cursor"] = (int(pool.get("cursor") or 0) + 1) % len(pool["member_ids"])
        _save(data)


def subscribers_for_escalation(hall_id: str, level: int, alarm_key: str) -> List[Dict[str, Any]]:
    """level 0=primary only (handled elsewhere), 1=leads, 2=secondary disc, 3=all active."""
    with _lock:
        data = _load()
        subs = data.get("subscribers") or []
    disciplines = resolve_disciplines_for_alarm(alarm_key)
    result = []
    if level == 1:
        result = [s for s in subs if hall_id in (s.get("hall_ids") or []) and s.get("discipline") == "hall_lead" and s.get("telegram_chat_id")]
    elif level == 2:
        secondary = disciplines[1:2] or ["facilities"]
        for disc in secondary:
            result.extend([
                s for s in subs
                if hall_id in (s.get("hall_ids") or []) and s.get("discipline") == disc and s.get("telegram_chat_id")
            ])
    elif level >= 3:
        result = [s for s in subs if hall_id in (s.get("hall_ids") or []) and s.get("telegram_chat_id") and s.get("status") == "active"]
    return result


def find_subscriber_by_chat(chat_id: str) -> Optional[Dict[str, Any]]:
    with _lock:
        data = _load()
    for s in data.get("subscribers") or []:
        if str(s.get("telegram_chat_id")) == str(chat_id):
            return s
    return None


def upsert_subscriber_from_telegram(
    chat_id: str,
    user_id: str,
    display_name: str,
    hall_id: str,
    discipline: str,
    extra_halls: Optional[List[str]] = None,
) -> Dict[str, Any]:
    hall_ids = list(dict.fromkeys([hall_id] + (extra_halls or [])))
    with _lock:
        data = _load()
        subs = data.get("subscribers") or []
        existing = next((s for s in subs if str(s.get("telegram_chat_id")) == str(chat_id)), None)
        if existing:
            existing["display_name"] = display_name
            existing["discipline"] = discipline
            existing["hall_ids"] = hall_ids
            existing["status"] = "active"
            existing["updated_at"] = _utc_iso()
            sub = existing
        else:
            sub = {
                "id": f"sub_{secrets.token_hex(6)}",
                "display_name": display_name,
                "discipline": discipline,
                "hall_ids": hall_ids,
                "telegram_user_id": str(user_id),
                "telegram_chat_id": str(chat_id),
                "status": "active",
                "subscribed_at": _utc_iso(),
                "source": "telegram",
            }
            subs.append(sub)
        data["subscribers"] = subs
        pools = data.setdefault("pools", {})
        for hid in hall_ids:
            for disc in DISCIPLINES:
                pk = _pool_key(hid, disc)
                pool = pools.setdefault(pk, {"member_ids": [], "cursor": 0})
                if sub["discipline"] == disc and sub["id"] not in pool["member_ids"]:
                    pool["member_ids"].append(sub["id"])
        _save(data)
    return sub


def get_onboarding(chat_id: str) -> Dict[str, Any]:
    with _lock:
        data = _load()
    return (data.get("onboarding") or {}).get(str(chat_id)) or {}


def set_onboarding(chat_id: str, state: Dict[str, Any]) -> None:
    with _lock:
        data = _load()
        ob = data.setdefault("onboarding", {})
        ob[str(chat_id)] = state
        _save(data)


def clear_onboarding(chat_id: str) -> None:
    with _lock:
        data = _load()
        ob = data.get("onboarding") or {}
        ob.pop(str(chat_id), None)
        data["onboarding"] = ob
        _save(data)


def compute_analytics(days: int = 30) -> Dict[str, Any]:
    from demo.incidents import list_incidents_for_dashboard

    incidents = list_incidents_for_dashboard().get("incidents") or []
    open_count = len([i for i in incidents if not i.get("closed")])
    ack_times = []
    resolve_times = []
    escalations = 0
    for inc in incidents:
        ledger = inc.get("ledger") or []
        created = inc.get("created_at")
        ack_at = inc.get("acknowledged_at")
        resolved_at = inc.get("resolved_at")
        if any(e.get("step", "").startswith("ESCALAT") for e in ledger):
            escalations += 1
        if created and ack_at:
            try:
                c = datetime.fromisoformat(created)
                a = datetime.fromisoformat(ack_at)
                ack_times.append((a - c).total_seconds())
            except ValueError:
                pass
        if created and resolved_at:
            try:
                c = datetime.fromisoformat(created)
                r = datetime.fromisoformat(resolved_at)
                resolve_times.append((r - c).total_seconds())
            except ValueError:
                pass

    def _median(vals: List[float]) -> Optional[float]:
        if not vals:
            return None
        s = sorted(vals)
        m = len(s) // 2
        return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2

    med_ack = _median(ack_times)
    med_res = _median(resolve_times)
    return {
        "incident_count": len(incidents),
        "open_count": open_count,
        "escalation_count": escalations,
        "median_ack_sec": med_ack,
        "median_resolve_sec": med_res,
        "primary_miss_rate": round(escalations / max(len(incidents), 1), 2),
        "swimlane": _build_swimlane(incidents),
    }


def _hall_layout_snapshot() -> Dict[str, Any]:
    """Hall wireframe layout for live dispatch navigation map."""
    from demo.incidents import _demo_hall_id
    from db import HallRepo, RackRepo

    if not is_ops_namespace():
        from demo.context import activate_demo_db
        activate_demo_db()
    hall_id = _demo_hall_id()
    if not hall_id:
        return {"hall": {"length_m": 20, "width_m": 12, "name": "Demo Hall"}, "racks": []}
    hall = HallRepo.get(hall_id)
    config_row = HallRepo.get_latest_config(hall_id)
    config = (config_row or {}).get("config") or {}
    hall_dims = config.get("hall") or {}
    length = float(hall_dims.get("length") or 20)
    width = float(hall_dims.get("width") or 12)
    racks_out = []
    for rack in RackRepo.get_by_hall(hall_id):
        racks_out.append({
            "rack_code": rack.get("rack_code"),
            "x_m": rack.get("x_m"),
            "z_m": rack.get("z_m"),
            "width_mm": rack.get("width_mm") or 600,
            "depth_mm": rack.get("depth_mm") or 1000,
            "label": rack.get("label") or rack.get("rack_code"),
        })
    return {
        "hall": {
            "name": hall.get("name") if hall else "Demo Hall",
            "length_m": length,
            "width_m": width,
        },
        "racks": racks_out,
    }


def _build_swimlane(incidents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Per-incident phase timestamps for analytics UI."""
    phases = [
        ("detect", "ALARM_DETECTED"),
        ("assign", "ASSIGNED_PRIMARY"),
        ("notify", "NOTIFY_TELEGRAM"),
        ("ack", "ACK_DISPATCH"),
        ("resolve", "RESOLVED_CLAIMED"),
        ("verify", "SYSTEM_VERIFIED"),
        ("close", "INCIDENT_CLOSED"),
    ]
    sorted_incidents = sorted(
        incidents,
        key=lambda i: i.get("updated_at") or i.get("created_at") or "",
        reverse=True,
    )
    rows = []
    for inc in sorted_incidents[:50]:
        ledger = {e.get("step"): e.get("ts") for e in (inc.get("ledger") or [])}
        inc_data = inc.get("incident") or {}
        closed = bool(inc.get("closed"))
        resolved = bool(inc.get("resolved")) or bool(ledger.get("RESOLVED_CLAIMED"))
        rows.append({
            "token": inc.get("token"),
            "label": inc_data.get("label") or inc_data.get("ip"),
            "rack": inc_data.get("rack"),
            "severity": inc_data.get("severity"),
            "closed": closed,
            "resolved": resolved,
            "pending": not closed and not resolved,
            "created_at": inc.get("created_at"),
            "updated_at": inc.get("updated_at"),
            "closed_at": inc.get("closed_at"),
            "phases": {name: ledger.get(step) for name, step in phases},
            "escalated": any((e.get("step") or "").startswith("ESCALAT") for e in (inc.get("ledger") or [])),
        })
    return rows
