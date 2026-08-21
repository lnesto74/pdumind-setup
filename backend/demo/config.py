"""Demo configuration — only active when PDUMIND_DEMO_ENABLED=1 in local .env.

This module also hosts the shared "ops namespace" switch used by the Neural Ops
layer. The same incident / ops-team / integration lifecycle code serves two
namespaces selected per-request via a thread-local:

  - "demo": demo JSON stores (demo_*.json) + demo DB + simulated alarms
  - "ops" : production JSON stores (ops_*.json) + main DB + REAL poller alarms

Production behaviour is unchanged unless PDUMIND_OPS_ENABLED is set.
"""
from __future__ import annotations

import os
import threading

DATA_DIR = os.getenv("DATA_DIR", "data")

DEMO_ENABLED = os.getenv("PDUMIND_DEMO_ENABLED", "").lower() in ("1", "true", "yes")
DEMO_DB_PATH = os.path.join(DATA_DIR, "pdumind_demo.db")
DEMO_USERNAME = os.getenv("DEMO_USERNAME", "demo")
DEMO_PASSWORD = os.getenv("DEMO_PASSWORD", "demo")
DEMO_HALL_NAME = "Demo Data Hall — Agoda Cage"

# Production Neural Ops layer — additive, off by default (zero production impact).
OPS_ENABLED = os.getenv("PDUMIND_OPS_ENABLED", "").lower() in ("1", "true", "yes")

# Per-request namespace for the shared ops/incident lifecycle code.
_ns_tls = threading.local()


def ops_enabled() -> bool:
    return OPS_ENABLED


def set_ops_namespace(ns: str) -> None:
    """Set active namespace for this thread/request ('demo' or 'ops')."""
    _ns_tls.namespace = "ops" if ns == "ops" else "demo"


def get_ops_namespace() -> str:
    return getattr(_ns_tls, "namespace", "demo")


def is_ops_namespace() -> bool:
    return get_ops_namespace() == "ops"


def store_path(basename: str) -> str:
    """Resolve a JSON store path for the active namespace.

    e.g. store_path("incidents.json") -> data/demo_incidents.json (demo)
                                       -> data/ops_incidents.json  (ops)
    """
    prefix = "ops" if get_ops_namespace() == "ops" else "demo"
    return os.path.join(DATA_DIR, f"{prefix}_{basename}")

# Simulated PDU cage (mirrors Agoda 10.106.76.206–213 but on private demo subnet)
DEMO_IPS = [f"10.99.1.{206 + i}" for i in range(8)]
# /27 covers 10.99.1.192–223 (includes all 8 demo PDUs at .206–.213)
DEMO_SUBNET = "10.99.1.192/27"
DEMO_SCAN_RANGE = "10.99.1.206-213"
DEMO_FACTORY_IP = "192.168.0.163"
DEMO_MAC_PREFIX = "18:D7:93:50:88"


def demo_enabled() -> bool:
    return DEMO_ENABLED


def is_demo_username(username: str) -> bool:
    return demo_enabled() and username == DEMO_USERNAME


def is_demo_device_ip(ip: str) -> bool:
    """True only for simulated demo PDUs (the 10.99.1.x cage + factory IP).

    Used so demo-mode request intercepts don't hijack telemetry for *real* PDUs
    (e.g. 172.28.x) when a session happens to be flagged demo / localhost-viewer.
    """
    ip = (ip or "").strip()
    if ip == DEMO_FACTORY_IP or ip in DEMO_IPS:
        return True
    try:
        import ipaddress
        return ipaddress.ip_address(ip) in ipaddress.ip_network(DEMO_SUBNET)
    except ValueError:
        return False
