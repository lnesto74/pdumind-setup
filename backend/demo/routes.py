"""Demo API intercepts and reset route."""
from __future__ import annotations

import re

from flask import jsonify, request, g

from auth import require_auth
from demo.config import DEMO_SCAN_RANGE, DEMO_SUBNET, is_demo_device_ip
from demo.context import bind_request_context, is_demo_session, activate_demo_db, deactivate_demo_db
from demo.seed import reset_demo_for_commissioning, seed_demo_hall, setup_demo_environment
from demo.integrations import (
    get_public_config,
    send_telegram_test,
    start_alarm_notifier,
    update_config,
)
from demo.incidents import acknowledge_incident, build_snapshot, list_incidents_for_dashboard, resolve_incident
from demo.ops_teams import (
    compute_analytics,
    get_invite_by_token,
    get_teams_dashboard,
    update_escalation_policy,
    update_pool_order,
)
from demo.dispatch_live import get_live_dispatch
from demo.telegram_bot import handle_webhook_update
from demo import replay
from demo.simulator import (
    assign_demo_pdus_to_racks,
    get_batch_status,
    get_demo_fleet_telemetry,
    get_live,
    get_poll_status,
    demo_connect,
    probe_login,
    repair_pdus,
    reset_simulator_state,
    scan_factory,
    scan_http,
    scan_snmp,
    seed_demo_fleet,
    start_batch_commission,
    start_demo_poller,
)


def register_demo_routes(app):
    """Register demo middleware and demo-only endpoints."""

    @app.before_request
    def _demo_bind_db():
        bind_request_context()

    @app.before_request
    def _demo_api_intercept():
        if not getattr(g, "demo_mode", False):
            return None
        start_demo_poller()
        start_alarm_notifier()
        return _try_intercept()

    @app.route("/api/demo/reset", methods=["POST"])
    @require_auth
    def demo_reset():
        if not is_demo_session():
            return jsonify({"error": "Demo reset requires demo user login"}), 403
        body = request.get_json(force=True, silent=True) or {}
        mode = (body.get("mode") or "factory").strip().lower()
        if mode in ("cage", "preload", "dashboard"):
            reset_simulator_state()
            hall_id = seed_demo_hall(force=True)
            return jsonify({
                "success": True,
                "hall_id": hall_id,
                "mode": "cage",
                "message": "Demo cage pre-loaded — 8 PDUs with telemetry (6 online, 2 offline)",
            })
        hall_id = reset_demo_for_commissioning()
        return jsonify({
            "success": True,
            "hall_id": hall_id,
            "mode": "factory",
            "message": "Factory reset — 8 uncommissioned PDUs on 10.99.1.206-213 ready for batch scan",
        })

    @app.route("/api/demo/assign-racks", methods=["POST"])
    @require_auth
    def demo_assign_racks():
        if not is_demo_session():
            return jsonify({"error": "Demo rack assign requires demo user login"}), 403
        activate_demo_db()
        from db import HallRepo
        from demo.config import DEMO_HALL_NAME
        hall_id = None
        for h in HallRepo.get_all():
            if h.get("name") == DEMO_HALL_NAME:
                hall_id = h["id"]
                break
        if not hall_id:
            return jsonify({"error": "Demo hall not found"}), 404
        n = assign_demo_pdus_to_racks(hall_id, shuffle=True)
        return jsonify({"success": True, "assigned": n, "message": f"Assigned {n} PDUs to racks"})

    @app.route("/api/demo/telemetry", methods=["GET"])
    @require_auth
    def demo_telemetry():
        if not is_demo_session():
            return jsonify({"error": "Demo telemetry requires demo user login"}), 403
        if replay.is_active():
            return jsonify(replay.get_fleet_telemetry())
        return jsonify(get_demo_fleet_telemetry())

    @app.route("/api/demo/snapshots", methods=["GET"])
    @require_auth
    def demo_snapshots_list():
        if not is_demo_session():
            return jsonify({"error": "Demo snapshots require demo user login"}), 403
        return jsonify({"snapshots": replay.list_snapshots(), "replay": replay.status()})

    @app.route("/api/demo/replay/load", methods=["POST"])
    @require_auth
    def demo_replay_load():
        if not is_demo_session():
            return jsonify({"error": "Demo replay requires demo user login"}), 403
        body = request.get_json(force=True, silent=True) or {}
        filename = body.get("filename")
        if not filename:
            return jsonify({"error": "filename required"}), 400
        try:
            bundle = replay.read_snapshot(filename)
        except FileNotFoundError:
            return jsonify({"error": "Snapshot not found"}), 404
        result = replay.load_bundle(bundle)
        return jsonify(result)

    @app.route("/api/demo/replay/stop", methods=["POST"])
    @require_auth
    def demo_replay_stop():
        if not is_demo_session():
            return jsonify({"error": "Demo replay requires demo user login"}), 403
        replay.stop()
        return jsonify({"success": True})

    @app.route("/api/demo/replay/status", methods=["GET"])
    @require_auth
    def demo_replay_status():
        if not is_demo_session():
            return jsonify({"error": "Demo replay requires demo user login"}), 403
        return jsonify(replay.status())

    @app.route("/api/demo/status", methods=["GET"])
    @require_auth
    def demo_status():
        if not is_demo_session():
            return jsonify({"demo_mode": False})
        return jsonify({
            "demo_mode": True,
            "scan_subnet": DEMO_SCAN_RANGE,
            "scan_subnet_cidr": DEMO_SUBNET,
            "factory_ip": "192.168.0.163",
            "pdu_ips": [f"10.99.1.{206 + i}" for i in range(8)],
            "pdu_count": 8,
            "pre_seeded": True,
            "online_count": 6,
            "offline_count": 2,
            "hint": "Demo cage is pre-loaded with 8 PDUs, env sensors, and alarms. Reset to refresh.",
        })

    @app.route("/api/demo/integrations", methods=["GET"])
    @require_auth
    def demo_integrations_get():
        if not is_demo_session():
            return jsonify({"error": "Demo integrations require demo user login"}), 403
        return jsonify(get_public_config())

    @app.route("/api/demo/integrations", methods=["PUT"])
    @require_auth
    def demo_integrations_put():
        if not is_demo_session():
            return jsonify({"error": "Demo integrations require demo user login"}), 403
        data = request.get_json(force=True) if request.data else {}
        result = update_config(data)
        if result.get("error"):
            return jsonify(result), 400
        return jsonify(result)

    @app.route("/api/demo/integrations/telegram/test", methods=["POST"])
    @require_auth
    def demo_integrations_telegram_test():
        if not is_demo_session():
            return jsonify({"error": "Demo integrations require demo user login"}), 403
        result = send_telegram_test()
        if not result.get("success"):
            return jsonify(result), 400
        return jsonify(result)

    @app.route("/api/demo/teams", methods=["GET"])
    @require_auth
    def demo_teams_get():
        if not is_demo_session():
            return jsonify({"error": "Demo teams require demo user login"}), 403
        return jsonify(get_teams_dashboard())

    @app.route("/api/demo/teams/pools", methods=["PUT"])
    @require_auth
    def demo_teams_pools_put():
        if not is_demo_session():
            return jsonify({"error": "Demo teams require demo user login"}), 403
        body = request.get_json(force=True) if request.data else {}
        return jsonify(update_pool_order(body.get("hall_id"), body.get("discipline"), body.get("member_ids") or []))

    @app.route("/api/demo/teams/escalation", methods=["PUT"])
    @require_auth
    def demo_teams_escalation_put():
        if not is_demo_session():
            return jsonify({"error": "Demo teams require demo user login"}), 403
        body = request.get_json(force=True) if request.data else {}
        return jsonify(update_escalation_policy(body))

    @app.route("/api/demo/dispatch/live", methods=["GET"])
    @require_auth
    def demo_dispatch_live():
        if not is_demo_session():
            return jsonify({"error": "Demo dispatch requires demo user login"}), 403
        return jsonify(get_live_dispatch())

    @app.route("/api/demo/teams/analytics", methods=["GET"])
    @require_auth
    def demo_teams_analytics():
        if not is_demo_session():
            return jsonify({"error": "Demo analytics require demo user login"}), 403
        return jsonify(compute_analytics())

    @app.route("/api/demo/teams/invite/<token>", methods=["GET"])
    def demo_teams_invite_info(token):
        from demo.config import demo_enabled
        if not demo_enabled():
            return jsonify({"error": "Not available"}), 404
        hall = get_invite_by_token(token)
        if not hall:
            return jsonify({"error": "Invalid invite"}), 404
        from demo.integrations import _load_raw, subscribe_landing_url, get_frontend_base_url, get_telegram_bot_username
        cfg = _load_raw()
        bot_username = get_telegram_bot_username(cfg)
        return jsonify({
            "hall": hall,
            "frontend_base_url": get_frontend_base_url(),
            "subscribe_url": subscribe_landing_url(token),
            "telegram_deep_link": f"https://t.me/{bot_username}?start=sub_{token}" if bot_username else None,
            "subscribe_payload": f"sub_{token}",
        })

    @app.route("/api/demo/telegram/webhook", methods=["POST"])
    def demo_telegram_webhook():
        from demo.config import demo_enabled
        if not demo_enabled():
            return jsonify({"ok": False}), 404
        update = request.get_json(force=True, silent=True) or {}
        try:
            handle_webhook_update(update)
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 500
        return jsonify({"ok": True})

    @app.route("/api/demo/incident/<token>/report", methods=["GET"])
    def demo_incident_report(token):
        from demo.config import demo_enabled
        from demo.incidents import incident_report_html
        if not demo_enabled():
            return "Not available", 404
        html = incident_report_html(token)
        if not html:
            return "Incident not found", 404
        return html, 200, {"Content-Type": "text/html; charset=utf-8"}

    @app.route("/api/demo/incidents", methods=["GET"])
    @require_auth
    def demo_incidents_list():
        if not is_demo_session():
            return jsonify({"error": "Demo incidents require demo user login"}), 403
        return jsonify(list_incidents_for_dashboard())

    @app.route("/api/demo/incident/<token>", methods=["GET"])
    def demo_incident_get(token):
        from demo.config import demo_enabled
        if not demo_enabled():
            return jsonify({"error": "Not available", "code": "DEMO_DISABLED"}), 404
        record_view = request.args.get("view", "1") != "0"
        snapshot = build_snapshot(token, record_view=record_view)
        if snapshot.get("error"):
            code = snapshot.get("code", "NOT_FOUND")
            status = 404 if code in ("NOT_FOUND", "CLEARED", "DEMO_DISABLED") else 400
            return jsonify(snapshot), status
        return jsonify(snapshot)

    @app.route("/api/demo/incident/<token>/ack", methods=["POST"])
    def demo_incident_ack(token):
        from demo.config import demo_enabled
        if not demo_enabled():
            return jsonify({"error": "Not available"}), 404
        body = request.get_json(force=True, silent=True) or {}
        result = acknowledge_incident(token, actor=body.get("actor", "technician"), subscriber_id=body.get("subscriber_id"))
        if not result.get("success"):
            return jsonify(result), 404
        return jsonify(result)

    @app.route("/api/demo/incident/<token>/resolve", methods=["POST"])
    def demo_incident_resolve(token):
        from demo.config import demo_enabled
        if not demo_enabled():
            return jsonify({"error": "Not available"}), 404
        result = resolve_incident(token)
        if not result.get("success"):
            return jsonify(result), 400
        return jsonify(result)


def _try_intercept():
    method = request.method
    path = request.path

    if method == "POST" and path == "/api/network/scan":
        data = request.get_json(force=True) if request.data else {}
        return jsonify(scan_snmp(data.get("subnet", DEMO_SCAN_RANGE), data.get("community", "private")))

    if method == "POST" and path == "/api/network/scan/http":
        data = request.get_json(force=True) if request.data else {}
        return jsonify(scan_http(data.get("subnet", DEMO_SCAN_RANGE)))

    if method == "POST" and path == "/api/network/scan/factory-default":
        data = request.get_json(force=True) if request.data else {}
        return jsonify(scan_factory(data.get("factory_ip", "192.168.0.163")))

    if method == "POST" and path == "/api/pdu-admin/connect":
        data = request.get_json(force=True) if request.data else {}
        host = (data.get("host") or "").strip()
        port = int(data.get("port") or 443)
        user = data.get("username") or "admin"
        pw = data.get("password") or "admin"
        return jsonify(demo_connect(host, port, user, pw))

    if method == "POST" and path == "/api/pdu-admin/probe-login":
        data = request.get_json(force=True) if request.data else {}
        host = (data.get("host") or data.get("ip") or "").strip()
        user = data.get("web_admin_user") or data.get("username") or "admin"
        pw = data.get("web_admin_pass") or data.get("password") or "admin"
        report = probe_login(host, user, pw)
        return jsonify(report), 200 if report.get("success") else 401

    if method == "POST" and path == "/api/batch/commission":
        data = request.get_json(force=True) if request.data else {}
        template = data.get("template", {})
        pdu_list = data.get("pdus", [])
        hall_id = data.get("hall_id")
        if not pdu_list:
            return jsonify({"error": "No PDUs selected"}), 400
        if not hall_id:
            return jsonify({"error": "Data hall ID required"}), 400
        job_id = start_batch_commission(template, pdu_list, hall_id)
        return jsonify({"success": True, "job_id": job_id, "total": len(pdu_list)})

    m = re.match(r"^/api/batch/commission/([^/]+)$", path)
    if method == "GET" and m:
        job = get_batch_status(m.group(1))
        if not job:
            return jsonify({"error": "Job not found"}), 404
        return jsonify(job)

    m = re.match(r"^/api/halls/(\d+)/pdus/repair-web-access$", path)
    if method == "POST" and m:
        hall_id = int(m.group(1))
        data = request.get_json(force=True) if request.data else {}
        user = data.get("web_admin_user") or data.get("username")
        password = data.get("web_admin_pass") or data.get("password")
        pdu_ids = data.get("pdu_ids")
        return jsonify(repair_pdus(hall_id, pdu_ids, user, password))

    m = re.match(r"^/api/pdus/by-ip/([^/]+)/live$", path)
    if method == "GET" and m:
        ip = m.group(1)
        if replay.is_replay_ip(ip):       # recorded-hall PDU — serve looped recording
            return jsonify(replay.get_live(ip))
        if not is_demo_device_ip(ip):
            deactivate_demo_db()  # real PDU — query main DB, not demo DB
            return None           # fall through to the real telemetry handler
        return jsonify(get_live(ip))

    m = re.match(r"^/api/polling/device/([^/]+)$", path)
    if method == "GET" and m:
        ip = m.group(1)
        if replay.is_replay_ip(ip):
            return jsonify(replay.get_poll_status(ip))
        if not is_demo_device_ip(ip):
            deactivate_demo_db()
            return None           # fall through to the real poller status
        return jsonify(get_poll_status(ip))

    return None


def init_demo_on_startup(app):
    """Seed demo DB and user when PDUMIND_DEMO_ENABLED=1."""
    from demo.config import demo_enabled
    if demo_enabled():
        setup_demo_environment(force_seed=False)
        start_alarm_notifier()
        from demo.telegram_bot import start_telegram_poller
        start_telegram_poller()
        print("[Demo] Mac demo mode ENABLED — login as 'demo' / 'demo'")
