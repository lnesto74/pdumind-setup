"""Identity of a PDU telemetry sample.

A cache read, a skipped cycle, and an outlet-only patch must not renew the
measurement time of the other values. Login failure and loss of reachability
keep the last values and mark them stale.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Optional

POWER_FIELDS = frozenset({
    "l1_active_power", "l2_active_power", "l3_active_power",
    "total_active_power",
    "MasterPowerP1", "MasterPowerP2", "MasterPowerP3",
    "TotalPower",
    "phase1ActivePower", "phase2ActivePower", "phase3ActivePower",
    "deviceStatusActivePower",
})

_UNIT_RE = re.compile(r"^(-?\d+(?:\.\d+)?)(?:\s*)(kW|W)$", re.IGNORECASE)


def sample_clock(when: Optional[float] = None) -> str:
    moment = datetime.fromtimestamp(when, timezone.utc) if when is not None else datetime.now(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def embedded_power_unit(value: Any) -> Optional[str]:
    if value is None:
        return None
    match = _UNIT_RE.match(str(value).replace('"', "").strip())
    if not match:
        return None
    return "kW" if match.group(2).lower() == "kw" else "W"


def annotate_power_units(results: Dict[str, Any], default_unit: Optional[str] = None) -> None:
    """Record a unit only when the sample carries one, or the collector's scale is known.

    A bare number without a known scale stays unitless. Callers must not invent kW.
    """
    for name, entry in results.items():
        if name not in POWER_FIELDS or not isinstance(entry, dict):
            continue
        embedded = embedded_power_unit(entry.get("value"))
        if embedded:
            entry["unit"] = embedded
        elif default_unit in ("W", "kW") and not entry.get("unit"):
            entry["unit"] = default_unit


def stamp_entries(results: Dict[str, Any], measured_at: str, only: Optional[Iterable[str]] = None) -> None:
    allow = set(only) if only is not None else None
    for name, entry in results.items():
        if allow is not None and name not in allow:
            continue
        if isinstance(entry, dict) and "value" in entry:
            entry["measured_at"] = measured_at


def note_sample(store: Dict[str, Dict[str, Any]], ip: str, **fields: Any) -> Dict[str, Any]:
    """Update sample identity. Omitted fields keep their previous value."""
    current = dict(store.get(ip) or {})
    for key, value in fields.items():
        if value is not None:
            current[key] = value
    store[ip] = current
    return current


def commit_poll(
    previous_results: Dict[str, Any],
    previous_errors: Dict[str, Any],
    sample: Optional[Dict[str, Any]],
    results: Dict[str, Any],
    errors: Dict[str, Any],
):
    """Apply one poll outcome without promoting a cached or failed read to a new sample."""
    kind = (sample or {}).get("kind")
    if kind == "skipped":
        return previous_results, previous_errors, False
    if kind == "full":
        return results, errors, True
    return previous_results, errors, False


def live_payload(
    ip: str,
    results: Dict[str, Any],
    errors: Dict[str, Any],
    sample: Optional[Dict[str, Any]],
    source: Optional[str] = None,
) -> Dict[str, Any]:
    sample = sample or {}
    result_list = list(results.values()) if isinstance(results, dict) else list(results or [])
    error_list = list(errors.values()) if isinstance(errors, dict) else list(errors or [])
    measured = sample.get("measured_at")
    if sample.get("stale") is True or sample.get("authentication") == "failed" or sample.get("reachability") == "offline":
        stale = True
    elif measured and sample.get("stale") is False:
        stale = False
    elif result_list:
        stale = True
    else:
        stale = False
    if not result_list and not error_list:
        status = "pending"
    elif error_list:
        status = "partial"
    elif stale:
        status = "stale"
    else:
        status = "success"
    payload = {
        "ip": ip,
        "results": result_list,
        "errors": error_list,
        "status": status,
        "measured_at": measured,
        "last_attempt_at": sample.get("last_attempt_at"),
        "last_success_at": sample.get("last_success_at"),
        "stale": stale,
        "authentication": sample.get("authentication") or "unknown",
        "reachability": sample.get("reachability") or "unknown",
        "cached": True,
    }
    if source:
        payload["source"] = source
    return payload
