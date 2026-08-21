"""Demo-only notification integrations (Telegram MVP + workflow ledger)."""
from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import requests

from demo.config import DATA_DIR, store_path, is_ops_namespace

_CONFIG_PATH = os.path.join(DATA_DIR, "demo_integrations.json")  # legacy default (demo)
_lock = threading.Lock()
_MAX_WORKFLOW = 200
_TECHNICIAN_SUPPRESS_HOURS = 24
_TELEGRAM_TOKEN_RE = re.compile(r"^\d{8,}:[A-Za-z0-9_-]{20,}$")
_INVALID_TOKEN_LITERALS = frozenset({"demo", "password", "admin", "test", "token"})

_DEFAULT_CONFIG: Dict[str, Any] = {
    "telegram": {
        "enabled": False,
        "bot_token": "",
        "chat_id": "",
    },
    "email": {"enabled": False, "status": "coming_soon"},
    "whatsapp": {"enabled": False, "status": "coming_soon"},
    "notify_on_alarm": True,
    "frontend_base_url": "",
    "active_incidents": {},
    "workflow": [],
}


def _default_frontend_base_url() -> str:
    """Public URL for mobile/subscribe links — Tailscale LAN IP when configured."""
    explicit = os.getenv("PDUMIND_FRONTEND_URL", "").strip().rstrip("/")
    if explicit:
        return explicit
    hub_ip = os.getenv("HUB_LAN_IP", "").strip()
    hub_port = os.getenv("HUB_PORT", "3000").strip() or "3000"
    if hub_ip:
        return f"http://{hub_ip}:{hub_port}"
    return "http://localhost:3000"


def get_frontend_base_url() -> str:
    cfg = _load_raw()
    base = (cfg.get("frontend_base_url") or "").strip().rstrip("/")
    if base:
        return base
    return _default_frontend_base_url()


def subscribe_landing_url(invite_token: str) -> str:
    return f"{get_frontend_base_url()}/subscribe/{invite_token}"


def get_telegram_bot_username(cfg: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """Cached bot @username — no live Telegram call on public mobile pages."""
    data = cfg if cfg is not None else _load_raw()
    tg = data.get("telegram") or {}
    cached = (tg.get("bot_username") or "").strip().lstrip("@")
    if cached:
        return cached
    token = (tg.get("bot_token") or "").strip()
    if not _valid_telegram_token(token):
        return None
    try:
        url = f"https://api.telegram.org/bot{token}/getMe"
        resp = requests.get(url, timeout=5)
        payload = resp.json()
        if payload.get("ok"):
            username = (payload.get("result") or {}).get("username")
            if username:
                with _lock:
                    raw = _load_raw()
                    raw.setdefault("telegram", {})["bot_username"] = username
                    _save_raw(raw)
                return username
    except requests.RequestException:
        pass
    return None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def suppress_alarm_redispatch(fingerprint: str, hours: int = _TECHNICIAN_SUPPRESS_HOURS) -> None:
    """After technician resolve — do not spawn a new dispatch for the same live alarm."""
    if not fingerprint:
        return
    until = datetime.now(timezone.utc) + timedelta(hours=hours)
    with _lock:
        cfg = _load_raw()
        suppress = dict(cfg.get("technician_resolved_fps") or {})
        suppress[fingerprint] = until.isoformat(timespec="seconds")
        cfg["technician_resolved_fps"] = suppress
        _save_raw(cfg)


def is_alarm_redispatch_suppressed(fingerprint: str) -> bool:
    if not fingerprint:
        return False
    with _lock:
        cfg = _load_raw()
        until_iso = (cfg.get("technician_resolved_fps") or {}).get(fingerprint)
    if not until_iso:
        return False
    try:
        until = datetime.fromisoformat(until_iso)
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) < until
    except ValueError:
        return False


def clear_alarm_suppression(fingerprint: str) -> None:
    if not fingerprint:
        return
    with _lock:
        cfg = _load_raw()
        suppress = dict(cfg.get("technician_resolved_fps") or {})
        if fingerprint in suppress:
            suppress.pop(fingerprint)
            cfg["technician_resolved_fps"] = suppress
            _save_raw(cfg)


def _load_raw() -> Dict[str, Any]:
    path = store_path("integrations.json")
    if not os.path.exists(path):
        return json.loads(json.dumps(_DEFAULT_CONFIG))
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        data = {}
    merged = json.loads(json.dumps(_DEFAULT_CONFIG))
    merged.update(data)
    merged["telegram"] = {**_DEFAULT_CONFIG["telegram"], **(data.get("telegram") or {})}
    merged["email"] = {**_DEFAULT_CONFIG["email"], **(data.get("email") or {})}
    merged["whatsapp"] = {**_DEFAULT_CONFIG["whatsapp"], **(data.get("whatsapp") or {})}
    return merged


def _save_raw(data: Dict[str, Any]) -> None:
    path = store_path("integrations.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def _mask_token(token: str) -> str:
    if not token:
        return ""
    if len(token) <= 8:
        return "••••••••"
    return f"{'•' * (len(token) - 4)}{token[-4:]}"


def _valid_telegram_token(token: str) -> bool:
    t = (token or "").strip()
    if not t or t.lower() in _INVALID_TOKEN_LITERALS:
        return False
    return bool(_TELEGRAM_TOKEN_RE.match(t))


def _append_workflow(data: Dict[str, Any], step: str, detail: str, meta: Optional[Dict] = None) -> None:
    entry = {
        "ts": _utc_now(),
        "step": step,
        "detail": detail,
        "meta": meta or {},
    }
    workflow = data.get("workflow") or []
    workflow.insert(0, entry)
    data["workflow"] = workflow[:_MAX_WORKFLOW]


def get_public_config() -> Dict[str, Any]:
    with _lock:
        data = _load_raw()
        tg = data.get("telegram") or {}
        raw_token = tg.get("bot_token") or ""
        return {
            "telegram": {
                "enabled": bool(tg.get("enabled")),
                "configured": bool(_valid_telegram_token(raw_token) and tg.get("chat_id")),
                "chat_id": tg.get("chat_id") or "",
                "bot_token_masked": _mask_token(raw_token),
                "has_token": bool(_valid_telegram_token(raw_token)),
                "token_last4": raw_token[-4:] if _valid_telegram_token(raw_token) and len(raw_token) >= 4 else "",
                "token_saved_at": tg.get("token_saved_at"),
            },
            "email": {"enabled": False, "status": "coming_soon", "label": "Email"},
            "whatsapp": {"enabled": False, "status": "coming_soon", "label": "WhatsApp"},
            "notify_on_alarm": bool(data.get("notify_on_alarm", True)),
            "frontend_base_url": data.get("frontend_base_url") or get_frontend_base_url(),
            "workflow": (data.get("workflow") or [])[:30],
            "active_incident_count": len(data.get("active_incidents") or {}),
        }


def update_config(payload: Dict[str, Any]) -> Dict[str, Any]:
    with _lock:
        data = _load_raw()
        tg_in = payload.get("telegram") or {}
        tg = data.setdefault("telegram", {})
        if "enabled" in tg_in:
            tg["enabled"] = bool(tg_in["enabled"])
        if "chat_id" in tg_in:
            tg["chat_id"] = str(tg_in["chat_id"] or "").strip()
        if "bot_token" in tg_in:
            raw = str(tg_in.get("bot_token") or "").strip()
            if raw:
                if not _valid_telegram_token(raw):
                    return {
                        "error": (
                            "Invalid Telegram bot token. Paste the full token from @BotFather "
                            "(format 123456789:ABCdef…). Do not use your PDUMind login password."
                        ),
                        "code": "INVALID_BOT_TOKEN",
                    }
                tg["bot_token"] = raw
                tg["token_saved_at"] = _utc_now()
        if "notify_on_alarm" in payload:
            data["notify_on_alarm"] = bool(payload["notify_on_alarm"])
        if payload.get("frontend_base_url"):
            data["frontend_base_url"] = str(payload["frontend_base_url"]).strip().rstrip("/")
        _append_workflow(data, "CONFIG_UPDATED", "Integration settings saved", {"telegram_enabled": tg.get("enabled")})
        _save_raw(data)
    return get_public_config()


def _friendly_telegram_error(err: str) -> str:
    if not err:
        return "Telegram API error"
    low = err.lower()
    if (
        "name or service not known" in low
        or "failed to resolve" in low
        or "nameresolutionerror" in low
        or "temporary failure in name resolution" in low
        or "nodename nor servname provided" in low
    ):
        return (
            "Cannot reach api.telegram.org (DNS/network). "
            "The backend container has no outbound DNS — restart Docker after updating compose DNS, "
            "or verify the host has internet access."
        )
    if "not found" in low and "chat" not in low:
        return (
            "Invalid or revoked Telegram bot token. "
            "Open @BotFather → your bot → API Token, copy the full token, paste it here, then Save & send test."
        )
    if "chat not found" in low or "peer_id_invalid" in low:
        return (
            "Chat ID not found. Send /start to your bot in Telegram first, "
            "then use @userinfobot for your numeric chat ID."
        )
    return err


def send_telegram_message(text: str, parse_mode: str = "HTML", chat_id: Optional[str] = None) -> Dict[str, Any]:
    with _lock:
        data = _load_raw()
        tg = data.get("telegram") or {}
        token = (tg.get("bot_token") or "").strip()
        target = (chat_id or tg.get("chat_id") or "").strip()
    if not _valid_telegram_token(token) or not target:
        return {"success": False, "error": "Telegram bot token and chat ID are required"}
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        resp = requests.post(
            url,
            json={"chat_id": target, "text": text, "parse_mode": parse_mode, "disable_web_page_preview": False},
            timeout=15,
        )
        body = resp.json()
        if not resp.ok or not body.get("ok"):
            err = body.get("description") or resp.text or "Telegram API error"
            return {"success": False, "error": _friendly_telegram_error(err)}
        return {"success": True, "message_id": body.get("result", {}).get("message_id")}
    except requests.RequestException as exc:
        return {"success": False, "error": str(exc)}


def send_telegram_test() -> Dict[str, Any]:
    from demo.incidents import create_test_incident_token, incident_public_url

    with _lock:
        data = _load_raw()
        base = data.get("frontend_base_url") or get_frontend_base_url()
    token, incident = create_test_incident_token()
    link = incident_public_url(base, token)
    dispatch_result = _dispatch_new_alarm(incident, token, base)
    if not dispatch_result.get("success"):
        rack = incident.get("rack") or "—"
        label = incident.get("label") or incident.get("ip")
        text = (
            "<b>PDUMind Demo — Telegram connected</b>\n\n"
            f"Sample alert: <b>{label}</b> @ {rack}\n"
            "Secure link — no login, wireframe map + issue list:\n"
            f'<a href="{link}">📱 Open mobile incident view</a>'
        )
        dispatch_result = send_telegram_message(text)
        if dispatch_result.get("success"):
            from demo.incidents import append_incident_ledger
            append_incident_ledger(token, "NOTIFY_TELEGRAM", "Test alert (legacy chat fallback)", "pdumind", {"channel": "telegram", "test": True})
    result = dispatch_result
    with _lock:
        data = _load_raw()
        if result.get("success"):
            _append_workflow(
                data,
                "TELEGRAM_TEST",
                "Test dispatch with round-robin + incident link",
                {"message_id": result.get("message_id"), "incident_url": link, "token": token[:8] + "…"},
            )
        else:
            _append_workflow(data, "TELEGRAM_TEST_FAILED", result.get("error", "Test failed"))
        _save_raw(data)
    if result.get("success"):
        get_telegram_bot_username()
        result["incident_url"] = link
        result["incident_token"] = token
    return result


def _alarm_label(key: str, incident: Optional[Dict[str, Any]] = None) -> str:
    import re
    if incident and incident.get("outlet_code"):
        return f"Outlet {incident['outlet_code']} — Cable Disconnected"
    m = re.match(r"^alarm_outlet(\d+)_load$", key)
    if m:
        return f"Outlet {m.group(1)} — Cable Disconnected"
    labels = {
        "alarm_temp1": "Temperature Sensor 1",
        "alarm_hum1": "Humidity Sensor 1",
        "alarm_sensor1": "Door / IO Sensor",
        "alarm_l1_current": "Phase L1 Current",
    }
    return labels.get(key, key.replace("alarm_", "").replace("_", " ").title())


def _build_incident_message(incident: Dict[str, Any], base_url: str, token: str) -> str:
    from demo.incidents import incident_public_url

    sev = incident.get("severity", "warning").upper()
    label = incident.get("label") or incident.get("ip")
    rack = incident.get("rack_label") or incident.get("rack") or "—"
    link = incident_public_url(base_url, token)
    outlet_code = incident.get("outlet_code")
    if outlet_code or (incident.get("key") or "").endswith("_load"):
        mount = incident.get("mount_position") or "A"
        value = incident.get("value") or "Cable disconnected from outlet"
        return (
            f"<b>🚨 PDUMind — Cable Unplugged ({sev})</b>\n\n"
            f"<b>Rack:</b> {rack}\n"
            f"<b>PDU:</b> {label} (slot {mount})\n"
            f"<b>Outlet:</b> {outlet_code or '—'}\n"
            f"<b>Detail:</b> {value}\n"
            f"<b>Time:</b> {_utc_now()}\n\n"
            f'<a href="{link}">📱 Open mobile incident view</a>'
        )
    alarm = _alarm_label(incident.get("key", ""), incident)
    value = incident.get("value", "")
    return (
        f"<b>🚨 PDUMind Alarm — {sev}</b>\n\n"
        f"<b>PDU:</b> {label}\n"
        f"<b>Rack:</b> {rack}\n"
        f"<b>Issue:</b> {alarm}: {value}\n"
        f"<b>Time:</b> {_utc_now()}\n\n"
        f'<a href="{link}">📱 Open mobile incident view</a>'
    )


def _collect_incidents_demo() -> List[Dict[str, Any]]:
    from demo.context import activate_demo_db
    from demo.simulator import get_demo_fleet_telemetry
    from db import PDURepo, RackRepo

    activate_demo_db()
    fleet = get_demo_fleet_telemetry()
    incidents = []
    for pdu in fleet.get("pdus") or []:
        if not pdu.get("online"):
            continue
        db_pdu = PDURepo.get_by_ip(pdu["ip"])
        rack_code = pdu.get("rack_code") or pdu.get("location")
        if db_pdu and db_pdu.get("rack_id"):
            rack = RackRepo.get(db_pdu["rack_id"])
            if rack:
                rack_code = rack.get("rack_code") or rack_code
        for entry in pdu.get("alarm_entries") or []:
            val = (entry.get("value") or "").strip()
            if not val or val.lower() in ("normal", "-", ""):
                continue
            key = entry.get("key", "")
            sev = "critical" if val.lower() in ("critical", "open") else "warning"
            incidents.append({
                "fingerprint": f"{pdu['ip']}:{key}:{val}",
                "ip": pdu["ip"],
                "label": pdu.get("label") or pdu["ip"],
                "rack": rack_code,
                "key": key,
                "value": val,
                "severity": sev,
            })
    return incidents


def _collect_incidents() -> List[Dict[str, Any]]:
    """Collect alarm incidents — always prefer live poller when ops is enabled."""
    from demo.config import ops_enabled
    if ops_enabled() or is_ops_namespace():
        return _collect_incidents_ops()
    return _collect_incidents_demo()


def _outlet_incident_fields(fl: Dict[str, Any], db_pdu: Optional[Dict[str, Any]], rack: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    import re
    param = (fl.get("param") or "").strip()
    m = re.match(r"^outlet(\d+)_load$", param)
    if not m:
        return {}
    outlet_num = int(m.group(1))
    slot = (db_pdu or {}).get("mount_position") or "A"
    slot = str(slot).strip().upper()[:1] or "A"
    outlet_code = (fl.get("outlet_code") or f"{slot}{outlet_num:02d}").strip()
    detail = (fl.get("detail") or fl.get("status") or "Cable disconnected from outlet").strip()
    rack_label = (rack or {}).get("label") or (rack or {}).get("rack_code")
    return {
        "value": detail,
        "outlet_code": outlet_code,
        "mount_position": slot,
        "rack_label": rack_label,
    }


def _collect_incidents_ops() -> List[Dict[str, Any]]:
    """Production alarm source: real per-PDU _alarm_flags from the live poller cache.

    Emits the same incident dicts as the demo collector so the entire dispatch /
    escalation / token pipeline is reused unchanged. Uses the MAIN DB (no demo DB)
    for PDU label + rack resolution. Offline/unreachable PDUs are intentionally
    NOT auto-incidented here (avoids flooding when many PDUs are off-network)."""
    import json as _json
    import app as _app
    from db import PDURepo, RackRepo

    with _app.MULTI_PDU_LOCK:
        snapshot = {ip: dict(res) for ip, res in _app.MULTI_PDU_RESULTS.items()}

    incidents: List[Dict[str, Any]] = []
    for ip, results in snapshot.items():
        flags_entry = results.get("_alarm_flags")
        if not flags_entry:
            continue
        try:
            flags = _json.loads(flags_entry.get("value") or "[]")
        except (ValueError, TypeError):
            flags = []
        if not flags:
            continue
        db_pdu = PDURepo.get_by_ip(ip)
        label = (db_pdu or {}).get("name") or (db_pdu or {}).get("hostname") or ip
        rack = None
        rack_code = None
        if db_pdu and db_pdu.get("rack_id"):
            rack = RackRepo.get(db_pdu["rack_id"])
            if rack:
                rack_code = rack.get("rack_code")
        for fl in flags:
            param = (fl.get("param") or "").strip()
            if not param:
                continue
            status = (fl.get("status") or "Alarm").strip()
            key = f"alarm_{param}"
            sev = "critical" if ("current" in param and not param.endswith("_load")) or param.startswith("sensor") else "warning"
            extra = _outlet_incident_fields(fl, db_pdu, rack)
            value = extra.get("value") or status
            fp_suffix = extra.get("outlet_code") or status
            incidents.append({
                "fingerprint": f"{ip}:{key}:{fp_suffix}",
                "ip": ip,
                "label": label,
                "rack": rack_code,
                "key": key,
                "value": value,
                "severity": sev,
                "hall_db_id": (db_pdu or {}).get("hall_id"),
                **{k: v for k, v in extra.items() if k != "value"},
            })
    return incidents


def _is_outlet_load_incident(incident: Dict[str, Any]) -> bool:
    key = (incident.get("key") or "").lower()
    return key.endswith("_load") or bool(incident.get("outlet_code"))


def _prepare_alarm_dispatch_context() -> None:
    """Use production ops stores + main DB when ops is enabled (real cage PDUs)."""
    from demo.config import ops_enabled, set_ops_namespace
    from demo.context import deactivate_demo_db
    if ops_enabled():
        set_ops_namespace("ops")
        deactivate_demo_db()


def _hall_id_for_incident(incident: Dict[str, Any]) -> str:
    from demo import ops_teams
    hall_db_id = incident.get("hall_db_id")
    if hall_db_id:
        return ops_teams.hall_slug_for_db_id(hall_db_id)
    return ops_teams.hall_id_for_pdu_ip(incident.get("ip") or "")


def _incident_from_outlet_load(
    ip: str,
    outlet_num: int,
    results: Dict[str, Any],
    db_pdu: Optional[Dict[str, Any]],
    rack: Optional[Dict[str, Any]],
    rack_code: Optional[str],
) -> Dict[str, Any]:
    """Build an ops incident dict for a cable-unplug alarm on one outlet."""
    param = f"outlet{outlet_num}_load"
    flags: List[Dict[str, Any]] = []
    flags_entry = results.get("_alarm_flags")
    if flags_entry:
        try:
            flags = json.loads(flags_entry.get("value") or "[]")
        except (TypeError, ValueError):
            flags = []
    fl = next((f for f in flags if f.get("param") == param), None) or {
        "param": param,
        "status": "Load Lost",
        "outlet_num": outlet_num,
    }
    extra = _outlet_incident_fields(fl, db_pdu, rack)
    value = extra.get("value") or fl.get("detail") or "Cable disconnected from outlet"
    key = f"alarm_{param}"
    fp_suffix = extra.get("outlet_code") or str(outlet_num)
    label = (db_pdu or {}).get("name") or (db_pdu or {}).get("hostname") or ip
    return {
        "fingerprint": f"{ip}:{key}:{fp_suffix}",
        "ip": ip,
        "label": label,
        "rack": rack_code,
        "key": key,
        "value": value,
        "severity": "warning",
        "hall_db_id": (db_pdu or {}).get("hall_id"),
        **{k: v for k, v in extra.items() if k != "value"},
    }


def dispatch_outlet_load_alarms(
    ip: str,
    outlet_nums: set,
    results: Dict[str, Any],
) -> None:
    """Fire Telegram immediately when cable-unplug is detected (same poll cycle)."""
    if not ip or not outlet_nums or not results:
        return

    _prepare_alarm_dispatch_context()

    from db import PDURepo, RackRepo

    with _lock:
        cfg = _load_raw()
        if not cfg.get("notify_on_alarm", True):
            return
        tg = cfg.get("telegram") or {}
        if not tg.get("enabled") or not tg.get("bot_token"):
            return
        base_url = cfg.get("frontend_base_url") or get_frontend_base_url()

    db_pdu = PDURepo.get_by_ip(ip)
    rack = None
    rack_code = None
    if db_pdu and db_pdu.get("rack_id"):
        rack = RackRepo.get(db_pdu["rack_id"])
        if rack:
            rack_code = rack.get("rack_code")

    from demo.incidents import get_or_create_token

    for outlet_num in sorted(outlet_nums):
        incident = _incident_from_outlet_load(ip, outlet_num, results, db_pdu, rack, rack_code)
        fp = incident["fingerprint"]
        if is_alarm_redispatch_suppressed(fp):
            continue
        with _lock:
            cfg = _load_raw()
            if fp in (cfg.get("active_incidents") or {}):
                continue

        token = get_or_create_token(incident)
        print(
            f"[Integrations] Cable-unplug dispatch {ip} "
            f"{incident.get('outlet_code') or outlet_num} → hall "
            f"{_hall_id_for_incident(incident)}"
        )
        result = _dispatch_new_alarm(incident, token, base_url)
        if not result.get("success") and not result.get("skipped"):
            print(f"[Integrations] Cable-unplug dispatch failed: {result.get('error', result)}")

        with _lock:
            cfg = _load_raw()
            active = dict(cfg.get("active_incidents") or {})
            if result.get("success"):
                active[fp] = {**incident, "notified_at": _utc_now(), "token": token}
                _append_workflow(
                    cfg,
                    "ALARM_NOTIFIED",
                    f"Cable unplug — {incident.get('label')} {incident.get('outlet_code')}: {incident.get('value')}",
                    {"fingerprint": fp, "channel": "telegram", "incident_token": token[:12] + "…"},
                )
            else:
                _append_workflow(
                    cfg,
                    "ALARM_NOTIFY_FAILED",
                    result.get("error", "Cable-unplug notification failed"),
                    {"fingerprint": fp, "ip": ip, "outlet": incident.get("outlet_code")},
                )
            cfg["active_incidents"] = active
            _save_raw(cfg)


def _dispatch_team_broadcast(
    incident: Dict[str, Any], token: str, base_url: str, hall_id: str
) -> Dict[str, Any]:
    """Send alarm DM to every active Telegram subscriber in the PDU's hall."""
    from demo import ops_teams
    from demo import telegram_bot
    from demo.incidents import append_incident_ledger, _load_store, _save_store, _lock as inc_lock

    team = ops_teams.active_subscribers_for_hall(hall_id)
    if not team:
        team = ops_teams.subscribers_for_escalation(hall_id, 3, incident.get("key", ""))

    notified: List[str] = []
    last_error = "No team subscribers with Telegram for this hall"
    for sub in team:
        chat = sub.get("telegram_chat_id")
        if not chat:
            continue
        r = telegram_bot.send_primary_incident_dm(str(chat), token, incident, base_url)
        if r.get("ok"):
            notified.append(sub.get("display_name") or str(chat))
        else:
            last_error = r.get("description") or last_error

    if notified:
        with inc_lock:
            data = _load_store()
            rec = (data.get("incidents") or {}).get(token)
            if rec:
                rec["dispatch"] = {
                    "hall_id": hall_id,
                    "broadcast": True,
                    "notified_subscribers": notified,
                    "escalation_level": 0,
                    "last_notify_at": _utc_now(),
                }
                (data.get("incidents") or {})[token] = rec
                _save_store(data)
        append_incident_ledger(
            token,
            "NOTIFY_TELEGRAM",
            f"Team broadcast ({len(notified)}): {', '.join(notified)}",
            "pdumind",
            {"channel": "telegram", "broadcast": True, "count": len(notified)},
        )
        print(f"[Integrations] Team Telegram broadcast — {len(notified)} recipient(s) for {incident.get('key')}")
        return {"success": True, "broadcast": True, "notified": notified, "count": len(notified)}

    text = _build_incident_message(incident, base_url, token)
    result = send_telegram_message(text)
    if result.get("success"):
        append_incident_ledger(token, "NOTIFY_TELEGRAM", "Team broadcast fallback — legacy admin chat", "pdumind", {"channel": "telegram"})
    else:
        print(f"[Integrations] Team broadcast failed ({last_error}); legacy fallback: {result.get('error')}")
    return result


def _dispatch_new_alarm(incident: Dict[str, Any], token: str, base_url: str) -> Dict[str, Any]:
    """Notify ops team — cable-unplug broadcasts to all hall subscribers; others use round-robin primary."""
    from demo import ops_teams
    from demo import telegram_bot
    from demo.incidents import append_incident_ledger, _load_store, _save_store, _lock as inc_lock

    with inc_lock:
        data = _load_store()
        rec = (data.get("incidents") or {}).get(token)
        if rec:
            if rec.get("closed") or rec.get("resolved"):
                return {"success": False, "error": "incident already closed"}
            ledger_steps = {e.get("step") for e in (rec.get("ledger") or [])}
            if rec.get("dispatch", {}).get("last_notify_at") and "NOTIFY_TELEGRAM" in ledger_steps:
                return {"success": True, "skipped": "already_dispatched", "token": token}

    hall_id = _hall_id_for_incident(incident)

    if _is_outlet_load_incident(incident):
        return _dispatch_team_broadcast(incident, token, base_url, hall_id)

    primary = ops_teams.pick_primary_subscriber(hall_id, incident.get("key", ""))
    result: Dict[str, Any] = {"success": False}

    if primary and primary.get("telegram_chat_id"):
        chat = str(primary["telegram_chat_id"])
        result = telegram_bot.send_primary_incident_dm(chat, token, incident, base_url)
        if result.get("ok"):
            result = {"success": True, "message_id": (result.get("result") or {}).get("message_id"), "chat_id": chat}
            with inc_lock:
                data = _load_store()
                rec = (data.get("incidents") or {}).get(token)
                if rec:
                    rec["dispatch"] = {
                        "hall_id": hall_id,
                        "primary_subscriber_id": primary.get("id"),
                        "pool_key": primary.get("pool_key"),
                        "escalation_level": 0,
                        "last_notify_at": _utc_now(),
                        "owner_subscriber_id": None,
                    }
                    (data.get("incidents") or {})[token] = rec
                    _save_store(data)
            append_incident_ledger(
                token,
                "ASSIGNED_PRIMARY",
                f"Round-robin primary: {primary.get('display_name')} ({ops_teams.DISCIPLINE_LABELS.get(primary.get('pool_discipline',''), '')})",
                "pdumind",
                {"subscriber_id": primary.get("id")},
            )
            append_incident_ledger(
                token,
                "NOTIFY_TELEGRAM",
                f"PRIMARY alert sent to {primary.get('display_name')}",
                "pdumind",
                {"channel": "telegram", "chat_id": chat},
            )
            return result

    text = _build_incident_message(incident, base_url, token)
    result = send_telegram_message(text)
    if result.get("success"):
        append_incident_ledger(token, "NOTIFY_TELEGRAM", "Alert pushed to legacy admin chat", "pdumind", {"channel": "telegram"})
    return result


def _seconds_since(iso_ts: str) -> float:
    if not iso_ts:
        return 0.0
    try:
        from datetime import datetime, timedelta, timezone
        then = datetime.fromisoformat(iso_ts)
        if then.tzinfo is None:
            then = then.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - then).total_seconds()
    except ValueError:
        return 0.0


def process_escalations() -> None:
    """Auto-escalate open incidents without ack."""
    from demo import ops_teams
    from demo import telegram_bot
    from demo.incidents import append_incident_ledger, _load_store, _save_store, _lock as inc_lock

    with inc_lock:
        data = _load_store()
        incidents = data.get("incidents") or {}

    policy = ops_teams._load().get("escalation_policy") or ops_teams.DEFAULT_ESCALATION
    reminder = int(policy.get("reminder_sec", 180))
    lead = int(policy.get("lead_sec", 300))
    secondary = int(policy.get("secondary_sec", 480))
    admin = int(policy.get("admin_sec", 720))

    for token, rec in list(incidents.items()):
        ledger_steps = {e.get("step") for e in (rec.get("ledger") or [])}
        if (
            rec.get("closed")
            or rec.get("resolved")
            or rec.get("acknowledged")
            or "RESOLVED_CLAIMED" in ledger_steps
            or "INCIDENT_CLOSED" in ledger_steps
        ):
            continue
        dispatch = rec.get("dispatch") or {}
        if not dispatch.get("last_notify_at"):
            continue
        elapsed = _seconds_since(dispatch.get("last_notify_at"))
        level = int(dispatch.get("escalation_level") or 0)
        inc = rec.get("incident") or {}
        hall_id = dispatch.get("hall_id") or ops_teams.ensure_hall_from_db()

        def _bump(new_level: int, step: str, detail: str, targets: List[Dict]) -> None:
            nonlocal level
            if new_level <= level:
                return
            for sub in targets:
                chat = sub.get("telegram_chat_id")
                if chat:
                    telegram_bot.send_escalation_dm(str(chat), token, inc, detail)
            append_incident_ledger(token, step, detail, "pdumind", {"level": new_level})
            with inc_lock:
                data2 = _load_store()
                r = (data2.get("incidents") or {}).get(token)
                if r:
                    d = r.setdefault("dispatch", {})
                    d["escalation_level"] = new_level
                    d["last_notify_at"] = _utc_now()
                    (data2.get("incidents") or {})[token] = r
                    _save_store(data2)
            level = new_level

        if level == 0 and elapsed >= reminder and "REMINDER_SENT" not in ledger_steps:
            primary_id = dispatch.get("primary_subscriber_id")
            subs = ops_teams._load().get("subscribers") or []
            primary = next((s for s in subs if s.get("id") == primary_id), None)
            if primary and primary.get("telegram_chat_id"):
                telegram_bot.send_escalation_dm(str(primary["telegram_chat_id"]), token, inc, "Reminder")
            append_incident_ledger(token, "REMINDER_SENT", "Reminder sent to primary", "pdumind")
            with inc_lock:
                data2 = _load_store()
                r = (data2.get("incidents") or {}).get(token)
                if r:
                    r.setdefault("dispatch", {})["escalation_level"] = 0
                    r["dispatch"]["last_notify_at"] = _utc_now()
                    (data2.get("incidents") or {})[token] = r
                    _save_store(data2)

        if elapsed >= lead:
            _bump(1, "ESCALATED_LEAD", "Escalated to hall leads — no ack in time", ops_teams.subscribers_for_escalation(hall_id, 1, inc.get("key", "")))
        if elapsed >= secondary:
            _bump(2, "ESCALATED_SECONDARY", "Escalated to secondary discipline pool", ops_teams.subscribers_for_escalation(hall_id, 2, inc.get("key", "")))
        if elapsed >= admin:
            _bump(3, "ESCALATED_ADMIN", "Escalated to all subscribed ops", ops_teams.subscribers_for_escalation(hall_id, 3, inc.get("key", "")))


def sync_live_outlet_alarms() -> Dict[str, Any]:
    """Dispatch any cable-unplug flags already in the live poller cache (recovery path)."""
    _prepare_alarm_dispatch_context()
    import app as _app
    from db import PDURepo, RackRepo

    synced = 0
    with _app.MULTI_PDU_LOCK:
        snapshot = {ip: dict(res) for ip, res in _app.MULTI_PDU_RESULTS.items()}

    for ip, results in snapshot.items():
        flags_entry = results.get("_alarm_flags")
        if not flags_entry:
            continue
        try:
            flags = json.loads(flags_entry.get("value") or "[]")
        except (TypeError, ValueError):
            continue
        outlet_nums = set()
        for fl in flags:
            m = re.match(r"^outlet(\d+)_load$", (fl.get("param") or "").strip())
            if m:
                outlet_nums.add(int(m.group(1)))
        if outlet_nums:
            before = synced
            dispatch_outlet_load_alarms(ip, outlet_nums, results)
            synced += len(outlet_nums)
    check_and_notify_alarms()
    return {"success": True, "outlet_alarms_processed": synced}


def check_and_notify_alarms() -> None:
    _prepare_alarm_dispatch_context()
    with _lock:
        data = _load_raw()
        if not data.get("notify_on_alarm", True):
            return
        tg = data.get("telegram") or {}
        if not tg.get("enabled") or not tg.get("bot_token"):
            return
        base_url = data.get("frontend_base_url") or get_frontend_base_url()
        active: Dict[str, Any] = dict(data.get("active_incidents") or {})

    process_escalations()

    incidents = _collect_incidents()
    current_fps = {i["fingerprint"] for i in incidents}

    for fp in list(active.keys()):
        if fp not in current_fps:
            clear_alarm_suppression(fp)
            from demo.incidents import handle_alarm_telemetry_cleared
            remove_active = handle_alarm_telemetry_cleared(fp)
            if remove_active:
                with _lock:
                    data = _load_raw()
                    active = dict(data.get("active_incidents") or {})
                    if fp in active:
                        cleared = active.pop(fp)
                        _append_workflow(
                            data,
                            "ALARM_CLEARED",
                            f"{cleared.get('label', 'PDU')} — {cleared.get('key')} cleared",
                            cleared,
                        )
                        data["active_incidents"] = active
                        _save_raw(data)

    for incident in incidents:
        fp = incident["fingerprint"]
        if is_alarm_redispatch_suppressed(fp):
            continue
        with _lock:
            data = _load_raw()
            active = dict(data.get("active_incidents") or {})
            if fp in active:
                continue

        from demo.incidents import get_or_create_token
        token = get_or_create_token(incident)
        print(
            f"[Integrations] Auto-dispatch {incident.get('key')} @ {incident.get('ip')} "
            f"({incident.get('value', '')[:80]})"
        )
        result = _dispatch_new_alarm(incident, token, base_url)
        if not result.get("success") and not result.get("skipped"):
            print(f"[Integrations] Auto-dispatch failed: {result.get('error', result)}")
        with _lock:
            data = _load_raw()
            active = dict(data.get("active_incidents") or {})
            if result.get("success"):
                active[fp] = {**incident, "notified_at": _utc_now(), "token": token}
                _append_workflow(
                    data,
                    "ALARM_NOTIFIED",
                    f"Dispatched — {incident.get('label')} {incident.get('key')}: {incident.get('value')}",
                    {"fingerprint": fp, "channel": "telegram", "incident_token": token[:12] + "…"},
                )
            else:
                _append_workflow(
                    data,
                    "ALARM_NOTIFY_FAILED",
                    result.get("error", "Notification failed"),
                    {"fingerprint": fp},
                )
            data["active_incidents"] = active
            _save_raw(data)


_notifier_started = False


def start_alarm_notifier() -> None:
    global _notifier_started
    if _notifier_started:
        return
    _notifier_started = True

    def _loop():
        from demo.config import ops_enabled, set_ops_namespace
        while True:
            try:
                if ops_enabled():
                    set_ops_namespace("ops")
                check_and_notify_alarms()
            except Exception as exc:
                print(f"[DemoIntegrations] alarm notifier error: {exc}")
            time.sleep(12)

    threading.Thread(target=_loop, daemon=True, name="demo-alarm-notifier").start()
    print("[DemoIntegrations] Alarm notifier started (12s interval)")

    try:
        from demo.telegram_bot import start_telegram_poller
        start_telegram_poller()
    except Exception as exc:
        print(f"[DemoIntegrations] Telegram poller failed to start: {exc}")


_ops_notifier_started = False


def start_ops_alarm_notifier() -> None:
    """Production Neural Ops notifier — real alarms -> incidents -> dispatch.

    Runs in the 'ops' namespace (ops_*.json stores + main DB + real poller alarms),
    gated by PDUMIND_OPS_ENABLED. Telegram dispatch only fires when an operator has
    configured a real bot token + subscribers in the production integrations store.
    """
    global _ops_notifier_started
    from demo.config import ops_enabled, set_ops_namespace
    if _ops_notifier_started or not ops_enabled():
        return
    _ops_notifier_started = True

    def _loop():
        set_ops_namespace("ops")
        while True:
            try:
                set_ops_namespace("ops")
                check_and_notify_alarms()
            except Exception as exc:
                print(f"[Ops] alarm notifier error: {exc}")
            time.sleep(12)

    threading.Thread(target=_loop, daemon=True, name="ops-alarm-notifier").start()
    print("[Ops] Production alarm notifier started (12s interval)")

    try:
        from demo.telegram_bot import start_ops_telegram_poller
        start_ops_telegram_poller()
    except Exception as exc:
        print(f"[Ops] Telegram poller failed to start: {exc}")
