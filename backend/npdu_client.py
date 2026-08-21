"""NPDU web client — driver for the "NPDU" PDU firmware family.

This firmware (login page title "NPDU", branded "PDUMIND", enterprise MIB
23273 / npdu-n-v2-bu.MIB) exposes a plain query-string CGI API — no HMAC, no
login.cgi. Discovered endpoints (all GET, responses are ``?``-delimited):

  /login?a=<user>&b=<pass>&     -> "OK" (admin) | "OK1" (read-only) | other
  /getnet                       -> mode?ip?mask?gw?dns?httpport?hmode?...
  /setnet?a=mode&b=ip&c=mask&d=gw&e=dns&        -> "OK"  (needs restart)
  /sethttp?a=port&b=hmode&c=loginmode&d=loginout&
  /updata                       -> updmode?MAC?execboard?ulen
  /getstatus?a=<slave>&         -> phase?cur..?vol..?pwr..?energy..?pf..?temp..
  /getoutput?a=<slave>&         -> count?name?state?..(switched outlets)
  /setcontrol?a=outlet&b=action&=slave&         (0 off, 1 on, 2 reboot)
  /getdevice / /setdev1?a=name& (device name)   /setdev4 (phase thresholds)
  /getsensor / /setdev5         (sensor thresholds)
  /getsnmp / /setsnmp           /getsmtp /gettime /settime
  /getuser?a=mode& / /setuser   /getlog /getalarm  /setsys?a=0& (restart)

`NPDUWebClient` mirrors the method surface and return shapes of
``pdu_web_client.PDUWebClient`` so the existing telemetry poller, PDU Settings
panel and batch/guided commissioning all work transparently on NPDU hardware.
"""
from __future__ import annotations

import threading
import time as _time
from typing import Any, Dict, List, Optional

import requests

_TIMEOUT = 8


def _base(ip: str, port: int = 80) -> str:
    return f"http://{ip}:{int(port or 80)}"


def _looks_like_npdu(html: str) -> bool:
    """NPDU's login page drives auth via my.js `ajaxget(.,"/login?a=" ...)`.

    That `/login?a=` marker (and the `<title>NPDU`) is unique to this firmware;
    the IPDU family posts to login.cgi instead, so this won't false-positive.
    """
    h = (html or "").lower()
    return ('/login?a=' in h) or ('<title>npdu' in h)


def _split(text: str) -> List[str]:
    return (text or "").split("?")


def _num(parts: List[str], i: int, scale: float = 1.0, nd: int = 2) -> str:
    """Scaled numeric field as a human string (matches IPDU decimal output)."""
    try:
        v = float(parts[i]) / scale
    except (IndexError, ValueError):
        return "0"
    s = f"{v:.{nd}f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


def _at(parts: List[str], i: int) -> str:
    return parts[i].strip() if i < len(parts) else ""


_NAME_FILLER = {"PDU", "PDUS", "RACK", "CABINET", "CAB", "RK", "ROW"}


def short_device_name(hostname: str, max_len: int = 15) -> str:
    """Derive a <=max_len unique device name from a long hostname.

    NPDU's name field is ~15 chars. We strip generic tokens (PDU/RACK/...) and
    keep the most-unique tail (site + rack + index), e.g.
    'RDC1-PDU-RACK-CN09-1' -> 'RDC1-CN09-1', falling back to 'CN09-1'.
    """
    h = (hostname or "").strip()
    if len(h) <= max_len:
        return h
    tokens = [t for t in h.split("-") if t]
    kept = [t for t in tokens if t.upper() not in _NAME_FILLER] or tokens
    # Prefer the full filtered name; otherwise drop leading tokens (keep the tail).
    for start in range(len(kept)):
        cand = "-".join(kept[start:])
        if len(cand) <= max_len:
            return cand
    return (kept[-1] if kept else h)[-max_len:]


# ---------------------------------------------------------------------------
# Stateless helpers used by the guided-commission routes (validated live).
# ---------------------------------------------------------------------------

def detect(ip: str, *, port: int = 80, username: str = "admin",
           password: str = "admin") -> Dict[str, Any]:
    """Probe an IP for NPDU firmware and read identity + current network."""
    out: Dict[str, Any] = {"found": False, "is_npdu": False, "login_ok": False, "ip": ip}
    sess = requests.Session()
    base = _base(ip, port)
    try:
        root = sess.get(f"{base}/", timeout=_TIMEOUT)
    except requests.RequestException as e:
        out["error"] = f"Not reachable on {base}: {e}"
        return out

    out["found"] = True
    out["is_npdu"] = _looks_like_npdu(root.text)
    if not out["is_npdu"]:
        out["error"] = "Web server reachable but not NPDU firmware"
        return out

    try:
        r = sess.get(f"{base}/login", params={"a": username, "b": password, "": ""}, timeout=_TIMEOUT)
        body = (r.text or "").strip()
        out["login_ok"] = body in ("OK", "OK1")
        out["login_role"] = "admin" if body == "OK" else ("readonly" if body == "OK1" else "denied")
        if not out["login_ok"]:
            out["error"] = f"Login rejected for {username!r} (device said {body!r})"
            return out
    except requests.RequestException as e:
        out["error"] = f"Login request failed: {e}"
        return out

    net = _split(sess.get(f"{base}/getnet", timeout=_TIMEOUT).text)
    info = _split(sess.get(f"{base}/updata", timeout=_TIMEOUT).text)
    out.update({
        "current_ip": _at(net, 1), "mask": _at(net, 2), "gateway": _at(net, 3),
        "dns": _at(net, 4), "http_port": _at(net, 5) or port, "mode": _at(net, 0),
        "mac": _at(info, 1), "firmware": _at(info, 2),
    })
    return out


def commission(ip: str, *, new_ip: str, mask: str, gateway: str, dns: str = "",
               hostname: str = "", username: str = "admin", password: str = "admin",
               port: int = 80, do_reboot: bool = True) -> Dict[str, Any]:
    """Full guided step: login → set device name → set static IPv4 → reboot."""
    client = NPDUWebClient(ip, port, username, password)
    if not client.login():
        return {"success": False, "error": f"NPDU login failed for {username!r} at {ip}"}

    cur = client.get_network_config()
    info = client.get_device_info()
    name_ok = True
    if hostname:
        try:
            name_ok = client.set_system_config(device_name=hostname)
        except Exception:
            name_ok = False

    res = client.set_ipv4(new_ip, mask, gateway, dns or cur.get("current_dns1", ""))
    if not res:
        return {"success": False, "error": "setnet rejected by device",
                "previous_ip": cur.get("current_ip"), "mac": info.get("mac")}

    rebooted = client.reboot() if do_reboot else False
    return {
        "success": True, "mac": info.get("mac"),
        "previous_ip": cur.get("current_ip"), "new_ip": new_ip,
        "hostname_set": name_ok, "rebooted": rebooted, "firmware": info.get("firmware"),
    }


# ---------------------------------------------------------------------------
# Stateful client mirroring PDUWebClient's interface.
# ---------------------------------------------------------------------------

class NPDUWebClient:
    """Stateful client for a single NPDU's query-string CGI interface."""

    def __init__(self, host: str, port: int = 80, username: str = "admin",
                 password: str = "admin", timeout: int = _TIMEOUT, use_https: bool = False):
        self.host = host
        self.port = int(port or 80)
        self.use_https = False  # NPDU firmware is HTTP-only
        self.base_url = _base(host, self.port)
        self.username = username
        self.password = password
        self.timeout = timeout
        self.firmware_family = "npdu"
        self._session = requests.Session()
        self._logged_in = False
        self._login_time = 0.0
        self._session_ttl = 20
        self._lock = threading.RLock()
        self.last_login_error: Optional[str] = None

    # -- auth ------------------------------------------------------------
    def login(self) -> bool:
        with self._lock:
            try:
                r = self._session.get(
                    f"{self.base_url}/login",
                    params={"a": self.username, "b": self.password, "": ""},
                    timeout=self.timeout,
                )
            except requests.RequestException as e:
                self.last_login_error = f"Unreachable: {e}"
                self._logged_in = False
                return False
            body = (r.text or "").strip()
            if body in ("OK", "OK1"):
                self._logged_in = True
                self._login_time = _time.time()
                self.last_login_error = None
                return True
            self.last_login_error = f"HTTP {r.status_code}, body[:80]={body[:80]!r}"
            self._logged_in = False
            return False

    def logout(self) -> None:
        with self._lock:
            try:
                self._session.close()
            except Exception:
                pass
            self._session = requests.Session()
            self._logged_in = False

    def _ensure_session(self) -> None:
        if not self._logged_in or (_time.time() - self._login_time > self._session_ttl):
            for attempt in range(5):
                if self.login():
                    return
                _time.sleep(0.6 * (attempt + 1))
            raise ConnectionError(
                f"NPDU login failed after 5 retries ({self.base_url}, user={self.username})"
            )

    def _get(self, path: str, **params) -> List[str]:
        with self._lock:
            self._ensure_session()
            r = self._session.get(f"{self.base_url}/{path}", params=params or None, timeout=self.timeout)
            r.raise_for_status()
            self._login_time = _time.time()
            return _split(r.text)

    def _cmd(self, path: str, **params) -> str:
        with self._lock:
            self._ensure_session()
            r = self._session.get(f"{self.base_url}/{path}", params=params or None, timeout=self.timeout)
            r.raise_for_status()
            self._login_time = _time.time()
            return (r.text or "").strip()

    # -- reboot ----------------------------------------------------------
    def reboot(self) -> bool:
        with self._lock:
            try:
                if not self._logged_in:
                    self._ensure_session()
                r = self._session.get(f"{self.base_url}/setsys", params={"a": "0", "": ""}, timeout=self.timeout)
                self._logged_in = False
                return (r.text or "").strip() == "OK" or r.status_code == 200
            except requests.RequestException:
                self._logged_in = False
                return True  # connection dropped == device rebooting

    def wait_online(self, timeout: int = 90, poll_interval: int = 5) -> bool:
        deadline = _time.time() + timeout
        self._logged_in = False
        while _time.time() < deadline:
            try:
                if self.login():
                    return True
            except Exception:
                pass
            _time.sleep(poll_interval)
        return False

    # -- device / network ------------------------------------------------
    def get_device_info(self) -> Dict[str, Any]:
        net = self._get("getnet")
        info = self._get("updata")
        dev = self._get("getdevice")
        return {
            "name": _at(dev, 21) or "NPDU",
            "firmware": _at(info, 2),
            "mac": _at(info, 1),
            "ip": _at(net, 1),
            "mask": _at(net, 2),
            "gateway": _at(net, 3),
        }

    def get_network_config(self) -> Dict[str, Any]:
        f = self._get("getnet")
        # 0?ip?mask?gw?dns?httpport?hmode?modev6?ipv6?local?router?dnsv6?prefix?...
        mode = _at(f, 0)
        return {
            "mac": _at(self._get("updata"), 1),
            "current_ip": _at(f, 1),
            "current_mask": _at(f, 2),
            "current_gateway": _at(f, 3),
            "current_dns1": _at(f, 4),
            "current_dns2": "",
            "current_ipv6": _at(f, 8),
            "current_ipv6_prefix": _at(f, 12),
            "current_ipv6_global": _at(f, 8),
            "current_ipv6_router": _at(f, 10),
            "current_ipv6_dns1": _at(f, 11),
            "current_ipv6_dns2": "",
            "dhcp": "ON" if mode == "1" else "OFF",
            "dhcp_value": mode,
            "set_ip": _at(f, 1),
            "set_mask": _at(f, 2),
            "set_gateway": _at(f, 3),
            "set_dns1": _at(f, 4),
            "set_dns2": "",
            "http_port": _at(f, 5) or "80",
            "csrf_token": "",
        }

    def set_ipv4(self, ip: str, mask: str = "255.255.255.0", gateway: str = "",
                 dns1: str = "", dns2: str = "") -> bool:
        cur = self.get_network_config()
        resp = self._cmd("setnet", a="0", b=ip, c=mask,
                         d=gateway or cur["current_gateway"],
                         e=dns1 or cur["current_dns1"])
        return resp == "OK"

    def set_dhcp(self, enabled: bool) -> bool:
        cur = self.get_network_config()
        if not enabled:
            return True  # static IP is pushed by set_ipv4 (mode 0)
        resp = self._cmd("setnet", a="1", b=cur["current_ip"], c=cur["current_mask"],
                         d=cur["current_gateway"], e=cur["current_dns1"])
        return resp == "OK"

    # -- SNMP ------------------------------------------------------------
    def get_snmp_config(self) -> Dict[str, Any]:
        f = self._get("getsnmp")
        # Native snmp.html dropdown (exclusive):
        #   0 = Disable, 1 = SNMP V1/V2c, 2 = SNMP V3
        # mode?wcom?rcom?trap1?trap2?v3acc?v3pass?v3skey?logmode?
        mode = _at(f, 0)
        return {
            "snmpv1_enabled": mode == "1",
            "snmpv2_enabled": mode == "1",
            "snmpv3_enabled": mode == "2",
            "community_read": _at(f, 2),
            "community_write": _at(f, 1),
            "snmpv3_username": _at(f, 5),
            "verify_protocol": "",
            "auth_key": _at(f, 6),
            "encrypt_protocol": "",
            "priv_key": _at(f, 7),
            "trap_ip": _at(f, 3),
            "trap_ip2": _at(f, 4),
            "log_mode": _at(f, 8),
            "csrf_token": "",
        }

    def set_snmp(self, read_community: str | None = None, write_community: str | None = None,
                 snmpv1: bool | None = None, snmpv2: bool | None = None, snmpv3: bool | None = None,
                 snmpv3_username: str | None = None, verify_protocol: str | None = None,
                 auth_key: str | None = None, encrypt_protocol: str | None = None,
                 priv_key: str | None = None, trap_ip: str | None = None,
                 *, verify: bool = True) -> bool:
        cur = self.get_snmp_config()
        # Exclusive firmware modes: 0 disable, 1 V1/V2c, 2 V3 (not 3).
        if snmpv3:
            mode = "2"
        elif snmpv1 is False and snmpv2 is False and snmpv3 is False:
            mode = "0"
        elif snmpv1 or snmpv2:
            mode = "1"
        elif cur["snmpv3_enabled"]:
            mode = "2"
        elif cur["snmpv1_enabled"] or cur["snmpv2_enabled"]:
            mode = "1"
        else:
            mode = "0"
        resp = self._cmd(
            "setsnmp",
            a=mode,
            b=write_community if write_community is not None else cur["community_write"],
            c=read_community if read_community is not None else cur["community_read"],
            d=trap_ip if trap_ip is not None else cur["trap_ip"],
            e=cur["trap_ip2"],
            f=snmpv3_username if snmpv3_username is not None else cur["snmpv3_username"],
            g=auth_key if auth_key is not None else cur["auth_key"],
            h=priv_key if priv_key is not None else cur["priv_key"],
            i=cur["log_mode"] or "0",
        )
        return resp == "OK"

    @staticmethod
    def prepare_snmp_kwargs(snmp: Dict[str, Any]) -> Dict[str, Any]:
        if not snmp:
            return {}
        return {
            "read_community": snmp.get("read_community") or snmp.get("community_read"),
            "write_community": snmp.get("write_community") or snmp.get("community_write"),
            "snmpv1": bool(snmp.get("snmpv1", snmp.get("snmpv1_enabled", False))),
            "snmpv2": bool(snmp.get("snmpv2", snmp.get("snmpv2_enabled", True))),
            "snmpv3": bool(snmp.get("snmpv3", snmp.get("snmpv3_enabled", False))),
            "snmpv3_username": snmp.get("snmpv3_username"),
            "trap_ip": snmp.get("trap_ip", ""),
        }

    # -- time ------------------------------------------------------------
    def get_time_config(self) -> Dict[str, Any]:
        f = self._get("gettime")  # date?time?week?
        date = _at(f, 0)
        tm = _at(f, 1)
        y = m = d = hh = mm = ss = ""
        if "-" in date:
            try:
                y, m, d = date.split("-")[:3]
            except ValueError:
                pass
        if ":" in tm:
            try:
                hh, mm, ss = tm.split(":")[:3]
            except ValueError:
                pass
        return {
            "year": y, "month": m, "day": d, "hour": hh, "minute": mm, "second": ss,
            "sntp_enabled": "", "sntp_server": "", "sntp_server2": "", "sntp_server_raw": "",
            "timezone": "", "update_interval": "", "correction": "", "csrf_token": "",
        }

    def set_time(self, year=None, month=None, day=None, hour=None, minute=None,
                 second=None, sntp_enabled=None, sntp_server=None, timezone=None,
                 update_interval=None, correction=None) -> bool:
        cur = self.get_time_config()
        date = f"{year or cur['year']}-{(month or cur['month']):0>2}-{(day or cur['day']):0>2}"
        tm = f"{(hour or cur['hour']):0>2}:{(minute or cur['minute']):0>2}:{(second or cur['second']):0>2}"
        resp = self._cmd("settime", a=date, b=tm, **{"": ""})
        return resp == "OK"

    @staticmethod
    def prepare_time_kwargs(ntp: Dict[str, Any]) -> Dict[str, Any]:
        if not ntp:
            return {}
        allowed = {"year", "month", "day", "hour", "minute", "second"}
        return {k: v for k, v in ntp.items() if k in allowed}

    # -- live telemetry --------------------------------------------------
    def get_live_telemetry(self, slave: int = 0) -> Dict[str, Any]:
        f = self._get("getstatus", a=str(slave))
        # extra "" param appended by firmware; _get already split on '?'
        if not f:
            return {}
        try:
            phase = int(float(_at(f, 0) or "0"))
        except ValueError:
            phase = 0
        phase = max(1, min(phase, 3))
        result: Dict[str, Any] = {"_phase_count": str(phase)}

        total_p = total_e = 0.0
        pfs: List[float] = []
        for i in range(phase):
            cur = _num(f, 1 + i * 2, 100.0)       # A
            vol = _num(f, 7 + i * 2, 10.0)        # V
            pwr = _num(f, 13 + i, 10.0)           # W
            eng = _num(f, 16 + i, 10.0)           # kWh
            pf = _num(f, 19 + i, 100.0)
            n = i + 1
            result[f"l{n}_voltage"] = vol
            result[f"l{n}_current"] = cur
            result[f"l{n}_active_power"] = pwr
            result[f"l{n}_active_energy"] = eng
            result[f"l{n}_pf"] = pf
            result[f"l{n}_color"] = "red" if _at(f, 2 + i * 2) == "1" else "green"
            try:
                total_p += float(pwr)
                total_e += float(eng)
                if float(pf) > 0:
                    pfs.append(float(pf))
            except ValueError:
                pass

        result["total_active_power"] = f"{total_p:.1f}".rstrip("0").rstrip(".")
        result["total_active_energy"] = f"{total_e:.1f}".rstrip("0").rstrip(".")
        result["total_pf"] = f"{(sum(pfs) / len(pfs)):.2f}" if pfs else "0"
        result["neutral_current"] = _num(f, 42, 100.0)

        # Sensors: temp1-4 (gv[22+i*2]/10), hum1-4 (gv[30+i*2]/10)
        alarm_flags: List[Dict[str, str]] = []
        for i in range(4):
            t = _num(f, 22 + i * 2, 10.0, 1)
            h = _num(f, 30 + i * 2, 10.0, 1)
            result[f"temp{i + 1}"] = t
            result[f"hum{i + 1}"] = h
            if _at(f, 23 + i * 2) == "1":
                alarm_flags.append({"param": f"temp{i + 1}", "status": "Alarm", "color": "red"})
            if _at(f, 31 + i * 2) == "1":
                alarm_flags.append({"param": f"hum{i + 1}", "status": "Alarm", "color": "red"})

        # Phase voltage/current alarm flags
        for i in range(phase):
            if _at(f, 2 + i * 2) == "1":
                alarm_flags.append({"param": f"l{i + 1}_current", "status": "High", "color": "red"})
            if _at(f, 8 + i * 2) == "1":
                alarm_flags.append({"param": f"l{i + 1}_voltage", "status": "High", "color": "red"})

        # Door / smoke / water (2=normal, 1=alarm, 0=n/a)
        for i, name in enumerate(("door1", "door2")):
            if _at(f, 38 + i) == "1":
                alarm_flags.append({"param": name, "status": "Alarm", "color": "red"})
        if _at(f, 40) == "1":
            alarm_flags.append({"param": "smoke", "status": "Alarm", "color": "red"})
        if _at(f, 41) == "1":
            alarm_flags.append({"param": "water", "status": "Alarm", "color": "red"})

        result["alarm_flags"] = alarm_flags
        result["alarm_status"] = "Alarm" if alarm_flags else "Normal"
        result["alarm_color"] = "red" if alarm_flags else "green"

        # Switched-outlet states → per-outlet Output{N}Status/Current/Energy so the
        # dashboard Outlets panel shows on/off + current (panel divides energy /10).
        result["outlet_count"] = "0"
        try:
            outlets = self.get_outlets(slave)
            result["outlet_count"] = str(len(outlets))
            for o in outlets:
                n = o["index"]
                result[f"Output{n}Status"] = "on" if o["state"] == "on" else "off"
                result[f"Output{n}Current"] = o["current"]
                result[f"Output{n}Energy"] = o.get("energy", "0")
        except Exception as e:
            print(f"[npdu] {self.host} outlet read failed: {e}")
        result["breakers"] = []  # NPDU uses Output{N}* keys above, not breaker list
        result["datetime"] = self._safe_datetime()
        return result

    def list_chain_units(self) -> List[Dict[str, Any]]:
        """Probe getstatus a=0..3 on this master. Empty daisy slots read 0 V."""
        from npdu_chain import electrically_live

        units: List[Dict[str, Any]] = []
        for slave_index in range(4):
            tele = self.get_live_telemetry(slave_index)
            try:
                vol = float(tele.get("l1_voltage") or 0)
            except (TypeError, ValueError):
                vol = 0.0
            try:
                cur = float(tele.get("l1_current") or 0)
            except (TypeError, ValueError):
                cur = 0.0
            units.append({
                "slave_index": slave_index,
                "unit_index": slave_index + 1,
                "live": electrically_live(vol, cur),
                "voltage": vol,
                "current": cur,
            })
        return units

    def _safe_datetime(self) -> str:
        try:
            t = self._get("gettime")
            return f"{_at(t, 0)} {_at(t, 1)}"
        except Exception:
            return ""

    # -- outlet control (switched NPDU) ---------------------------------
    def get_outlets(self, slave: int = 0) -> List[Dict[str, Any]]:
        o = self._get("getoutput", a=str(slave))
        try:
            count = int(o[0])
        except (IndexError, ValueError):
            return []
        outlets: List[Dict[str, Any]] = []
        idx = 1
        for n in range(count):
            outlets.append({
                "index": n + 1,
                "name": _at(o, idx),
                "state": "on" if _at(o, idx + 1) == "2" else "off",
                "current": _num(o, idx + 2, 100.0),
                "power": _num(o, idx + 4, 10.0),
            })
            idx += 7
        return outlets

    def set_outlet(self, outlet: int, action: str, slave: int = 0) -> bool:
        # NPDU setcontrol: 1=off, 2=on, 3=reboot (matches getoutput state where 2=on)
        code = {"off": "1", "on": "2", "reboot": "3"}.get(str(action).lower(), str(action))
        resp = self._cmd("setcontrol", a=str(outlet), b=code, **{"": str(slave)})
        return resp == "OK"

    # -- logs ------------------------------------------------------------
    def get_logs(self) -> List[Dict[str, str]]:
        f = self._get("getlog")
        # 10 timestamps (date/time), 10 categories, 10 users, then page index.
        logs: List[Dict[str, str]] = []
        for i in range(10):
            stamp = _at(f, i)
            if not stamp:
                continue
            date, _, tm = stamp.partition("/")
            logs.append({
                "date": date, "time": tm,
                "category": _at(f, 10 + i), "color": "white",
                "event": _at(f, 20 + i),
            })
        return logs

    def get_alarms(self) -> List[Dict[str, str]]:
        f = self._get("getalarm")
        alarms: List[Dict[str, str]] = []
        for i in range(10):
            stamp = _at(f, i)
            if not stamp:
                continue
            date, _, tm = stamp.partition("/")
            alarms.append({"date": date, "time": tm, "event": _at(f, 20 + i), "color": "red"})
        return alarms

    # -- thresholds ------------------------------------------------------
    def get_alarm_thresholds(self) -> Dict[str, Any]:
        f = self._get("getdevice")
        s = self._get("getsensor")

        def dev(i: int, scale: float) -> str:
            return _num(f, i, scale, 1)

        def sen(i: int, scale: float) -> str:
            return _num(s, i, scale, 0)

        # getdevice: cur0?cmin0?cmax0?cur1?cmin1?cmax1?cur2?cmin2?cmax2?
        #            v?vmin0?vmax0?...?name(21)?up?down?slave?...
        result: Dict[str, Any] = {"raw_fields": len(f), "beep_alarm": "0"}
        result["l1_current_upper"] = dev(2, 10.0)
        result["l1_current_lower"] = dev(1, 10.0)
        result["l2_current_upper"] = dev(5, 10.0)
        result["l2_current_lower"] = dev(4, 10.0)
        result["l3_current_upper"] = dev(8, 10.0)
        result["l3_current_lower"] = dev(7, 10.0)
        result["l1_voltage_upper"] = dev(11, 10.0)
        result["l1_voltage_lower"] = dev(10, 10.0)
        result["l2_voltage_upper"] = dev(14, 10.0)
        result["l2_voltage_lower"] = dev(13, 10.0)
        result["l3_voltage_upper"] = dev(17, 10.0)
        result["l3_voltage_lower"] = dev(16, 10.0)
        result["neutral_line"] = dev(28, 10.0)
        result["phase_unbalance"] = "0"
        # getsensor: t0?tmin0?tmax0?t1?...(temps)... then hums
        # getsensor: val?min?max per sensor — 4 temps (degC) then 4 hums (%RH),
        # stored as whole integers (observed maxima 40 / 99).
        for i in range(4):
            result[f"temp{i + 1}_lower"] = sen(1 + i * 3, 1.0)
            result[f"temp{i + 1}_upper"] = sen(2 + i * 3, 1.0)
        for i in range(4):
            base = 12 + i * 3
            result[f"hum{i + 1}_lower"] = sen(base + 1, 1.0)
            result[f"hum{i + 1}_upper"] = sen(base + 2, 1.0)
        result["rated_current"] = ""
        result["csrf_token"] = ""
        return result

    def set_alarm_thresholds(self, **kwargs) -> bool:
        """Push phase current/voltage thresholds via /setdev4 (order code per param)."""
        cur = self.get_alarm_thresholds()

        def v(key: str) -> float:
            try:
                return float(kwargs.get(key, cur.get(key, 0)))
            except (TypeError, ValueError):
                return 0.0

        ok = True
        # /setdev4?a=order&b=min*10&c=max*10  (1-3 current, 4-6 voltage)
        plan = [
            (1, "l1_current_lower", "l1_current_upper"),
            (2, "l2_current_lower", "l2_current_upper"),
            (3, "l3_current_lower", "l3_current_upper"),
            (4, "l1_voltage_lower", "l1_voltage_upper"),
            (5, "l2_voltage_lower", "l2_voltage_upper"),
            (6, "l3_voltage_lower", "l3_voltage_upper"),
        ]
        for order, lo, hi in plan:
            if lo in kwargs or hi in kwargs:
                resp = self._cmd("setdev4", a=str(order),
                                 b=str(int(v(lo) * 10)), c=str(int(v(hi) * 10)))
                ok = ok and (resp == "OK")
        return ok

    # -- system / device name -------------------------------------------
    def get_system_config(self) -> Dict[str, Any]:
        f = self._get("getdevice")
        name = _at(f, 21)
        return {
            "device_name": name,
            "lcd_title": name,
            "display_direction": "0",
            "lcd_backlight_mode": "0",
            "lcd_backlight_time": "3",
            "lcd_rest_brightness": "0",
            "logout_enabled": "1",
            "logout_time": "3",
            "web_title_enabled": "0",
            "router_hostname": name,
            "csrf_token": "",
        }

    # NPDU stores the device name in a fixed 16-byte buffer with no trailing
    # null when full, so anything >15 chars reads back as garbage. Cap at 15.
    DEVICE_NAME_MAX = 15

    def set_system_config(self, device_name: str | None = None, router_hostname: str | None = None,
                          **_ignored) -> bool:
        name = (device_name or router_hostname or "").strip()
        if not name:
            return True  # blank = keep current device name (no write)
        safe = short_device_name(name, self.DEVICE_NAME_MAX)
        if safe != name:
            print(f"[npdu] {self.host} device name {name!r} -> {safe!r} (15-char limit)")
        resp = self._cmd("setdev1", a=safe)
        return resp == "OK"

    # -- users -----------------------------------------------------------
    def get_users(self) -> Dict[str, Any]:
        f = self._get("getuser", a="0")  # mode?adminname?
        return {
            "admin_username": _at(f, 1) or "admin",
            "admin_password_masked": "****",
            "user1_username": "", "user1_password_masked": "",
            "user2_username": "", "user2_password_masked": "",
            "csrf_token": "",
        }

    def set_users(self, admin_username: str | None = None, admin_password: str | None = None,
                  user1_username=None, user1_password=None, user2_username=None,
                  user2_password=None) -> bool:
        cur = self.get_users()
        # /setuser?a=mode&b=adminname&c=oldpass&d=newpass&
        resp = self._cmd("setuser", a="0",
                         b=admin_username or cur["admin_username"],
                         c=self.password,
                         d=admin_password or "")
        if resp != "OK":
            return False
        if admin_password:
            self.password = admin_password
        return True

    # -- web access ------------------------------------------------------
    def get_web_access_config(self) -> Dict[str, Any]:
        f = self._get("getnet")
        return {
            "https_http": "0",  # NPDU is HTTP-only
            "http_port": _at(f, 5) or "80",
            "https_port": "443",
            "default_cert": "", "user_cert": "", "csrf_token": "",
        }

    def set_web_access(self, https_http=None, http_port=None, https_port=None) -> bool:
        f = self._get("getnet")
        port = http_port or _at(f, 5) or "80"
        # /sethttp?a=port&b=hmode&c=loginmode&d=loginout&
        resp = self._cmd("sethttp", a=str(port), b=_at(f, 6) or "0",
                         c=_at(f, 13) or "0", d=_at(f, 14) or "10")
        return resp == "OK"

    # -- batch -----------------------------------------------------------
    def apply_batch_template(self, template: Dict[str, Any], *, reboot_after: bool = False) -> Dict[str, Any]:
        with self._lock:
            prev = self._session_ttl
            self._session_ttl = 300
            try:
                report = self._apply_batch_template_body(template)
                if reboot_after:
                    report["_reboot"] = {"success": self.reboot()}
                return report
            finally:
                self._session_ttl = prev

    def _apply_batch_template_body(self, template: Dict[str, Any]) -> Dict[str, Any]:
        report: Dict[str, Any] = {}

        sys_cfg = template.get("system") or {}
        if sys_cfg:
            try:
                report["system"] = {"success": self.set_system_config(**sys_cfg)}
            except Exception as e:
                report["system"] = {"success": False, "error": str(e)}

        net = template.get("network") or {}
        if net:
            try:
                ok = self.set_ipv4(
                    ip=net.get("ip", ""), mask=net.get("mask", "255.255.255.0"),
                    gateway=net.get("gateway", ""), dns1=net.get("dns1", ""),
                )
                report["network"] = {"success": ok}
            except Exception as e:
                report["network"] = {"success": False, "error": str(e)}

        snmp = template.get("snmp") or {}
        if snmp:
            try:
                report["snmp"] = {"success": self.set_snmp(**self.prepare_snmp_kwargs(snmp))}
            except Exception as e:
                report["snmp"] = {"success": False, "error": str(e)}

        users = template.get("users") or {}
        if (users.get("admin_password") or users.get("admin_username") or "").strip():
            try:
                report["users"] = {"success": self.set_users(
                    admin_username=(users.get("admin_username") or "").strip() or None,
                    admin_password=(users.get("admin_password") or "").strip() or None,
                )}
            except Exception as e:
                report["users"] = {"success": False, "error": str(e)}

        ntp = template.get("ntp") or {}
        if ntp:
            try:
                report["ntp"] = {"success": self.set_time(**self.prepare_time_kwargs(ntp))}
            except Exception as e:
                report["ntp"] = {"success": False, "error": str(e)}

        return report

    def get_all_settings(self) -> Dict[str, Any]:
        with self._lock:
            prev = self._session_ttl
            self._session_ttl = 120
            try:
                return {
                    "device": self.get_device_info(),
                    "network": self.get_network_config(),
                    "snmp": self.get_snmp_config(),
                    "time": self.get_time_config(),
                    "web_access": self.get_web_access_config(),
                    "alarm_thresholds": self.get_alarm_thresholds(),
                    "system": self.get_system_config(),
                    "users": self.get_users(),
                }
            finally:
                self._session_ttl = prev


def is_npdu_host(ip: str, port: int = 80, timeout: int = 4) -> bool:
    """Cheap one-shot check: is the web server at ip:port the NPDU firmware?"""
    try:
        r = requests.get(_base(ip, port) + "/", timeout=timeout)
        return _looks_like_npdu(r.text)
    except requests.RequestException:
        return False
