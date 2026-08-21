"""Hub coordinator mode — LAN sharing, fleet snapshot, and API access control."""
from __future__ import annotations

import json
import os
import socket
from copy import deepcopy
from typing import Any, Dict, List, Optional, Tuple

from flask import jsonify, request, g

from auth import _decode_token

DATA_DIR = os.getenv("DATA_DIR", "data")
HUB_CONFIG_PATH = os.path.join(DATA_DIR, "hub.json")
HUB_LAN_IP = os.getenv("HUB_LAN_IP", "").strip()
HUB_PORT = int(os.getenv("HUB_PORT", "3000"))

PUBLIC_GET_PREFIXES = (
    "/api/health",
    "/api/hub/info",
    "/api/halls",
    "/api/halls/default",
    "/api/polling/device/",
    "/api/pdus/by-ip/",
    "/api/events",
    "/api/models/",
    "/api/demo/incident/",
    "/api/demo/teams/invite/",
)

SENSITIVE_GET_PREFIXES = (
    "/api/pdu-admin/",
    "/api/debug/",
    "/api/auth/users",
    "/api/auth/access-log",
    "/api/auth/me",
    "/api/polling/stats",
    "/api/polling/devices",
    "/api/mibs",
    "/api/maintenance/",
    "/api/network/",
    "/api/batch/",
    "/api/config",
    "/api/data",
    "/api/test",
)


def _load_hub_config() -> Dict[str, Any]:
    defaults = {"viewer_enabled": True, "hub_name": "PDUMind Coordinator"}
    if not os.path.exists(HUB_CONFIG_PATH):
        return defaults
    try:
        with open(HUB_CONFIG_PATH, "r", encoding="utf-8") as fp:
            data = json.load(fp)
        return {**defaults, **data}
    except (json.JSONDecodeError, OSError):
        return defaults


def _save_hub_config(cfg: Dict[str, Any]) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(HUB_CONFIG_PATH, "w", encoding="utf-8") as fp:
        json.dump(cfg, fp, indent=2)


def detect_lan_ip() -> Optional[str]:
    """Best-effort LAN IPv4 for share URLs. Prefer HUB_LAN_IP env (set by installer)."""
    if HUB_LAN_IP:
        return HUB_LAN_IP
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.5)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    try:
        hostname = socket.gethostname()
        ip = socket.gethostbyname(hostname)
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    return None


def is_coordinator_authenticated() -> bool:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return False
    return _decode_token(auth_header[7:]) is not None


def sanitize_pdu(pdu: Dict[str, Any]) -> Dict[str, Any]:
    """Strip credentials before serving to unauthenticated viewers."""
    clean = dict(pdu)
    for key in (
        "web_admin_pass", "web_admin_user", "snmp_community",
        "snmp_write_community", "password", "community",
    ):
        clean.pop(key, None)
    return clean


def sanitize_hall_state(state: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not state:
        return state
    clean = deepcopy(state)
    if clean.get("pdus"):
        clean["pdus"] = [sanitize_pdu(p) for p in clean["pdus"]]
    return clean


def _display_name_for_pdu(pdu: Dict[str, Any], idx: int = 0) -> str:
    """Resolve human-readable PDU name — same priority as admin dashboard."""
    ip = pdu.get("ip_address") or ""
    mac = pdu.get("mac_address") or ""
    # Match Dashboard2: hostname → label → device_name → ip
    for raw in (pdu.get("hostname"), pdu.get("label"), pdu.get("device_name")):
        if not raw or not str(raw).strip():
            continue
        name = str(raw).strip()
        if "{" in name:
            try:
                from app import _resolve_hostname_pattern
                name = _resolve_hostname_pattern(name, idx, ip, mac)
            except Exception:
                pass
        if name and "{" not in name:
            return name
    return ip or "PDU"


def _parse_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(str(value).strip().strip('"'))
    except (TypeError, ValueError):
        return None


def _live_value(results: Dict[str, Any], *names: str) -> Optional[str]:
    for name in names:
        entry = results.get(name)
        if entry and entry.get("value") is not None:
            return str(entry["value"])
    return None


def _compute_pdu_health(
    pdu: Dict[str, Any],
    results: Dict[str, Any],
    online: bool,
    idx: int = 0,
) -> Tuple[int, str, List[str], Dict[str, Any]]:
    """Return health_score (0-100), status, issues, metrics."""
    label = _display_name_for_pdu(pdu, idx)
    ip = pdu.get("ip_address", "")
    metrics: Dict[str, Any] = {"ip": ip, "label": label}

    if not online:
        return 0, "offline", ["PDU unreachable"], {**metrics, "online": False}

    alarm_count = 0
    alarm_flags: List[str] = []
    raw_count = _live_value(results, "_alarm_count")
    if raw_count is not None:
        try:
            alarm_count = int(raw_count)
        except ValueError:
            alarm_count = 0
    raw_flags = _live_value(results, "_alarm_flags")
    if raw_flags:
        try:
            alarm_flags = json.loads(raw_flags)
        except json.JSONDecodeError:
            alarm_flags = []

    power = _parse_float(_live_value(results, "TotalPower", "total_active_power", "MasterPowerP1"))
    current = _parse_float(_live_value(results, "TotalCurrent", "neutral_current", "MasterCurrentP1"))
    voltage = _parse_float(_live_value(results, "MasterVoltageP1", "l1_voltage"))
    metrics.update({
        "online": True,
        "power_w": power,
        "current_a": current,
        "voltage_v": voltage,
        "alarm_count": alarm_count,
        "alarm_flags": alarm_flags,
    })

    score = 100
    issues: List[str] = []

    if alarm_count > 0:
        penalty = min(alarm_count * 15, 60)
        score -= penalty
        issues.append(f"{alarm_count} active alarm{'s' if alarm_count != 1 else ''}")

    load_pct = 0.0
    if current is not None and current > 0:
        # Heuristic: 32A per phase typical PDU rating
        load_pct = min(100.0, (current / 32.0) * 100.0)
        metrics["load_pct"] = round(load_pct, 1)
        if load_pct >= 90:
            score -= 25
            issues.append(f"High load ({load_pct:.0f}%)")
        elif load_pct >= 70:
            score -= 12
            issues.append(f"Elevated load ({load_pct:.0f}%)")

    score = max(0, min(100, score))

    if score >= 80:
        status = "healthy"
    elif score >= 50:
        status = "warning"
    elif score > 0:
        status = "critical"
    else:
        status = "offline"

    return score, status, issues, metrics


def build_fleet_snapshot(hall_id: int) -> Dict[str, Any]:
    """Aggregate fleet health from poller cache — one call for all viewers."""
    try:
        from demo.context import is_demo_session
        if is_demo_session():
            from demo.simulator import build_demo_fleet_snapshot
            return build_demo_fleet_snapshot(hall_id)
    except ImportError:
        pass

    from db import HallRepo, PDURepo
    from app import MULTI_PDU_RESULTS, MULTI_PDU_LOCK, MULTI_PDU_ERRORS, ensure_multi_pdu_poller

    ensure_multi_pdu_poller()
    hall = HallRepo.get(hall_id)
    if not hall:
        return {"error": "Hall not found"}

    pdus = PDURepo.get_by_hall(hall_id)
    active_pdus = [p for p in pdus if p.get("is_active", 1)]

    pdu_snapshots = []
    with MULTI_PDU_LOCK:
        cached_results = {ip: dict(v) for ip, v in MULTI_PDU_RESULTS.items()}
        cached_errors = dict(MULTI_PDU_ERRORS)

    for idx, pdu in enumerate(active_pdus):
        ip = pdu.get("ip_address")
        if not ip:
            continue
        results = cached_results.get(ip, {})
        has_errors = bool(cached_errors.get(ip))
        online = bool(results) and not has_errors
        if pdu.get("web_admin_port") and not results and not has_errors:
            online = False  # pending first poll

        score, status, issues, metrics = _compute_pdu_health(pdu, results, online, idx)
        pdu_snapshots.append({
            "id": pdu.get("id"),
            "ip": ip,
            "label": _display_name_for_pdu(pdu, idx),
            "rack_id": pdu.get("rack_id"),
            "health_score": score,
            "status": status,
            "issues": issues,
            "metrics": metrics,
            "rack_code": pdu.get("rack_code"),
        })

    total = len(pdu_snapshots)
    online_count = sum(1 for p in pdu_snapshots if p["metrics"].get("online"))
    alarm_total = sum(p["metrics"].get("alarm_count", 0) for p in pdu_snapshots)
    avg_health = round(sum(p["health_score"] for p in pdu_snapshots) / total, 1) if total else 0

    attention = sorted(
        pdu_snapshots,
        key=lambda p: (p["health_score"], p["metrics"].get("online", False)),
    )

    fleet_status = "healthy"
    if online_count == 0 and total > 0:
        fleet_status = "offline"
    elif any(p["status"] == "critical" for p in pdu_snapshots):
        fleet_status = "critical"
    elif any(p["status"] == "warning" for p in pdu_snapshots):
        fleet_status = "warning"

    return {
        "hall_id": hall_id,
        "hall_name": hall.get("name"),
        "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "fleet": {
            "total_pdus": total,
            "online_pdus": online_count,
            "offline_pdus": total - online_count,
            "alarm_count": alarm_total,
            "avg_health_score": avg_health,
            "status": fleet_status,
        },
        "pdus": pdu_snapshots,
        "attention": attention[:10],
    }


def register_hub_routes(app):
    """Register hub info, settings, and fleet snapshot routes."""

    @app.route("/api/hub/info", methods=["GET"])
    def hub_info():
        cfg = _load_hub_config()
        lan_ip = detect_lan_ip()
        share_url = f"http://{lan_ip}:{HUB_PORT}/view" if lan_ip else None
        return jsonify({
            "hub_name": cfg.get("hub_name", "PDUMind Coordinator"),
            "viewer_enabled": bool(cfg.get("viewer_enabled", True)),
            "lan_ip": lan_ip,
            "port": HUB_PORT,
            "share_url": share_url,
            "viewer_path": "/view",
            "hostname": socket.gethostname(),
        })

    @app.route("/api/hub/settings", methods=["GET"])
    def hub_settings_get():
        if not is_coordinator_authenticated():
            return jsonify({"error": "Authentication required"}), 401
        cfg = _load_hub_config()
        lan_ip = detect_lan_ip()
        return jsonify({
            **cfg,
            "lan_ip": lan_ip,
            "share_url": f"http://{lan_ip}:{HUB_PORT}/view" if lan_ip else None,
        })

    @app.route("/api/hub/settings", methods=["PUT"])
    def hub_settings_put():
        if not is_coordinator_authenticated():
            return jsonify({"error": "Authentication required"}), 401
        data = request.get_json(force=True) if request.data else {}
        cfg = _load_hub_config()
        if "viewer_enabled" in data:
            cfg["viewer_enabled"] = bool(data["viewer_enabled"])
        if "hub_name" in data:
            cfg["hub_name"] = str(data["hub_name"]).strip() or "PDUMind Coordinator"
        _save_hub_config(cfg)
        lan_ip = detect_lan_ip()
        return jsonify({
            "success": True,
            **cfg,
            "share_url": f"http://{lan_ip}:{HUB_PORT}/view" if lan_ip else None,
        })

    @app.route("/api/halls/<int:hall_id>/fleet-snapshot", methods=["GET"])
    def fleet_snapshot(hall_id: int):
        cfg = _load_hub_config()
        if not cfg.get("viewer_enabled", True) and not is_coordinator_authenticated():
            return jsonify({"error": "Viewer access is disabled"}), 403
        try:
            snapshot = build_fleet_snapshot(hall_id)
            if snapshot.get("error"):
                return jsonify(snapshot), 404
            return jsonify(snapshot)
        except Exception as e:
            return jsonify({"error": str(e)}), 500


def register_api_guard(app):
    """Block unauthenticated writes; restrict sensitive reads for viewer mode."""

    @app.before_request
    def _api_access_guard():
        path = request.path
        if not path.startswith("/api/"):
            return None
        if request.method == "OPTIONS":
            return None

        authed = is_coordinator_authenticated()
        if authed:
            g.coordinator_authenticated = True
            return None

        g.coordinator_authenticated = False

        if path == "/api/auth/login" and request.method == "POST":
            return None

        # Demo mobile incident links — token-gated, no coordinator login
        if path.startswith("/api/demo/incident/"):
            return None

        # Telegram bot webhook + hall subscribe invite (public)
        if path == "/api/demo/telegram/webhook" and request.method == "POST":
            return None
        if path.startswith("/api/demo/teams/invite/"):
            return None

        # Production Neural Ops public links — token-gated, no coordinator login
        if path.startswith("/api/ops/incident/"):
            return None
        if path == "/api/ops/telegram/webhook" and request.method == "POST":
            return None
        if path.startswith("/api/ops/teams/invite/"):
            return None

        # Hall report is rendered from Cage Pulse numbers already on screen (same as viewer GET /state).
        if path == "/api/reporting/hall-customer/pdf" and request.method == "POST":
            return None

        if request.method in ("POST", "PUT", "DELETE", "PATCH"):
            return jsonify({"error": "Authentication required"}), 401

        if request.method != "GET":
            return None

        for prefix in SENSITIVE_GET_PREFIXES:
            if path.startswith(prefix):
                return jsonify({"error": "Authentication required"}), 401

        if path.startswith("/api/halls/") and path.endswith("/fleet-snapshot"):
            cfg = _load_hub_config()
            if not cfg.get("viewer_enabled", True):
                return jsonify({"error": "Viewer access is disabled"}), 403
            return None

        for prefix in PUBLIC_GET_PREFIXES:
            if path == prefix or path.startswith(prefix):
                return None

        # Allow GET /api/halls/{id}/state for 3D viewer layout
        if path.startswith("/api/halls/") and path.endswith("/state"):
            cfg = _load_hub_config()
            if not cfg.get("viewer_enabled", True):
                return jsonify({"error": "Viewer access is disabled"}), 403
            return None

        return jsonify({"error": "Authentication required"}), 401
