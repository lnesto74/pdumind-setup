"""Telegram bot — subscribe onboarding + incident ack buttons (demo)."""
from __future__ import annotations

import threading
import time
from typing import Any, Dict, List, Optional

import requests

from demo import ops_teams
from demo.integrations import _load_raw, _valid_telegram_token

_poller_started = False
_poll_offset = 0


def _bot_token() -> str:
    tg = (_load_raw().get("telegram") or {})
    return (tg.get("bot_token") or "").strip()


def _api(method: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token = _bot_token()
    if not _valid_telegram_token(token):
        return {"ok": False, "description": "Bot not configured"}
    url = f"https://api.telegram.org/bot{token}/{method}"
    try:
        resp = requests.post(url, json=payload, timeout=15)
        return resp.json()
    except requests.RequestException as exc:
        return {"ok": False, "description": str(exc)}


def send_dm(chat_id: str, text: str, reply_markup: Optional[Dict] = None, parse_mode: str = "HTML") -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": False,
    }
    if reply_markup:
        body["reply_markup"] = reply_markup
    return _api("sendMessage", body)


def _kb(rows: List[List[Dict[str, str]]]) -> Dict[str, Any]:
    return {"inline_keyboard": rows}


def _btn(text: str, data: str) -> Dict[str, str]:
    return {"text": text, "callback_data": data[:64]}


def handle_webhook_update(update: Dict[str, Any]) -> None:
    if update.get("callback_query"):
        _handle_callback(update["callback_query"])
        return
    msg = update.get("message") or {}
    chat = msg.get("chat") or {}
    chat_id = str(chat.get("id", ""))
    text = (msg.get("text") or "").strip()
    user = msg.get("from") or {}
    if not chat_id:
        return
    if text.startswith("/start"):
        parts = text.split(maxsplit=1)
        payload = parts[1] if len(parts) > 1 else ""
        _start_onboarding(chat_id, user, payload)
    elif text == "/status":
        _cmd_status(chat_id)
    elif text == "/pause":
        _cmd_pause(chat_id)
    elif text == "/help":
        send_dm(chat_id, "<b>PDUMind Ops Bot</b>\n/status — your subscription\n/pause — pause primary assignments\nUse hall invite link to subscribe.")
    else:
        state = ops_teams.get_onboarding(chat_id)
        if state.get("step") == "custom_name":
            _finish_custom_name(chat_id, user, text)


def _start_onboarding(chat_id: str, user: Dict, payload: str) -> None:
    from demo.config import DEMO_HALL_NAME

    hall_id = ops_teams.ensure_hall_from_db()
    hall_name = DEMO_HALL_NAME
    invite_hall = None
    if payload:
        token = payload.replace("subscribe_", "").replace("sub_", "")
        invite_hall = ops_teams.get_invite_by_token(token)
        if not invite_hall and payload.startswith("sub_"):
            invite_hall = ops_teams.get_invite_by_token(payload[4:])
    if invite_hall:
        hall_id = invite_hall["id"]
        hall_name = invite_hall.get("name") or hall_name

    ops_teams.set_onboarding(chat_id, {"step": "discipline", "hall_id": hall_id, "hall_name": hall_name, "user": user})
    send_dm(
        chat_id,
        f"<b>Welcome to {hall_name}</b>\n\nOperational alerts for your data hall.\nChoose your primary discipline:",
        _kb([
            [_btn("Electrician", "ob:disc:electrician")],
            [_btn("Network", "ob:disc:network")],
            [_btn("Hardware", "ob:disc:hardware")],
            [_btn("Facilities", "ob:disc:facilities")],
            [_btn("Hall Lead", "ob:disc:hall_lead")],
        ]),
    )


def _handle_callback(cq: Dict[str, Any]) -> None:
    data = cq.get("data") or ""
    chat_id = str((cq.get("message") or {}).get("chat", {}).get("id", ""))
    user = cq.get("from") or {}
    cq_id = cq.get("id")
    if cq_id:
        _api("answerCallbackQuery", {"callback_query_id": cq_id})

    if data.startswith("ob:disc:"):
        disc = data.split(":")[-1]
        state = ops_teams.get_onboarding(chat_id)
        state["discipline"] = disc
        state["step"] = "cross_hall"
        ops_teams.set_onboarding(chat_id, state)
        send_dm(
            chat_id,
            "Also cover another hall?",
            _kb([
                [_btn("This hall only", "ob:hall:only")],
                [_btn("Also Cloud Cage B", "ob:hall:cloud-b")],
            ]),
        )
    elif data.startswith("ob:hall:"):
        state = ops_teams.get_onboarding(chat_id)
        extra = [] if data.endswith(":only") else ["cloud-b"]
        state["extra_halls"] = extra
        state["step"] = "name"
        ops_teams.set_onboarding(chat_id, state)
        uname = user.get("first_name") or "Tech"
        send_dm(
            chat_id,
            "Display name on incident reports?",
            _kb([
                [_btn(f"Use {uname}", "ob:name:tg")],
                [_btn("Type custom name", "ob:name:custom")],
            ]),
        )
    elif data == "ob:name:tg":
        _finish_subscribe(chat_id, user, None)
    elif data == "ob:name:custom":
        state = ops_teams.get_onboarding(chat_id)
        state["step"] = "custom_name"
        ops_teams.set_onboarding(chat_id, state)
        send_dm(chat_id, "Reply with your display name (e.g. Somchai K.)")
    elif data.startswith("ack:"):
        token = data.split(":", 1)[1]
        _telegram_ack(chat_id, user, token)
    elif data.startswith("resolve:"):
        token = data.split(":", 1)[1]
        _telegram_resolve(chat_id, user, token)
    elif data.startswith("map:"):
        token = data.split(":", 1)[1]
        from demo.incidents import incident_public_url
        from demo.integrations import get_frontend_base_url
        base = get_frontend_base_url()
        link = incident_public_url(base, token)
        send_dm(chat_id, f'<a href="{link}">Open mobile incident map</a>')


def _finish_custom_name(chat_id: str, user: Dict, name: str) -> None:
    _finish_subscribe(chat_id, user, name)


def _finish_subscribe(chat_id: str, user: Dict, custom_name: Optional[str]) -> None:
    state = ops_teams.get_onboarding(chat_id)
    if not state:
        send_dm(chat_id, "Send /start with your hall invite link to subscribe.")
        return
    display = custom_name or user.get("first_name") or "Technician"
    sub = ops_teams.upsert_subscriber_from_telegram(
        chat_id=str(chat_id),
        user_id=str(user.get("id", chat_id)),
        display_name=display,
        hall_id=state.get("hall_id") or ops_teams.ensure_hall_from_db(),
        discipline=state.get("discipline") or "electrician",
        extra_halls=state.get("extra_halls") or [],
    )
    ops_teams.clear_onboarding(chat_id)
    disc_label = ops_teams.DISCIPLINE_LABELS.get(sub.get("discipline", ""), sub.get("discipline"))
    send_dm(
        chat_id,
        f"✅ <b>Subscribed</b>\n\n{disc_label} · {', '.join(sub.get('hall_ids') or [])}\n\nYou may receive <b>PRIMARY</b> incident assignments via round-robin.\n/status · /pause · /help",
    )


def _cmd_status(chat_id: str) -> None:
    sub = ops_teams.find_subscriber_by_chat(chat_id)
    if not sub:
        send_dm(chat_id, "Not subscribed. Open your hall invite link to join.")
        return
    disc = ops_teams.DISCIPLINE_LABELS.get(sub.get("discipline", ""), sub.get("discipline"))
    halls = ", ".join(sub.get("hall_ids") or [])
    send_dm(chat_id, f"<b>Status</b>\n{sub.get('display_name')} · {disc}\nHalls: {halls}\nStatus: {sub.get('status')}")


def _cmd_pause(chat_id: str) -> None:
    sub = ops_teams.find_subscriber_by_chat(chat_id)
    if not sub:
        send_dm(chat_id, "Not subscribed.")
        return
    # Mark paused in store
    from demo.ops_teams import _load, _save, _lock
    with _lock:
        data = _load()
        for s in data.get("subscribers") or []:
            if str(s.get("telegram_chat_id")) == str(chat_id):
                s["status"] = "paused"
        _save(data)
    send_dm(chat_id, "Primary assignments paused. Send /start to reactivate.")


def _telegram_ack(chat_id: str, user: Dict, token: str) -> None:
    from demo.incidents import acknowledge_incident
    sub = ops_teams.find_subscriber_by_chat(chat_id)
    actor = sub.get("display_name") if sub else user.get("first_name", "technician")
    result = acknowledge_incident(token, actor=actor, subscriber_id=sub.get("id") if sub else None)
    if result.get("success"):
        send_dm(chat_id, "✅ Acknowledged — you're the incident owner. Open the map to resolve on-site.", _kb([
            [_btn("Open map", f"map:{token}")],
            [_btn("Mark resolved", f"resolve:{token}")],
        ]))
    else:
        send_dm(chat_id, result.get("error", "Could not acknowledge"))


def _telegram_resolve(chat_id: str, user: Dict, token: str) -> None:
    from demo.incidents import resolve_incident
    sub = ops_teams.find_subscriber_by_chat(chat_id)
    actor = sub.get("display_name") if sub else user.get("first_name", "technician")
    result = resolve_incident(token, actor=actor)
    if result.get("success"):
        if result.get("closed"):
            send_dm(chat_id, "✅ Resolved, verified & closed — stone report saved.")
        else:
            send_dm(chat_id, "✅ Marked resolved — awaiting system verification.")
    else:
        send_dm(chat_id, result.get("error", "Could not resolve"))


def send_primary_incident_dm(
    chat_id: str,
    incident_token: str,
    incident: Dict[str, Any],
    base_url: str,
) -> Dict[str, Any]:
    from demo.incidents import incident_public_url
    from demo.integrations import _alarm_label

    label = incident.get("label") or incident.get("ip")
    rack = incident.get("rack_label") or incident.get("rack") or "—"
    link = incident_public_url(base_url, incident_token)
    outlet_code = incident.get("outlet_code")
    if outlet_code or (incident.get("key") or "").endswith("_load"):
        mount = incident.get("mount_position") or "A"
        value = incident.get("value") or "Cable disconnected from outlet"
        text = (
            f"<b>PRIMARY — Cable unplugged</b>\n\n"
            f"<b>Rack:</b> {rack}\n"
            f"<b>PDU:</b> {label} (slot {mount})\n"
            f"<b>Outlet:</b> {outlet_code or '—'}\n"
            f"{value}\n\n"
            f'<a href="{link}">Open map</a>'
        )
    else:
        alarm = _alarm_label(incident.get("key", ""), incident)
        value = incident.get("value", "")
        text = (
            f"<b>PRIMARY — incident assignment</b>\n\n"
            f"<b>{label}</b> @ {rack}\n"
            f"{alarm}: {value}\n\n"
            f'<a href="{link}">Open map</a>'
        )
    return send_dm(chat_id, text, _kb([
        [_btn("Ack & en route", f"ack:{incident_token}")],
        [_btn("Open map", f"map:{incident_token}")],
    ]))


def send_escalation_dm(chat_id: str, incident_token: str, incident: Dict[str, Any], level_label: str) -> Dict[str, Any]:
    label = incident.get("label") or incident.get("ip")
    text = f"<b>ESCALATED — {level_label}</b>\n\n{label} — no ack in time."
    return send_dm(chat_id, text, _kb([
        [_btn("Ack & en route", f"ack:{incident_token}")],
        [_btn("Open map", f"map:{incident_token}")],
    ]))


def start_telegram_poller() -> None:
    """Long-poll Telegram for /start + inline buttons — works without HTTPS webhook."""
    global _poller_started
    if _poller_started:
        return
    if not _valid_telegram_token(_bot_token()):
        return
    _poller_started = True

    def _loop() -> None:
        global _poll_offset
        _api("deleteWebhook", {"drop_pending_updates": False})
        print("[TelegramBot] Long-poll listener started (Tailscale/demo — no HTTPS webhook needed)")
        while True:
            try:
                if not _valid_telegram_token(_bot_token()):
                    time.sleep(5)
                    continue
                result = _api("getUpdates", {
                    "offset": _poll_offset,
                    "timeout": 25,
                    "allowed_updates": ["message", "callback_query"],
                })
                if not result.get("ok"):
                    time.sleep(3)
                    continue
                for upd in result.get("result") or []:
                    uid = upd.get("update_id")
                    if uid is not None:
                        _poll_offset = max(_poll_offset, int(uid) + 1)
                    try:
                        handle_webhook_update(upd)
                    except Exception as exc:
                        print(f"[TelegramBot] update handler error: {exc}")
            except Exception as exc:
                print(f"[TelegramBot] poll error: {exc}")
                time.sleep(3)

    threading.Thread(target=_loop, daemon=True, name="telegram-poller").start()


_ops_poller_started = False
_ops_poll_offset = 0


def start_ops_telegram_poller() -> None:
    """Production Telegram long-poll listener — runs bound to the 'ops' namespace
    so subscribe/onboarding/ack all read+write the production ops stores. Uses the
    bot token configured in the production integrations store (separate from demo)."""
    global _ops_poller_started
    from demo.config import set_ops_namespace

    set_ops_namespace("ops")
    if _ops_poller_started:
        return
    if not _valid_telegram_token(_bot_token()):
        return
    _ops_poller_started = True

    def _loop() -> None:
        global _ops_poll_offset
        set_ops_namespace("ops")
        _api("deleteWebhook", {"drop_pending_updates": False})
        print("[Ops][TelegramBot] Production long-poll listener started")
        while True:
            try:
                set_ops_namespace("ops")
                if not _valid_telegram_token(_bot_token()):
                    time.sleep(5)
                    continue
                result = _api("getUpdates", {
                    "offset": _ops_poll_offset,
                    "timeout": 25,
                    "allowed_updates": ["message", "callback_query"],
                })
                if not result.get("ok"):
                    time.sleep(3)
                    continue
                for upd in result.get("result") or []:
                    uid = upd.get("update_id")
                    if uid is not None:
                        _ops_poll_offset = max(_ops_poll_offset, int(uid) + 1)
                    try:
                        handle_webhook_update(upd)
                    except Exception as exc:
                        print(f"[Ops][TelegramBot] update handler error: {exc}")
            except Exception as exc:
                print(f"[Ops][TelegramBot] poll error: {exc}")
                time.sleep(3)

    threading.Thread(target=_loop, daemon=True, name="ops-telegram-poller").start()
