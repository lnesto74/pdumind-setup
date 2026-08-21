"""Daisy-chain topology helpers for NPDU master/slave fleets.

Physical model (validated on live hardware):

* Every PDU is a standalone device with its own IP and hostname.
* Slaves are NOT individually reachable on the network — they sit behind the
  chain master's single uplink. Their telemetry/outlets are read THROUGH the
  master's web CGI using a slave index:
      /getstatus?a=<idx>   /getoutput?a=<idx>   /setcontrol?a=out&b=act&=<idx>
* Config writes (name/IP/SNMP/thresholds) have NO per-slave CGI selector —
  they are master-only. SNMP for the whole chain is written on the master;
  slave OIDs (enterprise.23273.3.2 / .3.3 / .3.4) share that agent. Batch
  commission still registers each slave in PDUMind and pushes SNMP via the
  master so hall records stay in sync.

Naming convention: within a ``<stem>-<N>`` group, ``-1`` is the master
(slave index 0) and ``-2`` / ``-3`` / ``-4`` are slaves (indices 1 / 2 / 3)
of that master, e.g. ``RDC1-PDU-RACK-CN09-3`` is slave index 2 of
``RDC1-PDU-RACK-CN09-1``.
"""
from __future__ import annotations

import re
from typing import Optional, Tuple

# Trailing "-<digits>" group (the chain position). The stem captures everything
# before it so we can locate the "-1" master sibling.
_SUFFIX_RE = re.compile(r"^(?P<stem>.+)-(?P<idx>\d+)$")


def parse_suffix(hostname: Optional[str]) -> Optional[Tuple[str, int]]:
    """('RDC1-PDU-RACK-CN09-3') -> ('RDC1-PDU-RACK-CN09', 3); None if no -N tail."""
    if not hostname:
        return None
    m = _SUFFIX_RE.match(str(hostname).strip())
    if not m:
        return None
    try:
        return m.group("stem"), int(m.group("idx"))
    except ValueError:
        return None


def slave_index_for(hostname: Optional[str]) -> Optional[int]:
    """Device slave index (the CGI ``a=`` param) for a chain hostname.

    ``-1`` -> 0 (master), ``-2`` -> 1, ``-3`` -> 2, ``-4`` -> 3.
    Returns ``None`` when the hostname is not a chain member name.
    """
    parsed = parse_suffix(hostname)
    if not parsed:
        return None
    _stem, idx = parsed
    if idx < 1:
        return None
    return idx - 1


def master_hostname_for(hostname: Optional[str]) -> Optional[str]:
    """Return the ``-1`` master hostname for a chain member, else None."""
    parsed = parse_suffix(hostname)
    if not parsed:
        return None
    stem, _idx = parsed
    return f"{stem}-1"


def electrically_live(voltage: Optional[float], current: Optional[float] = None) -> bool:
    """True when a chain slot is a real unit (not an empty daisy index)."""
    try:
        if voltage is not None and float(voltage) > 50:
            return True
    except (TypeError, ValueError):
        pass
    try:
        if current is not None and float(current) > 0.05:
            return True
    except (TypeError, ValueError):
        pass
    return False


def infer_unit_ip(master_ip: str, unit_index: int) -> Optional[str]:
    """Inventory IP for chain unit N (1 = master, 2 = first slave, …).

    NTT-style packing: master ``.20`` → ``.21`` / ``.22`` / ``.23`` for -2/-3/-4.
    """
    try:
        parts = str(master_ip).strip().split(".")
        if len(parts) != 4:
            return None
        last = int(parts[3]) + int(unit_index) - 1
        if last < 0 or last > 255:
            return None
        return ".".join(parts[:3] + [str(last)])
    except (TypeError, ValueError):
        return None


def stem_from_name(name: Optional[str]) -> Optional[str]:
    parsed = parse_suffix(name)
    return parsed[0] if parsed else None


def hostname_for_unit(stem: Optional[str], unit_index: int) -> Optional[str]:
    if not stem or int(unit_index) < 1:
        return None
    return f"{stem}-{int(unit_index)}"


def fallback_stem(master_ip: str) -> str:
    """When the device name has no ``-N`` suffix (factory ``PDUMIND``)."""
    last = str(master_ip).rsplit(".", 1)[-1]
    return f"NPDU-{last}"


def snmp_voltage_oid(unit_index: int) -> str:
    """P1 voltage for chain unit 1–4 on the master's SNMP agent."""
    return f".1.3.6.1.4.1.23273.3.{int(unit_index)}.1.2.1.0"


def snmp_current_oid(unit_index: int) -> str:
    return f".1.3.6.1.4.1.23273.3.{int(unit_index)}.1.2.2.0"
