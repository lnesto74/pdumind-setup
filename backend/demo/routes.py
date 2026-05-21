"""Demo API intercepts and reset route."""
from __future__ import annotations

import re

from flask import jsonify, request, g

from auth import require_auth
from demo.context import bind_request_context, is_demo_session
from demo.seed import seed_demo_hall, setup_demo_environment
from demo.simulator import (
    get_batch_status,
    get_live,
    get_poll_status,
    demo_connect,
    probe_login,
    repair_pdus,
    reset_simulator_state,
    scan_factory,
    scan_http,
    scan_snmp,
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
        return _try_intercept()

    @app.route("/api/demo/reset", methods=["POST"])
    @require_auth
    def demo_reset():
        if not is_demo_session():
            return jsonify({"error": "Demo reset requires demo user login"}), 403
        reset_simulator_state()
        hall_id = seed_demo_hall(force=True)
        return jsonify({"success": True, "hall_id": hall_id, "message": "Demo cage reset — 8 factory PDUs ready to scan"})

    @app.route("/api/demo/status", methods=["GET"])
    @require_auth
    def demo_status():
        if not is_demo_session():
            return jsonify({"demo_mode": False})
        return jsonify({
            "demo_mode": True,
            "scan_subnet": "10.99.1.0/28",
            "factory_ip": "192.168.0.163",
            "pdu_count": 8,
            "hint": "Use Batch scan on 10.99.1.0/28 or HTTP scan for full demo flow",
        })


def _try_intercept():
    method = request.method
    path = request.path

    if method == "POST" and path == "/api/network/scan":
        data = request.get_json(force=True) if request.data else {}
        return jsonify(scan_snmp(data.get("subnet", "10.99.1.0/28"), data.get("community", "private")))

    if method == "POST" and path == "/api/network/scan/http":
        data = request.get_json(force=True) if request.data else {}
        return jsonify(scan_http(data.get("subnet", "10.99.1.0/28")))

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
        return jsonify(get_live(m.group(1)))

    m = re.match(r"^/api/polling/device/([^/]+)$", path)
    if method == "GET" and m:
        return jsonify(get_poll_status(m.group(1)))

    return None


def init_demo_on_startup(app):
    """Seed demo DB and user when PDUMIND_DEMO_ENABLED=1."""
    from demo.config import demo_enabled
    if demo_enabled():
        setup_demo_environment(force_seed=False)
        print("[Demo] Mac demo mode ENABLED — login as 'demo' / 'demo'")
