"""Simulated PDU network, commissioning, and telemetry for demo mode."""
from __future__ import annotations

import ipaddress
import json
import math
import random
import time
import uuid
from threading import Lock, Thread
from typing import Any, Dict, List, Optional

from demo.config import (
    DEMO_FACTORY_IP,
    DEMO_HALL_NAME,
    DEMO_IPS,
    DEMO_MAC_PREFIX,
    DEMO_SCAN_RANGE,
    DEMO_SUBNET,
)
from demo.context import activate_demo_db

_batch_lock = Lock()
_BATCH_JOBS: Dict[str, Dict[str, Any]] = {}

_state_lock = Lock()
# ip -> {mac, commissioned, hostname, label, seq, ...}
_devices: Dict[str, Dict[str, Any]] = {}
_telemetry: Dict[str, Dict[str, Any]] = {}
_poller_started = False


def _mac_for_index(i: int) -> str:
    return f"{DEMO_MAC_PREFIX}:{i:02X}"


def _init_devices() -> None:
    with _state_lock:
        if _devices:
            return
        for i, ip in enumerate(DEMO_IPS):
            _devices[ip] = {
                "ip": ip,
                "mac": _mac_for_index(i),
                "seq": i + 1,
                "commissioned": False,
                "hostname": "",
                "label": "",
                "name": f"PDU-FACTORY-{i + 1:03d}",
                "description": "Raritan PX3 PDU (demo simulator)",
                "web_admin_port": 443,
                "web_admin_https": True,
                "snmp_version": "2c",
                "community": "private",
            }


def reset_simulator_state() -> None:
    """In-memory PDU sim back to factory DHCP — uncommissioned, no telemetry cache."""
    with _state_lock:
        _devices.clear()
        _telemetry.clear()
    with _batch_lock:
        _BATCH_JOBS.clear()
    _init_devices()


def uncommission_all_devices() -> None:
    """Mark every sim PDU uncommissioned without wiping the device table (DB cleared separately)."""
    _init_devices()
    with _state_lock:
        for dev in _devices.values():
            dev["commissioned"] = False
            dev["sim_offline"] = False
            dev["hostname"] = ""
            dev["label"] = ""
        _telemetry.clear()


def _demo_ip_set() -> set:
    return {ipaddress.IPv4Address(ip) for ip in DEMO_IPS}


def _scan_range_contains_demo_ip(subnet: str) -> bool:
    """True when the user's scan range includes at least one simulated PDU IP."""
    demo_ips = _demo_ip_set()
    if "-" in subnet and "/" not in subnet:
        parts = subnet.split("-")
        start = ipaddress.IPv4Address(parts[0].strip())
        end_s = parts[1].strip()
        if "." in end_s:
            end = ipaddress.IPv4Address(end_s)
        else:
            base = parts[0].strip().split(".")
            end = ipaddress.IPv4Address(".".join(base[:3] + [end_s]))
        scan_range = range(int(start), int(end) + 1)
        return any(int(ip) in scan_range for ip in demo_ips)
    if "/" in subnet:
        net = ipaddress.ip_network(subnet, strict=False)
        return any(ip in net for ip in demo_ips)
    return ipaddress.IPv4Address(subnet.strip()) in demo_ips


def _subnet_overlaps_demo(subnet: str) -> bool:
    try:
        if DEMO_FACTORY_IP in subnet:
            return True
        if _scan_range_contains_demo_ip(subnet):
            return True
        if "/" in subnet:
            net = ipaddress.ip_network(subnet, strict=False)
            demo_net = ipaddress.ip_network(DEMO_SUBNET, strict=False)
            return net.overlaps(demo_net)
        return ipaddress.IPv4Address(subnet.strip()) in ipaddress.ip_network(DEMO_SUBNET, strict=False)
    except Exception:
        return subnet.strip() in DEMO_IPS or DEMO_SUBNET in subnet or DEMO_SCAN_RANGE in subnet


def scan_snmp(subnet: str, community: str = "private") -> Dict[str, Any]:
    _init_devices()
    time.sleep(1.2 + random.random() * 0.8)
    if not _subnet_overlaps_demo(subnet):
        return {"success": True, "subnet": subnet, "discovered": [], "count": 0}
    discovered = []
    for ip, dev in _devices.items():
        if dev["commissioned"]:
            continue
        discovered.append({
            "ip": ip,
            "description": dev["description"],
            "name": dev["name"],
            "snmp_version": "2c",
            "community": community,
            "mac": dev["mac"],
        })
    return {"success": True, "subnet": subnet, "discovered": discovered, "count": len(discovered)}


def scan_http(subnet: str) -> Dict[str, Any]:
    _init_devices()
    time.sleep(1.5 + random.random())
    if not _subnet_overlaps_demo(subnet):
        return {"success": True, "subnet": subnet, "discovered": [], "count": 0}
    discovered = []
    for ip, dev in _devices.items():
        if dev["commissioned"]:
            continue
        discovered.append({
            "ip": ip,
            "description": dev["description"],
            "name": dev["name"],
            "web_admin_port": 443,
            "web_admin_https": True,
            "mac": dev["mac"],
            "http_title": "Raritan PDU Web",
        })
    return {"success": True, "subnet": subnet, "discovered": discovered, "count": len(discovered)}


def scan_factory(factory_ip: str) -> Dict[str, Any]:
    _init_devices()
    time.sleep(0.8)
    ip = factory_ip if factory_ip in _devices else DEMO_FACTORY_IP
    dev = _devices.get(ip)
    if not dev and factory_ip != DEMO_FACTORY_IP:
        return {"success": True, "found": False, "message": f"No PDU found at {factory_ip}"}
    dev = dev or _devices[DEMO_IPS[0]]
    return {
        "success": True,
        "found": True,
        "device": {
            "ip": dev["ip"],
            "description": dev["description"],
            "name": dev["name"],
            "snmp_version": "2c",
            "community": "private",
            "mac": dev["mac"],
            "web_admin_port": 443,
            "web_admin_https": True,
        },
    }


def demo_connect(host: str, port: int = 443, username: str = "admin", password: str = "admin") -> Dict[str, Any]:
    _init_devices()
    time.sleep(0.4)
    dev = _devices.get(host) or _devices.get(DEMO_FACTORY_IP) or _devices[DEMO_IPS[0]]
    return {
        "success": True,
        "web_port": port,
        "use_https": True,
        "device": {
            "name": dev.get("name", "PDU-DEMO"),
            "firmware": "3.2.1-demo",
            "mac": dev.get("mac", ""),
            "model": "PX3-5894",
        },
        "snmp": {"community_read": "private", "community_write": "private"},
        "network": {"ip": dev["ip"], "mask": "255.255.255.240", "gateway": "10.99.1.1"},
        "system": {"device_name": dev.get("name"), "router_hostname": dev.get("hostname") or "NTT-{seq}-{ip}-A"},
    }


def probe_login(host: str, username: str, password: str) -> Dict[str, Any]:
    _init_devices()
    time.sleep(0.5)
    if host not in _devices and host != DEMO_FACTORY_IP:
        return {
            "success": False,
            "error": "Host not in demo cage",
            "ports_tried": [443, 80],
        }
    return {
        "success": True,
        "host": host,
        "port": 443,
        "https": True,
        "username": username or "admin",
        "message": "Demo: login simulated successfully",
        "ports_tried": [{"port": 443, "https": True, "status": "ok"}],
    }


def _resolve_name(pattern: str, idx: int, ip: str, mac: str) -> str:
    import re as _re
    if not pattern:
        return ""
    def _numeric_repl(match):
        start_token = match.group(1)
        end_token = match.group(2)
        start = int(start_token)
        width = max(len(start_token), len(end_token)) if end_token else len(start_token)
        return str(start + idx).zfill(width)
    result = _re.sub(r"\{(\d+)(?:-(\d+))?\}", _numeric_repl, pattern)
    result = result.replace("{seq}", str(idx + 1).zfill(3))
    result = result.replace("{idx}", str(idx))
    result = result.replace("{ip}", ip or "")
    mac_clean = (mac or "").replace(":", "").replace("-", "")
    result = result.replace("{mac}", mac_clean[-6:] if mac_clean else "")
    return result


def _demo_entry(name: str, value: Any) -> Dict[str, Any]:
    return {"name": name, "oid": "demo", "value": str(value)}


# PDUs simulated offline while commissioned (seq numbers)
_DEMO_OFFLINE_SEQS = {6, 8}


def _layout_rack_code(row_index: int, position_index: int) -> str:
    """Match DataHallDesigner generateDataHallLayout rack.id format."""
    return f"Row-{row_index + 1:02d}/Rack-{position_index + 1:02d}"


def ensure_demo_rack_layout(hall_id: int) -> None:
    """Ensure rack codes align with 3D layout (Row-01/Rack-01, ...)."""
    activate_demo_db()
    from db import RackRepo

    racks = []
    for i in range(8):
        row = i // 4
        col = i % 4
        racks.append({
            "rack_code": _layout_rack_code(row, col),
            "row_index": row,
            "position_index": col,
            "x_m": 2 + col * 2.2,
            "y_m": 0,
            "z_m": 2 + row * 3.5,
            "width_mm": 600,
            "depth_mm": 1000,
            "height_u": 42,
            "model": "Standard 42U",
            "label": _layout_rack_code(row, col),
        })

    for rack in racks:
        RackRepo.upsert(hall_id, rack["rack_code"], rack)

    new_codes = {r["rack_code"] for r in racks}
    RackRepo.cleanup_stale(hall_id, new_codes)


def assign_demo_pdus_to_racks(hall_id: int, shuffle: bool = True) -> int:
    """Assign each demo PDU to exactly one rack (shuffled for easy visual spread)."""
    activate_demo_db()
    from db import PDURepo, RackRepo

    ensure_demo_rack_layout(hall_id)
    racks = sorted(
        RackRepo.get_by_hall(hall_id),
        key=lambda r: (r.get("row_index") or 0, r.get("position_index") or 0),
    )
    layout_racks = [r for r in racks if str(r.get("rack_code", "")).startswith("Row-")]
    if not layout_racks:
        layout_racks = racks[:8]

    pdus = [p for p in PDURepo.get_by_hall(hall_id) if p.get("ip_address") in DEMO_IPS]
    if shuffle:
        random.shuffle(pdus)

    assigned = 0
    for idx, pdu in enumerate(pdus):
        if idx >= len(layout_racks):
            break
        rack = layout_racks[idx]
        ip = pdu["ip_address"]
        PDURepo.upsert(hall_id, ip, {
            "rack_id": rack["id"],
            "mount_position": "A",
            "hostname": pdu.get("hostname"),
            "label": pdu.get("label"),
            "mac_address": pdu.get("mac_address"),
            "web_admin_port": pdu.get("web_admin_port") or 443,
            "web_admin_https": True,
            "web_admin_user": pdu.get("web_admin_user") or "admin",
            "web_admin_pass": pdu.get("web_admin_pass") or "demo",
            "is_active": True,
        })
        assigned += 1

    if assigned:
        print(f"[Demo] Assigned {assigned} PDUs to racks (shuffle={shuffle})")
    return assigned


def seed_demo_fleet(hall_id: int) -> int:
    """Pre-commission all 8 demo PDUs with dummy telemetry. Returns count seeded."""
    activate_demo_db()
    from db import PDURepo

    _init_devices()
    for idx, ip in enumerate(DEMO_IPS):
        seq = idx + 1
        hostname = f"NTT-{seq:03d}-{ip.split('.')[-1]}-A"
        sim_offline = seq in _DEMO_OFFLINE_SEQS

        with _state_lock:
            _devices[ip].update({
                "commissioned": True,
                "sim_offline": sim_offline,
                "seq": seq,
                "hostname": hostname,
                "label": hostname,
            })

        PDURepo.upsert(hall_id, ip, {
            "mount_position": "A",
            "hostname": hostname,
            "label": hostname,
            "mac_address": _mac_for_index(idx),
            "web_admin_port": 443,
            "web_admin_https": True,
            "web_admin_user": "admin",
            "web_admin_pass": "demo",
            "snmp_port": 161,
            "snmp_version": "2c",
            "is_active": True,
        })

    assign_demo_pdus_to_racks(hall_id, shuffle=True)
    count = len(DEMO_IPS)

    refresh_telemetry()
    print(f"[Demo] Pre-seeded {count} PDUs ({len(_DEMO_OFFLINE_SEQS)} simulated offline)")
    return count


def sync_demo_simulator_from_db(hall_id: int) -> None:
    """Rehydrate in-memory simulator from demo DB (survives backend restarts)."""
    activate_demo_db()
    from db import PDURepo

    _init_devices()
    pdus = PDURepo.get_by_hall(hall_id)
    if not pdus:
        return
    ip_to_idx = {ip: i for i, ip in enumerate(DEMO_IPS)}
    for pdu in pdus:
        ip = pdu.get("ip_address")
        if ip not in _devices:
            continue
        idx = ip_to_idx.get(ip, 0)
        seq = idx + 1
        with _state_lock:
            _devices[ip].update({
                "commissioned": True,
                "sim_offline": seq in _DEMO_OFFLINE_SEQS,
                "seq": seq,
                "hostname": pdu.get("hostname") or pdu.get("label") or ip,
                "label": pdu.get("label") or pdu.get("hostname") or ip,
            })
    refresh_telemetry()


def get_demo_fleet_telemetry(hall_id: Optional[int] = None) -> Dict[str, Any]:
    """Bulk telemetry snapshot for demo dashboard (includes offline stale data)."""
    _init_devices()
    if not any(d.get("commissioned") for d in _devices.values()):
        activate_demo_db()
        from db import HallRepo
        if hall_id is None:
            for h in HallRepo.get_all():
                if h.get("name") == DEMO_HALL_NAME:
                    hall_id = h["id"]
                    break
        if hall_id:
            sync_demo_simulator_from_db(hall_id)
            from db import PDURepo
            demo_pdus = [p for p in PDURepo.get_by_hall(hall_id) if p.get("ip_address") in DEMO_IPS]
            if demo_pdus and any(not p.get("rack_id") for p in demo_pdus):
                assign_demo_pdus_to_racks(hall_id, shuffle=True)
    refresh_telemetry()
    pdus = []
    for idx, ip in enumerate(DEMO_IPS):
        dev = _devices[ip]
        online = bool(dev.get("commissioned") and not dev.get("sim_offline"))
        with _state_lock:
            tel = _telemetry.get(ip) or _generate_telemetry(ip, dev)
            if ip not in _telemetry:
                _telemetry[ip] = tel

        results_list = list(tel.values())
        flags_entry = tel.get("_alarm_flags", {})
        count_entry = tel.get("_alarm_count", {})
        count = int(count_entry.get("value", "0") if isinstance(count_entry, dict) else 0)
        flags = []
        try:
            flags = json.loads(flags_entry.get("value", "[]") if isinstance(flags_entry, dict) else "[]")
        except Exception:
            pass
        alarm_entries = [
            {"key": k, "value": v.get("value", "")}
            for k, v in tel.items()
            if k.startswith("alarm_") and not k.endswith("_color")
            and k not in ("alarm_status", "alarm_color")
        ]

        pdus.append({
            "ip": ip,
            "seq": dev.get("seq", idx + 1),
            "online": online,
            "state": "online" if online else "offline",
            "label": dev.get("label") or hostname if (hostname := dev.get("hostname")) else ip,
            "results": results_list if dev.get("commissioned") else [],
            "alarm_count": count,
            "alarm_flags": flags,
            "alarm_entries": alarm_entries,
            "env": {
                "temp": tel.get("Temperature1", {}).get("value"),
                "temp2": tel.get("Temperature2", {}).get("value"),
                "hum": tel.get("Humidity1", {}).get("value"),
                "door": tel.get("DoorStatus", {}).get("value"),
            },
        })
    online_n = sum(1 for p in pdus if p["online"])
    return {
        "pdus": pdus,
        "summary": {
            "total": len(pdus),
            "online": online_n,
            "offline": len(pdus) - online_n,
            "alarm_total": sum(p["alarm_count"] for p in pdus),
        },
    }


_DEMO_SCENARIOS: Dict[int, Dict[str, Any]] = {
    1: {"temp": 21.8, "temp2": 22.1, "hum": 38, "door": "Closed"},
    2: {"temp": 28.6, "temp2": 27.9, "hum": 45, "door": "Closed", "alarm_temp1": "High"},
    3: {"temp": 24.2, "temp2": 24.5, "hum": 42, "door": "Open", "alarm_sensor1": "Open"},
    4: {"temp": 23.1, "temp2": 23.4, "hum": 74, "door": "Closed", "alarm_hum1": "High"},
    5: {"temp": 22.4, "temp2": 22.8, "hum": 41, "door": "Closed", "alarm_l1_current": "High"},
    6: {"temp": 21.5, "temp2": 21.9, "hum": 37, "door": "Closed"},
    7: {"temp": 35.4, "temp2": 34.8, "hum": 48, "door": "Closed", "alarm_temp1": "Critical"},
    8: {"temp": 24.0, "temp2": 24.3, "hum": 44, "door": "Ajar", "alarm_sensor1": "Ajar"},
}


def _generate_telemetry(ip: str, dev: Dict[str, Any]) -> Dict[str, Any]:
    seq = dev.get("seq", 1)
    scenario = _DEMO_SCENARIOS.get(seq, _DEMO_SCENARIOS[1])
    base_load = 8 + seq * 2.5
    jitter = random.uniform(-1.5, 1.5)
    current = max(0.5, base_load + jitter)
    voltage = 230 + random.uniform(-2, 2)
    power = current * voltage * 0.95

    drift = math.sin(time.time() / 25 + seq) * 0.35
    temp1 = scenario["temp"] + drift
    temp2 = scenario.get("temp2", temp1 + 0.4) + drift * 0.8
    humidity = scenario["hum"] + math.sin(time.time() / 40 + seq * 2) * 1.2
    door = scenario["door"]

    alarm_fields: Dict[str, str] = {
        "alarm_l1_voltage": "Normal",
        "alarm_l2_voltage": "Normal",
        "alarm_l3_voltage": "Normal",
        "alarm_l1_current": scenario.get("alarm_l1_current", "Normal"),
        "alarm_l2_current": "Normal",
        "alarm_l3_current": "Normal",
        "alarm_neutral": "Normal",
        "alarm_phase_unbalance": "Normal",
        "alarm_temp1": scenario.get("alarm_temp1", "Normal"),
        "alarm_temp2": "Normal",
        "alarm_hum1": scenario.get("alarm_hum1", "Normal"),
        "alarm_hum2": "Normal",
        "alarm_sensor1": scenario.get("alarm_sensor1", "Normal" if door == "Closed" else door),
        "alarm_sensor2": "Normal",
    }

    flags = [{"param": k} for k, v in alarm_fields.items() if v and v.lower() != "normal"]
    alarm_count = len(flags)

    results: Dict[str, Any] = {
        "MasterVoltageP1": _demo_entry("MasterVoltageP1", f"{voltage:.1f}"),
        "MasterVoltageP2": _demo_entry("MasterVoltageP2", f"{voltage - random.uniform(0.5, 1.5):.1f}"),
        "MasterVoltageP3": _demo_entry("MasterVoltageP3", f"{voltage + random.uniform(0.2, 1.0):.1f}"),
        "MasterCurrentP1": _demo_entry("MasterCurrentP1", f"{current:.2f}"),
        "MasterCurrentP2": _demo_entry("MasterCurrentP2", f"{current * 0.98:.2f}"),
        "MasterCurrentP3": _demo_entry("MasterCurrentP3", f"{current * 1.01:.2f}"),
        "TotalCurrent": _demo_entry("TotalCurrent", f"{current:.2f}"),
        "TotalPower": _demo_entry("TotalPower", f"{power:.0f}"),
        "TotalEnergy": _demo_entry("TotalEnergy", f"{1200 + seq * 50 + random.randint(0, 20)}"),
        "PowerFactor": _demo_entry("PowerFactor", f"{0.92 + random.uniform(0, 0.06):.2f}"),
        "Frequency": _demo_entry("Frequency", f"{50.0 + random.uniform(-0.05, 0.05):.2f}"),
        "Temperature1": _demo_entry("Temperature1", f"{temp1:.1f}"),
        "Temperature2": _demo_entry("Temperature2", f"{temp2:.1f}"),
        "Humidity1": _demo_entry("Humidity1", f"{humidity:.1f}"),
        "Humidity2": _demo_entry("Humidity2", f"{max(30, humidity - random.uniform(2, 5)):.1f}"),
        "DoorStatus": _demo_entry("DoorStatus", door),
        "rack_inlet_temp": _demo_entry("rack_inlet_temp", f"{temp1:.1f}"),
        "_alarm_count": _demo_entry("_alarm_count", alarm_count),
        "_alarm_flags": _demo_entry("_alarm_flags", json.dumps(flags)),
    }
    for key, val in alarm_fields.items():
        results[key] = _demo_entry(key, val)

    for outlet in range(1, 25):
        on = outlet % 3 != 0
        oc = current / 22 if on else 0
        results[f"Output{outlet}Status"] = _demo_entry(f"Output{outlet}Status", "ON" if on else "OFF")
        results[f"Output{outlet}Current"] = _demo_entry(f"Output{outlet}Current", f"{oc:.2f}")
    return results


def refresh_telemetry() -> None:
    _init_devices()
    with _state_lock:
        for ip, dev in _devices.items():
            if dev.get("commissioned"):
                _telemetry[ip] = _generate_telemetry(ip, dev)


def get_live(ip: str) -> Dict[str, Any]:
    _init_devices()
    if ip not in _devices:
        return {"ip": ip, "results": [], "errors": [], "status": "pending", "source": "demo"}
    dev = _devices[ip]
    if not dev.get("commissioned"):
        return {
            "ip": ip, "results": [], "errors": [{"name": "_demo", "error": "Not commissioned yet"}],
            "status": "pending", "source": "demo",
        }
    if dev.get("sim_offline"):
        with _state_lock:
            stale = _telemetry.get(ip) or _generate_telemetry(ip, dev)
            _telemetry[ip] = stale
        return {
            "ip": ip,
            "results": [],
            "errors": [{"name": "_demo", "error": "Device unreachable (simulated offline)"}],
            "status": "error",
            "source": "demo",
            "stale_env": {
                "temp": stale.get("Temperature1", {}).get("value"),
                "hum": stale.get("Humidity1", {}).get("value"),
                "door": stale.get("DoorStatus", {}).get("value"),
            },
        }
    with _state_lock:
        results = _telemetry.get(ip) or _generate_telemetry(ip, dev)
        _telemetry[ip] = results
    return {
        "ip": ip,
        "results": list(results.values()),
        "errors": [],
        "status": "success",
        "source": "demo",
    }


def get_poll_status(ip: str) -> Dict[str, Any]:
    _init_devices()
    dev = _devices.get(ip)
    if dev and dev.get("commissioned") and not dev.get("sim_offline"):
        return {"state": "online", "source": "demo"}
    if dev and dev.get("commissioned") and dev.get("sim_offline"):
        return {"state": "offline", "source": "demo", "message": "Simulated network loss"}
    if dev:
        return {"state": "offline", "source": "demo", "message": "Uncommissioned"}
    return {"state": "offline", "source": "demo"}


def start_demo_poller() -> None:
    global _poller_started
    if _poller_started:
        return
    _poller_started = True

    def _loop():
        while True:
            try:
                refresh_telemetry()
            except Exception as e:
                print(f"[DemoPoller] error: {e}")
            time.sleep(10)

    Thread(target=_loop, daemon=True, name="demo-poller").start()
    print("[DemoPoller] Started synthetic telemetry (10s interval)")


def start_batch_commission(template: dict, pdu_list: list, hall_id: int) -> str:
    _init_devices()
    job_id = str(uuid.uuid4())[:8]
    job = {
        "id": job_id,
        "status": "running",
        "template": template,
        "hall_id": hall_id,
        "total": len(pdu_list),
        "completed": 0,
        "results": {},
        "started_at": time.time(),
    }
    with _batch_lock:
        _BATCH_JOBS[job_id] = job

    Thread(
        target=_run_demo_batch,
        args=(job_id, template, pdu_list, hall_id),
        daemon=True,
        name=f"demo-batch-{job_id}",
    ).start()
    return job_id


def get_batch_status(job_id: str) -> Optional[Dict[str, Any]]:
    with _batch_lock:
        return _BATCH_JOBS.get(job_id)


def _run_demo_batch(job_id: str, template: dict, pdu_list: list, hall_id: int) -> None:
    activate_demo_db()
    from db import PDURepo, RackRepo

    sys_t = template.get("system") or {}
    hostname_pat = sys_t.get("router_hostname") or "NTT-{seq}-{ip}-A"
    sync_name = sys_t.get("sync_device_name", True) is not False
    racks = sorted(
        RackRepo.get_by_hall(hall_id),
        key=lambda r: (r.get("row_index") or 0, r.get("position_index") or 0),
    )

    try:
        for idx, pdu_info in enumerate(pdu_list):
            ip = pdu_info.get("ip", "")
            mac = pdu_info.get("mac") or _devices.get(ip, {}).get("mac", "")
            pdu_key = mac or ip
            status = {
                "ip": ip, "mac": mac, "step": "connecting",
                "success": False, "sections": {}, "new_ip": ip, "error": None,
            }
            with _batch_lock:
                _BATCH_JOBS[job_id]["results"][pdu_key] = status

            for step in ("connecting", "network", "snmp", "system", "time", "done"):
                status["step"] = step
                time.sleep(0.6 + random.random() * 0.4)

            hostname = _resolve_name(hostname_pat, idx, ip, mac) if sync_name else f"PDU-{ip}"
            label = hostname

            with _state_lock:
                if ip in _devices:
                    _devices[ip].update({
                        "commissioned": True,
                        "sim_offline": (idx + 1) in _DEMO_OFFLINE_SEQS,
                        "hostname": hostname,
                        "label": label,
                        "seq": idx + 1,
                    })

            rack = racks[idx] if idx < len(racks) else None
            pdu_data = {
                "rack_id": rack["id"] if rack else None,
                "mount_position": "A",
                "hostname": hostname,
                "label": label,
                "mac_address": mac,
                "web_admin_port": 443,
                "web_admin_https": True,
                "web_admin_user": "admin",
                "web_admin_pass": "demo",
                "snmp_port": 161,
                "snmp_version": "2c",
                "is_active": True,
            }
            PDURepo.upsert(hall_id, ip, pdu_data)

            status["success"] = True
            status["step"] = "done"
            status["sections"] = {
                "network": {"success": True},
                "snmp": {"success": True},
                "system": {"success": True, "hostname": hostname},
                "time": {"success": True},
            }
            with _batch_lock:
                _BATCH_JOBS[job_id]["completed"] += 1

        with _batch_lock:
            _BATCH_JOBS[job_id]["status"] = "completed"
            _BATCH_JOBS[job_id]["finished_at"] = time.time()
        assign_demo_pdus_to_racks(hall_id, shuffle=True)
        refresh_telemetry()
    except Exception as e:
        import traceback
        traceback.print_exc()
        with _batch_lock:
            _BATCH_JOBS[job_id]["status"] = "failed"
            _BATCH_JOBS[job_id]["error"] = str(e)


def repair_pdus(hall_id: int, pdu_ids: Optional[List[int]], username: str, password: str) -> Dict[str, Any]:
    activate_demo_db()
    from db import HallRepo, PDURepo

    _init_devices()
    time.sleep(0.8)
    hall = HallRepo.get(hall_id)
    pdus = PDURepo.get_by_hall(hall_id)
    id_set = set(pdu_ids) if pdu_ids else None
    results = []
    for pdu in pdus:
        if id_set is not None and pdu["id"] not in id_set:
            continue
        ip = pdu["ip_address"]
        time.sleep(0.4)
        PDURepo.upsert(hall_id, ip, {
            "rack_id": pdu.get("rack_id"),
            "mount_position": pdu.get("mount_position", "A"),
            "hostname": pdu.get("hostname"),
            "label": pdu.get("label"),
            "mac_address": pdu.get("mac_address"),
            "web_admin_port": 443,
            "web_admin_https": True,
            "web_admin_user": username or "admin",
            "web_admin_pass": password or "demo",
            "is_active": True,
        })
        with _state_lock:
            if ip in _devices:
                _devices[ip]["commissioned"] = True
        results.append({
            "id": pdu["id"],
            "ip": ip,
            "label": pdu.get("hostname") or pdu.get("label") or ip,
            "success": True,
            "code": "REPAIRED",
            "message": "Demo: credentials restored",
            "steps": [{"phase": "login", "ok": True}, {"phase": "db_update", "ok": True}],
            "before": {"web_admin_port": None},
            "after": {"web_admin_port": 443, "web_admin_https": True, "web_admin_user": username or "admin"},
        })
    repaired = sum(1 for r in results if r["success"])
    return {
        "success": True,
        "hall_id": hall_id,
        "hall_name": hall.get("name") if hall else DEMO_HALL_NAME,
        "repaired": repaired,
        "attempted": len(results),
        "results": results,
    }


def build_demo_fleet_snapshot(hall_id: int) -> Dict[str, Any]:
    """Fleet health for demo viewer/coordinator dashboards."""
    activate_demo_db()
    from db import HallRepo, PDURepo
    from hub import _compute_pdu_health, _display_name_for_pdu

    _init_devices()
    hall = HallRepo.get(hall_id)
    if not hall:
        return {"error": "Hall not found"}

    pdus = PDURepo.get_by_hall(hall_id)
    active_pdus = [p for p in pdus if p.get("is_active", 1)]
    pdu_snapshots = []

    for idx, pdu in enumerate(active_pdus):
        ip = pdu.get("ip_address")
        if not ip:
            continue
        live = get_live(ip)
        results_list = live.get("results") or []
        results = {r["name"]: r for r in results_list if r.get("name")}
        online = live.get("status") == "success"
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
    attention = sorted(pdu_snapshots, key=lambda p: (p["health_score"], p["metrics"].get("online", False)))

    fleet_status = "healthy"
    if online_count == 0 and total > 0:
        fleet_status = "offline"
    elif any(p["status"] == "critical" for p in pdu_snapshots):
        fleet_status = "critical"
    elif any(p["status"] == "warning" for p in pdu_snapshots):
        fleet_status = "warning"

    import datetime
    return {
        "hall_id": hall_id,
        "hall_name": hall.get("name"),
        "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
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
