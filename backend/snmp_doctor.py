"""SNMPv3 probe used by the commissioning SNMP doctor.

Runs net-snmp ``snmpget`` with the same USM parameters a customer NMS uses,
so a pass here means the agent, user, SHA key and AES key are all correct.
When PDUMIND_PDU_VIA is set (Mac + USB Ethernet), UDP is relayed through
backend/pdu_tcp_bridge.py because Docker Desktop cannot reach the dongle.
"""
from __future__ import annotations

import os
import socket
import struct
import subprocess
import threading
from typing import Any, Dict, List, Optional
from urllib.parse import quote, quote_plus

import pdu_via_host

SYS_NAME = "1.3.6.1.2.1.1.5.0"
SYS_DESCR = "1.3.6.1.2.1.1.1.0"
PDU_ENTERPRISE = "1.3.6.1.4.1.23273"

CAUSES = {
    "ok": "SNMPv3 answers with the expected user, SHA key and AES key",
    "timeout": "No SNMP reply — SNMP agent off, SNMPv3 disabled, or UDP 161 blocked",
    "unknown_user": "PDU does not know this SNMPv3 user name",
    "auth": "SHA authentication key does not match the PDU",
    "priv": "AES privacy key does not match the PDU",
    "level": "PDU user is not set to authPriv (SHA + AES)",
    "engine": "SNMPv3 engine discovery failed",
    "time_window": "SNMPv3 time window mismatch (retry usually clears it)",
    "no_data": "SNMP answers but the PDU telemetry tree is empty",
    "error": "snmpget failed",
}


def _bridge_wanted(host: str) -> bool:
    return bool(pdu_via_host._VIA) and host.startswith(pdu_via_host._PREFIXES)


class _BridgeUdp:
    """Local UDP port that relays datagrams to host:port through the Mac bridge."""

    def __init__(self, host: str, port: int = 161):
        proxy_host, proxy_port = pdu_via_host._via_endpoint()
        self.tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.tcp.settimeout(6)
        pdu_via_host._RAW_CONNECT(self.tcp, (proxy_host, proxy_port))
        self.tcp.sendall(f"UDP {host}:{int(port)}\n".encode())
        line = b""
        while not line.endswith(b"\n") and len(line) < 16:
            ch = self.tcp.recv(1)
            if not ch:
                break
            line += ch
        if not line.startswith(b"OK"):
            self.tcp.close()
            raise OSError(f"PDU bridge has no UDP relay to {host}:{port} — restart pdu_tcp_bridge.py")
        self.tcp.settimeout(None)
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.bind(("127.0.0.1", 0))
        self.udp.settimeout(0.5)
        self.port = self.udp.getsockname()[1]
        self._peer = None
        self._stop = False
        threading.Thread(target=self._up, daemon=True).start()
        threading.Thread(target=self._down, daemon=True).start()

    def _up(self):
        while not self._stop:
            try:
                data, peer = self.udp.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            self._peer = peer
            try:
                self.tcp.sendall(struct.pack("!H", len(data)) + data)
            except OSError:
                break

    def _read_exact(self, n: int) -> Optional[bytes]:
        buf = b""
        while len(buf) < n:
            chunk = self.tcp.recv(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    def _down(self):
        while not self._stop:
            try:
                head = self._read_exact(2)
                if head is None:
                    break
                data = self._read_exact(struct.unpack("!H", head)[0])
                if data is None:
                    break
            except OSError:
                break
            if self._peer:
                try:
                    self.udp.sendto(data, self._peer)
                except OSError:
                    break

    def close(self):
        self._stop = True
        for s in (self.tcp, self.udp):
            try:
                s.close()
            except OSError:
                pass


def classify(stderr: str, stdout: str, rc: int) -> str:
    text = f"{stderr}\n{stdout}".lower()
    if rc == 0 and stdout.strip() and "no such" not in text:
        return "ok"
    if "timeout" in text or "no response" in text:
        return "timeout"
    if "unknown user" in text:
        return "unknown_user"
    if "authentication failure" in text or "wrong digest" in text:
        return "auth"
    if "decryption" in text:
        return "priv"
    if "unsupported security level" in text:
        return "level"
    if "not in time window" in text:
        return "time_window"
    if "unknown engine" in text:
        return "engine"
    return "error"


def _snmp_cmd(tool: str, target: str, oid: str, user: str, auth: str, priv: str,
              auth_proto: str, priv_proto: str, timeout: float, retries: int,
              out_flags: str = "-Oqv") -> List[str]:
    return [
        tool, "-v3", "-l", "authPriv", "-u", user,
        "-a", auth_proto, "-A", auth, "-x", priv_proto, "-X", priv,
        "-t", str(timeout), "-r", str(retries), out_flags, target, oid,
    ]


def probe(host: str, user: str, auth_key: str, priv_key: str, *,
          auth_proto: str = "SHA", priv_proto: str = "AES",
          timeout: float = 2.0, retries: int = 1, oid: str = SYS_NAME,
          walk_enterprise: bool = False, port: int = 161) -> Dict[str, Any]:
    """One SNMPv3 authPriv GET. Never returns the keys."""
    if not (user and auth_key and priv_key):
        return {"ok": False, "kind": "error", "detail": "SNMPv3 user/keys missing from the hall configuration"}
    relay = None
    try:
        if _bridge_wanted(host):
            relay = _BridgeUdp(host, port)
            target = f"udp:127.0.0.1:{relay.port}"
        else:
            target = f"udp:{host}:{port}"
        budget = timeout * (retries + 1) + 3
        res = subprocess.run(
            _snmp_cmd("snmpget", target, oid, user, auth_key, priv_key,
                      auth_proto, priv_proto, timeout, retries),
            capture_output=True, text=True, timeout=budget,
        )
        kind = classify(res.stderr, res.stdout, res.returncode)
        out: Dict[str, Any] = {
            "ok": kind == "ok",
            "kind": kind,
            "value": res.stdout.strip().strip('"')[:120] if kind == "ok" else "",
            "detail": CAUSES.get(kind, "") if kind != "error" else (res.stderr.strip()[:200] or CAUSES["error"]),
        }
        if kind == "ok" and walk_enterprise:
            nxt = subprocess.run(
                _snmp_cmd("snmpgetnext", target, PDU_ENTERPRISE, user, auth_key, priv_key,
                          auth_proto, priv_proto, timeout, retries, out_flags="-Onq"),
                capture_output=True, text=True, timeout=budget,
            )
            line = nxt.stdout.strip()
            has_data = nxt.returncode == 0 and line.startswith(".1.3.6.1.4.1.")
            out["telemetry"] = has_data
            if not has_data:
                out.update(ok=False, kind="no_data", detail=CAUSES["no_data"])
        return out
    except subprocess.TimeoutExpired:
        return {"ok": False, "kind": "timeout", "detail": CAUSES["timeout"]}
    except FileNotFoundError:
        return {"ok": False, "kind": "error", "detail": "snmpget is not installed in the backend"}
    except OSError as exc:
        return {"ok": False, "kind": "error", "detail": str(exc)}
    finally:
        if relay:
            relay.close()


def key_variants(key: str) -> Dict[str, str]:
    """Forms a firmware may have stored instead of the typed key."""
    out: Dict[str, str] = {}
    for name, val in (
        ("url-encoded", quote(key, safe="")),
        ("form-encoded", quote_plus(key)),
    ):
        if val != key:
            out[name] = val
    for i, ch in enumerate(key):
        if not ch.isalnum():
            if i >= 8:
                out[f"cut at '{ch}'"] = key[:i]
            break
    for n in (16, 20, 24, 31, 32):
        if len(key) > n:
            out[f"first {n} chars"] = key[:n]
    return out


def find_stored_key(host: str, user: str, auth_key: str, priv_key: str, which: str) -> Optional[str]:
    """When the PDU rejects a key, try what a buggy form handler might have saved."""
    base = auth_key if which == "auth" else priv_key
    for name, cand in key_variants(base).items():
        a, p = (cand, priv_key) if which == "auth" else (auth_key, cand)
        r = probe(host, user, a, p, timeout=1.5, retries=0)
        if r["ok"]:
            return name
    return None
