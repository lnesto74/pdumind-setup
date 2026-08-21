"""Production Neural Ops API — the demo ops/incident UX, on REAL data.

These endpoints reuse the exact same shared-core lifecycle code as the demo
(incidents / ops_teams / integrations / dispatch_live / telegram_bot) but run in
the "ops" namespace: ops_*.json stores + the main DB + real poller alarms.

Everything here is gated by PDUMIND_OPS_ENABLED (config.ops_enabled). When the flag
is OFF, every endpoint returns 404 and production behaves exactly as before.
"""
from __future__ import annotations

from flask import jsonify, request

from auth import require_auth
from demo.config import ops_enabled, set_ops_namespace
from demo.context import deactivate_demo_db


def _enter_ops():
    """Bind this request to the production ops namespace + main DB.

    Returns a Flask response tuple if the ops layer is disabled, else None.
    """
    if not ops_enabled():
        return jsonify({"error": "Neural Ops disabled", "code": "OPS_DISABLED"}), 404
    deactivate_demo_db()       # ops uses the main production DB, never the demo DB
    set_ops_namespace("ops")   # ops_*.json stores + real alarm source
    return None


def register_ops_routes(app):
    """Register production Neural Ops endpoints (additive; flag-gated)."""

    # ---- status / capability probe -------------------------------------
    @app.route("/api/ops/status", methods=["GET"])
    @require_auth
    def ops_status():
        if not ops_enabled():
            return jsonify({"ops_enabled": False})
        set_ops_namespace("ops")
        deactivate_demo_db()
        return jsonify({
            "ops_enabled": True,
            "source": "production",
            "alarm_source": "live-poller",
        })

    # ---- incidents (admin dashboard) -----------------------------------
    @app.route("/api/ops/incidents", methods=["GET"])
    @require_auth
    def ops_incidents_list():
        guard = _enter_ops()
        if guard:
            return guard
        from demo.incidents import list_incidents_for_dashboard
        return jsonify(list_incidents_for_dashboard())

    # ---- live dispatch board -------------------------------------------
    @app.route("/api/ops/dispatch/live", methods=["GET"])
    @require_auth
    def ops_dispatch_live():
        guard = _enter_ops()
        if guard:
            return guard
        from demo.dispatch_live import get_live_dispatch
        return jsonify(get_live_dispatch())

    # ---- ops teams (roster / pools / escalation) -----------------------
    @app.route("/api/ops/teams", methods=["GET"])
    @require_auth
    def ops_teams_get():
        guard = _enter_ops()
        if guard:
            return guard
        from demo.ops_teams import get_teams_dashboard
        return jsonify(get_teams_dashboard())

    @app.route("/api/ops/teams/pools", methods=["PUT"])
    @require_auth
    def ops_teams_pools_put():
        guard = _enter_ops()
        if guard:
            return guard
        from demo.ops_teams import update_pool_order
        body = request.get_json(force=True) if request.data else {}
        return jsonify(update_pool_order(body.get("hall_id"), body.get("discipline"), body.get("member_ids") or []))

    @app.route("/api/ops/teams/escalation", methods=["PUT"])
    @require_auth
    def ops_teams_escalation_put():
        guard = _enter_ops()
        if guard:
            return guard
        from demo.ops_teams import update_escalation_policy
        body = request.get_json(force=True) if request.data else {}
        return jsonify(update_escalation_policy(body))

    @app.route("/api/ops/teams/analytics", methods=["GET"])
    @require_auth
    def ops_teams_analytics():
        guard = _enter_ops()
        if guard:
            return guard
        from demo.ops_teams import compute_analytics
        return jsonify(compute_analytics())

    # ---- integrations (Telegram / notifications config) ----------------
    @app.route("/api/ops/integrations", methods=["GET"])
    @require_auth
    def ops_integrations_get():
        guard = _enter_ops()
        if guard:
            return guard
        from demo.integrations import get_public_config
        return jsonify(get_public_config())

    @app.route("/api/ops/integrations", methods=["PUT"])
    @require_auth
    def ops_integrations_put():
        guard = _enter_ops()
        if guard:
            return guard
        from demo.integrations import update_config, start_ops_alarm_notifier
        data = request.get_json(force=True) if request.data else {}
        result = update_config(data)
        if result.get("error"):
            return jsonify(result), 400
        # (Re)start the production notifier/poller once a real token is configured.
        try:
            start_ops_alarm_notifier()
        except Exception:
            pass
        return jsonify(result)

    @app.route("/api/ops/integrations/telegram/test", methods=["POST"])
    @require_auth
    def ops_integrations_telegram_test():
        guard = _enter_ops()
        if guard:
            return guard
        from demo.integrations import send_telegram_test
        result = send_telegram_test()
        if not result.get("success"):
            return jsonify(result), 400
        return jsonify(result)

    @app.route("/api/ops/integrations/sync-alarms", methods=["POST"])
    @require_auth
    def ops_integrations_sync_alarms():
        """Push Telegram for any live cable-unplug (or other) alarms not yet dispatched."""
        guard = _enter_ops()
        if guard:
            return guard
        from demo.integrations import sync_live_outlet_alarms
        return jsonify(sync_live_outlet_alarms())

    # ---- public: hall subscribe invite info (token-gated) --------------
    @app.route("/api/ops/teams/invite/<token>", methods=["GET"])
    def ops_teams_invite_info(token):
        if not ops_enabled():
            return jsonify({"error": "Not available"}), 404
        set_ops_namespace("ops")
        deactivate_demo_db()
        from demo.ops_teams import get_invite_by_token
        from demo.integrations import (
            _load_raw, subscribe_landing_url, get_frontend_base_url, get_telegram_bot_username,
        )
        hall = get_invite_by_token(token)
        if not hall:
            return jsonify({"error": "Invalid invite"}), 404
        cfg = _load_raw()
        bot_username = get_telegram_bot_username(cfg)
        return jsonify({
            "hall": hall,
            "frontend_base_url": get_frontend_base_url(),
            "subscribe_url": subscribe_landing_url(token),
            "telegram_deep_link": f"https://t.me/{bot_username}?start=sub_{token}" if bot_username else None,
            "subscribe_payload": f"sub_{token}",
        })

    # ---- public: Telegram webhook --------------------------------------
    @app.route("/api/ops/telegram/webhook", methods=["POST"])
    def ops_telegram_webhook():
        if not ops_enabled():
            return jsonify({"ok": False}), 404
        set_ops_namespace("ops")
        deactivate_demo_db()
        from demo.telegram_bot import handle_webhook_update
        update = request.get_json(force=True, silent=True) or {}
        try:
            handle_webhook_update(update)
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 500
        return jsonify({"ok": True})

    # ---- public: mobile incident view (token-gated) --------------------
    @app.route("/api/ops/incident/<token>", methods=["GET"])
    def ops_incident_get(token):
        if not ops_enabled():
            return jsonify({"error": "Not available", "code": "OPS_DISABLED"}), 404
        set_ops_namespace("ops")
        deactivate_demo_db()
        from demo.incidents import build_snapshot
        record_view = request.args.get("view", "1") != "0"
        snapshot = build_snapshot(token, record_view=record_view)
        if snapshot.get("error"):
            code = snapshot.get("code", "NOT_FOUND")
            status = 404 if code in ("NOT_FOUND", "CLEARED", "DEMO_DISABLED") else 400
            return jsonify(snapshot), status
        return jsonify(snapshot)

    @app.route("/api/ops/incident/<token>/report", methods=["GET"])
    def ops_incident_report(token):
        if not ops_enabled():
            return "Not available", 404
        set_ops_namespace("ops")
        deactivate_demo_db()
        from demo.incidents import incident_report_html
        html = incident_report_html(token)
        if not html:
            return "Incident not found", 404
        return html, 200, {"Content-Type": "text/html; charset=utf-8"}

    @app.route("/api/ops/incident/<token>/ack", methods=["POST"])
    def ops_incident_ack(token):
        if not ops_enabled():
            return jsonify({"error": "Not available"}), 404
        set_ops_namespace("ops")
        deactivate_demo_db()
        from demo.incidents import acknowledge_incident
        body = request.get_json(force=True, silent=True) or {}
        result = acknowledge_incident(token, actor=body.get("actor", "technician"), subscriber_id=body.get("subscriber_id"))
        if not result.get("success"):
            return jsonify(result), 404
        return jsonify(result)

    @app.route("/api/ops/incident/<token>/resolve", methods=["POST"])
    def ops_incident_resolve(token):
        if not ops_enabled():
            return jsonify({"error": "Not available"}), 404
        set_ops_namespace("ops")
        deactivate_demo_db()
        from demo.incidents import resolve_incident
        result = resolve_incident(token)
        if not result.get("success"):
            return jsonify(result), 400
        return jsonify(result)


def init_ops_on_startup(app):
    """Start the production alarm notifier + Telegram poller when ops is enabled."""
    if not ops_enabled():
        return
    from demo.integrations import start_ops_alarm_notifier
    start_ops_alarm_notifier()
    print("[Ops] Production Neural Ops layer ENABLED (PDUMIND_OPS_ENABLED=1)")
