"""Demo configuration — only active when PDUMIND_DEMO_ENABLED=1 in local .env."""
from __future__ import annotations

import os

DATA_DIR = os.getenv("DATA_DIR", "data")

DEMO_ENABLED = os.getenv("PDUMIND_DEMO_ENABLED", "").lower() in ("1", "true", "yes")
DEMO_DB_PATH = os.path.join(DATA_DIR, "pdumind_demo.db")
DEMO_USERNAME = os.getenv("DEMO_USERNAME", "demo")
DEMO_PASSWORD = os.getenv("DEMO_PASSWORD", "demo")
DEMO_HALL_NAME = "Demo Data Hall — Agoda Cage"

# Simulated PDU cage (mirrors Agoda 10.106.76.206–213 but on private demo subnet)
DEMO_SUBNET = "10.99.1.0/28"
DEMO_IPS = [f"10.99.1.{206 + i}" for i in range(8)]
DEMO_FACTORY_IP = "192.168.0.163"
DEMO_MAC_PREFIX = "18:D7:93:50:88"


def demo_enabled() -> bool:
    return DEMO_ENABLED


def is_demo_username(username: str) -> bool:
    return demo_enabled() and username == DEMO_USERNAME
