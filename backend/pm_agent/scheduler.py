"""Autonomous loop that periodically evaluates telemetry and inserts alerts."""
from __future__ import annotations
import schedule, time, json, sqlite3, os
from datetime import datetime, timezone
from .tools import inference
from ..database import _connect  # reuse low-level helper

INTERVAL_SECONDS = int(os.getenv("PM_AGENT_INTERVAL", "60"))


def _store_alert(outlet_id: int, severity: float, msg: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO maintenance_alert(outlet_id, ts_utc, type, severity, message) VALUES (?, ?, ?, ?, ?)",
            (outlet_id, datetime.now(timezone.utc).isoformat(timespec="seconds"), "anomaly", severity, msg),
        )
        conn.commit()


def check_all_outlets() -> None:
    for outlet in range(1, 25):
        res_json = inference(outlet)
        if not res_json or res_json == "{}":
            continue
        res = json.loads(res_json)
        score = res.get("anomaly_score", 0.0)
        # lower score → more anomalous (IsolationForest)
        if score < -0.05:
            _store_alert(outlet, score, f"IsolationForest anomaly score={score:.3f}")


def run_loop():
    schedule.every(INTERVAL_SECONDS).seconds.do(check_all_outlets)
    while True:
        schedule.run_pending()
        time.sleep(1)

if __name__ == "__main__":
    run_loop()
