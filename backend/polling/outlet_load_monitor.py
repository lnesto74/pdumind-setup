"""
Detect when a switched outlet stays ON but its load current drops to zero —
typically a server unplugged or cable pulled while the outlet remains energized.
"""

from __future__ import annotations

import json
import re
import threading  # used by _state_lock
from typing import Any, Dict, List, Optional, Set, Tuple

# Amps — outlet must have carried at least this much load before we alarm on drop.
LOAD_PRESENT_A = 0.5
# Amps — below this while outlet is ON counts as load lost.
LOAD_LOST_A = 0.1
# Amps — start fast outlet-only polling when a live outlet carries at least this much.
FAST_WATCH_PRESENT_A = 0.3

_state_lock = threading.Lock()
# ip -> outlet_num -> {"had_load": bool, "alarm": bool, "last_a": float}
_outlet_state: Dict[str, Dict[int, Dict[str, Any]]] = {}


def _parse_float(val: Any) -> Optional[float]:
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip().strip('"').lower()
    if not s or s in ("-", "n/a", "na", "none", "null"):
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def _outlet_on(val: Any) -> bool:
    if val is None:
        return False
    s = str(val).strip().strip('"').lower()
    if s in ("1", "on", "true", "yes", "enabled", "2"):
        return True
    if s in ("0", "off", "false", "no", "disabled"):
        return False
    try:
        return int(float(s)) > 0
    except (ValueError, TypeError):
        return False


def _iter_outlets(results: Dict[str, Any]) -> List[Tuple[int, Optional[float], bool]]:
    """Return [(outlet_num, current_amps_or_None, is_on), ...] from poll results."""
    by_outlet: Dict[int, Dict[str, Any]] = {}
    for key, entry in results.items():
        m = re.match(r"^Output(\d+)(Status|Current)$", key)
        if not m:
            continue
        n = int(m.group(1))
        slot = by_outlet.setdefault(n, {})
        raw = entry.get("value") if isinstance(entry, dict) else entry
        if m.group(2) == "Status":
            slot["on"] = _outlet_on(raw)
        else:
            slot["a"] = _parse_float(raw)

    rows: List[Tuple[int, Optional[float], bool]] = []
    for n in sorted(by_outlet):
        slot = by_outlet[n]
        rows.append((n, slot.get("a"), bool(slot.get("on"))))
    return rows


def _existing_flags(results: Dict[str, Any]) -> List[Dict[str, str]]:
    entry = results.get("_alarm_flags")
    if not entry:
        return []
    raw = entry.get("value") if isinstance(entry, dict) else entry
    try:
        flags = json.loads(raw or "[]")
        return flags if isinstance(flags, list) else []
    except (TypeError, ValueError):
        return []


def _set_flags(results: Dict[str, Any], flags: List[Dict[str, str]]) -> None:
    results["_alarm_flags"] = {
        "name": "_alarm_flags",
        "oid": results.get("_alarm_flags", {}).get("oid", "outlet_load"),
        "value": json.dumps(flags),
    }
    results["_alarm_count"] = {
        "name": "_alarm_count",
        "oid": results.get("_alarm_count", {}).get("oid", "outlet_load"),
        "value": str(len(flags)),
    }


def _trigger_alarm_notifier(ip: str, outlet_nums: set, results: Dict[str, Any]) -> None:
    """Dispatch Telegram on the same poll cycle — do not wait for the 12s notifier loop."""
    try:
        from demo.integrations import dispatch_outlet_load_alarms, check_and_notify_alarms
        dispatch_outlet_load_alarms(ip, outlet_nums, results)
        check_and_notify_alarms()
    except Exception as exc:
        print(f"[outlet_load_monitor] alarm notify trigger failed: {exc}")


def _pdu_mount_slot(ip: str) -> str:
    try:
        from db import PDURepo
        pdu = PDURepo.get_by_ip(ip)
        slot = (pdu or {}).get("mount_position") or "A"
        return str(slot).strip().upper()[:1] or "A"
    except Exception:
        return "A"


def _outlet_display_code(ip: str, outlet_num: int) -> str:
    """PDU mount letter + zero-padded outlet index, e.g. A01, B12."""
    return f"{_pdu_mount_slot(ip)}{outlet_num:02d}"


def _outlet_name_from_results(results: Dict[str, Any], outlet_num: int) -> Optional[str]:
    entry = results.get(f"Output{outlet_num}Name")
    if not entry:
        return None
    raw = entry.get("value") if isinstance(entry, dict) else entry
    if raw is None:
        return None
    name = str(raw).strip().strip('"')
    return name if name and name not in ("-", "0", "n/a", "na") else None


def apply_outlet_load_alarms(ip: str, results: Dict[str, Any]) -> bool:
    """Merge outlet load-lost warnings into poll results. Returns True if new alarms."""
    if not ip or not results:
        return False

    outlets = _iter_outlets(results)
    if not outlets:
        return False

    new_alarms: Set[int] = set()
    cleared_alarms: Set[int] = set()
    active_load_lost: Set[int] = set()

    with _state_lock:
        pdu_state = _outlet_state.setdefault(ip, {})
        for outlet_num, current_a, is_on in outlets:
            st = pdu_state.setdefault(outlet_num, {"had_load": False, "alarm": False, "last_a": 0.0})
            prev_alarm = bool(st.get("alarm"))

            if not is_on:
                if prev_alarm:
                    cleared_alarms.add(outlet_num)
                st["had_load"] = False
                st["alarm"] = False
                if current_a is not None:
                    st["last_a"] = current_a
                continue

            amps = current_a if current_a is not None else st.get("last_a", 0.0)
            if current_a is not None:
                st["last_a"] = current_a

            if amps >= LOAD_PRESENT_A:
                st["had_load"] = True
                if prev_alarm:
                    cleared_alarms.add(outlet_num)
                st["alarm"] = False
                continue

            if st.get("had_load") and amps < LOAD_LOST_A:
                st["alarm"] = True
                active_load_lost.add(outlet_num)
                if not prev_alarm:
                    new_alarms.add(outlet_num)
            else:
                if prev_alarm:
                    cleared_alarms.add(outlet_num)
                st["alarm"] = False

    flags = [f for f in _existing_flags(results) if not (f.get("param") or "").endswith("_load")]
    for outlet_num in sorted(active_load_lost):
        param = f"outlet{outlet_num}_load"
        outlet_code = _outlet_display_code(ip, outlet_num)
        custom_name = _outlet_name_from_results(results, outlet_num)
        detail = f"Cable disconnected — Outlet {outlet_code}"
        if custom_name:
            detail = f"{detail} ({custom_name})"
        flags.append({
            "param": param,
            "status": "Load Lost",
            "color": "red",
            "outlet_code": outlet_code,
            "outlet_num": outlet_num,
            "detail": detail,
        })
        results[f"alarm_{param}"] = {
            "name": f"alarm_{param}",
            "oid": f"outlet_load:{outlet_num}",
            "value": detail,
        }

    for key in list(results.keys()):
        if key.startswith("alarm_outlet") and key.endswith("_load"):
            on = key.replace("alarm_outlet", "").replace("_load", "")
            try:
                n = int(on)
            except ValueError:
                continue
            if n not in active_load_lost:
                del results[key]

    _set_flags(results, flags)

    if new_alarms:
        nums = ", ".join(str(n) for n in sorted(new_alarms))
        print(f"[outlet_load_monitor] {ip} load lost on outlet(s) {nums}")
        # Run inline so Telegram fires before the next poll overwrites state.
        _trigger_alarm_notifier(ip, new_alarms, results)
        return True
    return False


def outlets_for_fast_snmp_poll(ip: str, cache_results: Optional[Dict[str, Any]]) -> List[int]:
    """Outlet indices to refresh on the fast SNMP path (status + current only)."""
    watch: Set[int] = set()
    with _state_lock:
        for n, st in _outlet_state.get(ip, {}).items():
            if st.get("had_load") or st.get("alarm"):
                watch.add(n)

    if cache_results:
        for outlet_num, current_a, is_on in _iter_outlets(cache_results):
            if not is_on:
                continue
            amps = current_a if current_a is not None else 0.0
            if amps >= FAST_WATCH_PRESENT_A:
                watch.add(outlet_num)

    return sorted(watch)


def ips_for_fast_outlet_poll(cache: Dict[str, Dict[str, Any]]) -> List[str]:
    """PDUs that need 1–2s outlet-only polling (loaded or actively alarming)."""
    ips: Set[str] = set()

    with _state_lock:
        for ip, outlets in _outlet_state.items():
            for st in outlets.values():
                if st.get("had_load") or st.get("alarm"):
                    ips.add(ip)
                    break

    for ip, results in (cache or {}).items():
        if not results:
            continue
        for outlet_num, current_a, is_on in _iter_outlets(results):
            if not is_on:
                continue
            if current_a is not None and current_a >= FAST_WATCH_PRESENT_A:
                ips.add(ip)
                break
        flags = _existing_flags(results)
        if any((f.get("param") or "").endswith("_load") for f in flags):
            ips.add(ip)

    return sorted(ips)
