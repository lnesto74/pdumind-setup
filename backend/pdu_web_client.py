"""PDU Web Admin Client — reverse-engineered CGI interface.

Authenticates via HMAC-SHA1, reads/writes network, SNMP and time settings,
polls live 3-phase telemetry, and retrieves event logs from PDUs that expose
the standard CGI web panel (e.g. IPDUv1H firmware family).
"""
from __future__ import annotations

import hashlib
import hmac
import random
import re
import ssl
import time as _time
import threading
from typing import Any, Dict, List, Optional

import requests
from requests.adapters import HTTPAdapter

try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass

_NONCE_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"

# Embedded PDU HTTPS stacks often need OpenSSL "unsafe legacy renegotiation"
# (disabled by default in OpenSSL 3 / Python 3.11+). Browsers still allow it.
_LEGACY_RENEGOTIATION = getattr(ssl, "OP_LEGACY_SERVER_CONNECT", 0x4)


def pdu_ssl_context() -> ssl.SSLContext:
    """SSL context for legacy PDU web-admin HTTPS (self-signed + legacy renegotiation)."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    ctx.options |= _LEGACY_RENEGOTIATION
    return ctx


class _PduHttpsAdapter(HTTPAdapter):
    """requests adapter that enables legacy SSL renegotiation for PDU HTTPS."""

    def init_poolmanager(self, connections, maxsize, block=False, **pool_kwargs):
        pool_kwargs["ssl_context"] = pdu_ssl_context()
        return super().init_poolmanager(connections, maxsize, block=block, **pool_kwargs)


def configure_pdu_session(session: requests.Session, *, use_https: bool) -> requests.Session:
    """Attach legacy-compatible HTTPS handling when talking to PDU web admin."""
    if use_https:
        session.mount("https://", _PduHttpsAdapter())
    return session


def _nonce(length: int = 20) -> str:
    return "".join(random.choice(_NONCE_CHARS) for _ in range(length))


def _parse_csv(raw: str) -> List[str]:
    """Split a semicolon-delimited CGI response into fields."""
    parts = raw.split(";")
    if parts and parts[-1] == "":
        parts = parts[:-1]
    return parts


class PDUWebClient:
    """Stateful client for a single PDU's CGI web interface."""

    def __init__(
        self,
        host: str,
        port: int = 6662,
        username: str = "admin",
        password: str = "admin",
        timeout: int = 10,
        use_https: bool = False,
    ):
        self.host = host
        self.port = port
        self.use_https = use_https
        scheme = "https" if use_https else "http"
        self.base_url = f"{scheme}://{host}:{port}"
        self.username = username
        self.password = password
        self.timeout = timeout
        self._session = self._new_session()
        self._logged_in = False
        self._login_time: float = 0
        self._session_ttl = 15  # PDU times out after ~20 s; refresh at 15
        self._lock = threading.RLock()  # serialize all PDU interactions (reentrant)
        self.last_login_error: str | None = None

    def _ssl_verify(self) -> bool:
        """PDUs ship with a default self-signed certificate when HTTPS is enabled."""
        return not self.use_https

    def _new_session(self) -> requests.Session:
        return configure_pdu_session(requests.Session(), use_https=self.use_https)

    # ------------------------------------------------------------------
    # Authentication
    # ------------------------------------------------------------------

    @staticmethod
    def _response_indicates_login_success(resp: requests.Response) -> bool:
        body = resp.text or ""
        location = (resp.headers.get("Location") or "").lower()
        if resp.status_code == 200 and "home0.html" in body:
            return True
        if resp.status_code in (200, 302) and (
            "home_upload.cgi" in body.lower()
            or "home0.html" in body.lower()
            or "home" in location
            or (resp.status_code == 302 and location)
        ):
            return True
        return False

    def _finalize_login(self, resp: requests.Response) -> bool:
        if self._response_indicates_login_success(resp):
            self._logged_in = True
            self._login_time = _time.time()
            self.last_login_error = None
            return True

        body = resp.text or ""
        location = resp.headers.get("Location") or ""
        self.last_login_error = (
            f"HTTP {resp.status_code}"
            + (f", redirect={location!r}" if location else "")
            + f", body[:160]={body[:160]!r}"
        )
        print(
            f"[pdu-login] {self.base_url} rejected user={self.username!r} — {self.last_login_error}"
        )
        self._logged_in = False
        return False

    def login(self) -> bool:
        with self._lock:
            try:
                self._session.close()
            except Exception:
                pass
            self._session = self._new_session()
            sha1_pass = hashlib.sha1(self.password.encode()).hexdigest()
            nonce = _nonce()
            hmac_val = hmac.new(
                sha1_pass.encode(), nonce.encode(), hashlib.sha1
            ).hexdigest()

            try:
                resp = self._session.post(
                    f"{self.base_url}/login.cgi",
                    data={
                        "ip": self.username,
                        "port": hmac_val,
                        "radom": nonce,
                        "login": "Log On",
                    },
                    timeout=self.timeout,
                    allow_redirects=False,
                    verify=self._ssl_verify(),
                )
            except requests.exceptions.SSLError as exc:
                self.last_login_error = f"SSL error: {exc}"
                print(f"[pdu-login] {self.base_url} {self.last_login_error}")
                self._logged_in = False
                return False
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
                self.last_login_error = f"Unreachable: {exc}"
                print(f"[pdu-login] {self.base_url} {self.last_login_error}")
                self._logged_in = False
                return False

            if self._finalize_login(resp):
                return True

            # Some HTTPS firmware returns 302 — follow once to confirm session.
            if resp.status_code in (301, 302, 303, 307, 308):
                location = resp.headers.get("Location") or ""
                if location and not location.startswith("http"):
                    location = f"{self.base_url}/{location.lstrip('/')}"
                if location:
                    try:
                        follow = self._session.get(
                            location,
                            timeout=self.timeout,
                            verify=self._ssl_verify(),
                        )
                        if self._finalize_login(follow):
                            return True
                    except requests.exceptions.RequestException as exc:
                        self.last_login_error = f"Redirect follow failed: {exc}"
                        print(f"[pdu-login] {self.base_url} {self.last_login_error}")

            self._logged_in = False
            return False

    def logout(self) -> None:
        """Close the HTTP session to free the PDU's single-session slot."""
        with self._lock:
            try:
                self._session.close()
            except Exception:
                pass
            self._session = self._new_session()
            self._logged_in = False

    def _touch_session(self) -> None:
        """Keep the client-side session window alive while CGI calls are in flight."""
        self._login_time = _time.time()

    def _ensure_session(self) -> None:
        if not self._logged_in or (_time.time() - self._login_time > self._session_ttl):
            for attempt in range(5):
                if self.login():
                    return
                _time.sleep(1.0 * (attempt + 1))
            raise ConnectionError(
                f"PDU login failed after 5 retries ({self.base_url}, user={self.username})"
            )

    def _get_cgi(self, path: str) -> List[str]:
        with self._lock:
            self._ensure_session()
            resp = self._session.get(
                f"{self.base_url}/{path}", timeout=self.timeout, verify=self._ssl_verify()
            )
            resp.raise_for_status()
            self._touch_session()
            return _parse_csv(resp.text)

    def _post_cgi(self, path: str, data: Dict[str, Any]) -> str:
        with self._lock:
            self._ensure_session()
            resp = self._session.post(
                f"{self.base_url}/{path}",
                data=data,
                timeout=self.timeout,
                verify=self._ssl_verify(),
            )
            resp.raise_for_status()
            self._touch_session()
            return resp.text

    # ------------------------------------------------------------------
    # Reboot
    # ------------------------------------------------------------------

    def reboot(self) -> bool:
        """Trigger a device reboot.  Returns True if the CGI responded (the
        PDU will go offline for 30-60 s while it restarts)."""
        with self._lock:
            return self._reboot_in_session()

    def _reboot_in_session(self) -> bool:
        """Reboot using the active session — avoids re-login after long applies."""
        if not self._logged_in:
            self._ensure_session()
        for path in ("reboot.cgi", "reboot.cgi?"):
            try:
                resp = self._session.get(
                    f"{self.base_url}/{path}",
                    timeout=self.timeout,
                    verify=self._ssl_verify(),
                )
                print(
                    f"[pdu] reboot {self.host} via {path} -> HTTP {resp.status_code}"
                )
                self._logged_in = False
                if resp.status_code == 200:
                    return True
            except requests.exceptions.ConnectionError:
                self._logged_in = False
                print(f"[pdu] reboot {self.host} — connection dropped (device rebooting)")
                return True
            except Exception as e:
                print(f"[pdu] reboot {self.host} via {path} failed: {e}")
        self._logged_in = False
        return False

    def wait_online(self, timeout: int = 90, poll_interval: int = 5) -> bool:
        """Block until the PDU responds to a login, or *timeout* seconds
        elapse.  Returns True if the PDU came back online."""
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

    # ------------------------------------------------------------------
    # Device info
    # ------------------------------------------------------------------

    def get_device_info(self) -> Dict[str, Any]:
        tele = self._get_cgi("Home_Upload.cgi?")
        net = self._get_cgi("tcpip_Onceload.cgi?")
        return {
            "name": tele[1] if len(tele) > 1 else "",
            "firmware": tele[2] if len(tele) > 2 else "",
            "mac": net[4] if len(net) > 4 else "",
            "ip": net[5] if len(net) > 5 else "",
            "mask": net[6] if len(net) > 6 else "",
            "gateway": net[7] if len(net) > 7 else "",
        }

    # ------------------------------------------------------------------
    # Network config
    # ------------------------------------------------------------------

    def get_network_config(self) -> Dict[str, Any]:
        f = self._get_cgi("tcpip_Onceload.cgi?")
        return {
            "mac": f[4] if len(f) > 4 else "",
            "current_ip": f[5] if len(f) > 5 else "",
            "current_mask": f[6] if len(f) > 6 else "",
            "current_gateway": f[7] if len(f) > 7 else "",
            "current_dns1": f[8] if len(f) > 8 else "",
            "current_dns2": f[9] if len(f) > 9 else "",
            "current_ipv6": f[10] if len(f) > 10 else "",
            "current_ipv6_prefix": f[11] if len(f) > 11 else "",
            "current_ipv6_global": f[12] if len(f) > 12 else "",
            "current_ipv6_router": f[13] if len(f) > 13 else "",
            "current_ipv6_dns1": f[14] if len(f) > 14 else "",
            "current_ipv6_dns2": f[15] if len(f) > 15 else "",
            "dhcp": f[16] if len(f) > 16 else "OFF",
            "dhcp_value": f[17] if len(f) > 17 else "0",
            "set_ip": f[18] if len(f) > 18 else "",
            "set_mask": f[19] if len(f) > 19 else "",
            "set_gateway": f[20] if len(f) > 20 else "",
            "set_dns1": f[21] if len(f) > 21 else "",
            "set_dns2": f[22] if len(f) > 22 else "",
            "csrf_token": f[30] if len(f) > 30 else "",
        }

    def set_ipv4(
        self,
        ip: str,
        mask: str = "255.255.255.0",
        gateway: str = "",
        dns1: str = "",
        dns2: str = "",
    ) -> bool:
        with self._lock:
            net = self.get_network_config()
            csrf = net["csrf_token"]
            resp = self._post_cgi(
                "network_IPV4_set.cgi",
                {
                    "switch_netset_csrftoken2": csrf,
                    "Set_IP": ip,
                    "Set_Mask": mask,
                    "Set_GW": gateway or net["current_gateway"],
                    "Set_DNS1": dns1 or net["current_dns1"],
                    "Set_DNS2": dns2 or net["current_dns2"],
                },
            )
            return "404" not in resp

    def set_dhcp(self, enabled: bool) -> bool:
        with self._lock:
            net = self.get_network_config()
            csrf = net["csrf_token"]
            resp = self._post_cgi(
                "network_DHCP_set.cgi",
                {
                    "switch_netset_csrftoken1": csrf,
                    "Set_DHCP": "1" if enabled else "0",
                },
            )
            return "404" not in resp

    # ------------------------------------------------------------------
    # SNMP config
    # ------------------------------------------------------------------

    def get_snmp_config(self) -> Dict[str, Any]:
        f = self._get_cgi("snmp_Onceload.cgi?")
        return {
            "snmpv1_enabled": f[2] == "true" if len(f) > 2 else False,
            "snmpv2_enabled": f[3] == "true" if len(f) > 3 else False,
            "snmpv3_enabled": f[4] == "true" if len(f) > 4 else False,
            "community_read": f[5] if len(f) > 5 else "",
            "community_write": f[6] if len(f) > 6 else "",
            "snmpv3_username": f[7] if len(f) > 7 else "",
            "verify_protocol": f[8] if len(f) > 8 else "",
            "auth_key": f[9] if len(f) > 9 else "",
            "encrypt_protocol": f[10] if len(f) > 10 else "",
            "priv_key": f[11] if len(f) > 11 else "",
            "trap_ip": f[12] if len(f) > 12 else "",
            "csrf_token": f[14] if len(f) > 14 else "",
        }

    def set_snmp(
        self,
        read_community: str | None = None,
        write_community: str | None = None,
        snmpv1: bool | None = None,
        snmpv2: bool | None = None,
        snmpv3: bool | None = None,
        snmpv3_username: str | None = None,
        verify_protocol: str | None = None,
        auth_key: str | None = None,
        encrypt_protocol: str | None = None,
        priv_key: str | None = None,
        trap_ip: str | None = None,
    ) -> bool:
        with self._lock:
            cur = self.get_snmp_config()
            csrf = cur["csrf_token"]

            def _bool_val(new, cur_val):
                if new is None:
                    return "true" if cur_val else ""
                return "true" if new else ""

            def _field(new, cur_val):
                return cur_val if new is None else new

            resp = self._post_cgi(
                "snmp_set.cgi",
                {
                    "switch_netset_csrftoken2": csrf,
                    "SNMPStatu_Ver1": _bool_val(snmpv1, cur["snmpv1_enabled"]),
                    "SNMPStatu_Ver2": _bool_val(snmpv2, cur["snmpv2_enabled"]),
                    "SNMPStatu_Ver3": _bool_val(snmpv3, cur["snmpv3_enabled"]),
                    "SNMPStatu_Community_Read": _field(read_community, cur["community_read"]),
                    "SNMPStatu_Community_Write": _field(write_community, cur["community_write"]),
                    "SNMPStatu_User_Name": _field(snmpv3_username, cur["snmpv3_username"]),
                    "SNMPStatu_VerifyProtocol": _field(verify_protocol, cur["verify_protocol"]),
                    "SNMPStatu_AUTH_KEY": _field(auth_key, cur["auth_key"]),
                    "SNMPStatu_EncrypyProtocol": _field(encrypt_protocol, cur["encrypt_protocol"]),
                    "SNMPStatu_PRIV_KEY": _field(priv_key, cur["priv_key"]),
                    "SNMPStatu_TrapManageIP1": _field(trap_ip, cur["trap_ip"]),
                },
            )
            return "404" not in resp

    # ------------------------------------------------------------------
    # Time config
    # ------------------------------------------------------------------

    def get_time_config(self) -> Dict[str, Any]:
        f = self._get_cgi("time_Onceload.cgi?")
        return {
            "year": f[2] if len(f) > 2 else "",
            "month": f[3] if len(f) > 3 else "",
            "day": f[4] if len(f) > 4 else "",
            "hour": f[5] if len(f) > 5 else "",
            "minute": f[6] if len(f) > 6 else "",
            "second": f[7] if len(f) > 7 else "",
            "sntp_enabled": f[8] if len(f) > 8 else "",
            "sntp_server": f[9] if len(f) > 9 else "",
            "timezone": f[10] if len(f) > 10 else "",
            "update_interval": f[11] if len(f) > 11 else "",
            "correction": f[12] if len(f) > 12 else "",
            "csrf_token": f[14] if len(f) > 14 else "",
        }

    def set_time(
        self,
        year: str | None = None,
        month: str | None = None,
        day: str | None = None,
        hour: str | None = None,
        minute: str | None = None,
        second: str | None = None,
        sntp_enabled: str | None = None,
        sntp_server: str | None = None,
        timezone: str | None = None,
        update_interval: str | None = None,
        correction: str | None = None,
    ) -> bool:
        with self._lock:
            cur = self.get_time_config()
            csrf = cur["csrf_token"]
            resp = self._post_cgi(
                "time_set.cgi",
                {
                    "switch_timeset_csrftoken1": csrf,
                    "TimeNow_Year": year or cur["year"],
                    "TimeNow_Mon": month or cur["month"],
                    "TimeNow_Date": day or cur["day"],
                    "TimeNow_Hour": hour or cur["hour"],
                    "TimeNow_Min": minute or cur["minute"],
                    "TimeNow_Sec": second or cur["second"],
                    "SNTPStatu_Statue": sntp_enabled if sntp_enabled is not None else cur["sntp_enabled"],
                    "SNTPStatu_Server": sntp_server or cur["sntp_server"],
                    "SNTPStatu_TimeZone": timezone or cur["timezone"],
                    "SNTPStatu_UpdataDelay": update_interval or cur["update_interval"],
                    "SNTP_Correction": correction or cur["correction"],
                },
            )
            return "404" not in resp

    # ------------------------------------------------------------------
    # Live telemetry
    # ------------------------------------------------------------------

    # 3-phase CGI layout (75+ fields)
    _TELE_LABELS_3P = [
        "csrf", "name", "firmware",
        "l1_voltage", "l1_current", "l1_load_pct", "l1_color",
        "l1_active_power", "l1_reactive_power", "l1_apparent_power",
        "l1_pf", "l1_active_energy", "l1_reactive_energy",
        "l2_voltage", "l2_current", "l2_load_pct", "l2_color",
        "l2_active_power", "l2_reactive_power", "l2_apparent_power",
        "l2_pf", "l2_active_energy", "l2_reactive_energy",
        "l3_voltage", "l3_current", "l3_load_pct", "l3_color",
        "l3_active_power", "l3_reactive_power", "l3_apparent_power",
        "l3_pf", "l3_active_energy", "l3_reactive_energy",
        "total_active_power", "total_reactive_power", "total_apparent_power",
        "total_pf", "total_active_energy", "total_reactive_energy",
        "frequency", "neutral_current", "neutral_load_pct",
    ]

    # Single-phase smart strip CGI layout (50 fields)
    # Fields: csrf, name, fw, voltage, current, load%, color,
    #         active_power, pf, energy, frequency, then dashes, alarms, tail
    _TELE_LABELS_1P = [
        "csrf", "name", "firmware",
        "l1_voltage", "l1_current", "l1_load_pct", "l1_color",
        "l1_active_power", "l1_pf", "l1_active_energy",
        "frequency",
    ]

    # Alarm flag labels in the order they appear in Home_Upload.cgi
    # after the breakers section (pairs of text + color per parameter).
    _ALARM_FLAG_LABELS = [
        "alarm_l1_voltage", "alarm_l1_current",
        "alarm_l2_voltage", "alarm_l2_current",
        "alarm_l3_voltage", "alarm_l3_current",
        "alarm_neutral", "alarm_phase_unbalance",
        "alarm_temp1", "alarm_hum1",
        "alarm_temp2", "alarm_hum2",
        "alarm_temp3", "alarm_hum3",
        "alarm_temp4", "alarm_hum4",
        "alarm_sensor1", "alarm_sensor2",
        "alarm_sensor3", "alarm_sensor4",
    ]

    def get_live_telemetry(self) -> Dict[str, Any]:
        f = self._get_cgi("Home_Upload.cgi?")
        result: Dict[str, Any] = {}

        # Detect single-phase vs 3-phase by total field count.
        # 3-phase PDUs return 75+ fields; single-phase smart strips ~50.
        is_single_phase = len(f) < 65
        labels = self._TELE_LABELS_1P if is_single_phase else self._TELE_LABELS_3P
        result["_phase_count"] = "1" if is_single_phase else "3"

        for i, val in enumerate(f):
            key = labels[i] if i < len(labels) else f"field_{i}"
            result[key] = val

        # For single-phase, promote L1 values to totals for dashboard
        if is_single_phase:
            for src, dst in [
                ("l1_active_power", "total_active_power"),
                ("l1_active_energy", "total_active_energy"),
                ("l1_pf", "total_pf"),
            ]:
                if src in result and dst not in result:
                    result[dst] = result[src]

        # After the named telemetry fields come:
        #   - temperature/humidity sensor readings (variable)
        #   - breaker statuses (variable, pairs of status+color)
        #   - alarm flags (pairs of text+color per parameter)
        #   - datetime, overall alarm status, overall alarm color (last 3)
        #
        # Strategy: work backwards from the known tail to parse alarm flags,
        # then everything between telemetry labels and alarm flags is breakers.

        # Last 3 fields: datetime, alarm_status, alarm_color
        if len(f) >= 3:
            result["datetime"] = f[-3]
            result["alarm_status"] = f[-2]
            result["alarm_color"] = f[-1]

        # Alarm flags: 20 parameters x 2 fields (text+color) = 40 fields before tail
        # For single-phase PDUs, fewer alarm params may be present.
        tele_end = len(labels)  # where named telemetry fields end
        alarm_flag_count = len(self._ALARM_FLAG_LABELS)
        alarm_start = len(f) - 3 - (alarm_flag_count * 2)

        # Sanity: if alarm_start lands before telemetry ends, try fewer alarm params.
        # Single-phase PDUs have 14 alarm pairs instead of 20.
        if alarm_start < tele_end:
            # Try detecting alarm region: scan backwards from tail-3 for paired
            # text+color alarm entries to find the real alarm start.
            alarm_start = len(f) - 3
            alarm_flag_count = 0
            probe = alarm_start - 2
            while probe >= tele_end:
                text = f[probe].strip()
                color = f[probe + 1].strip() if probe + 1 < len(f) else ""
                if color in ("white", "red", "orange", "yellow", "green", "blue", ""):
                    alarm_start = probe
                    alarm_flag_count += 1
                    probe -= 2
                else:
                    break

        alarm_flags = []
        ai = 0
        idx = alarm_start
        while idx + 1 < len(f) - 3:
            label = self._ALARM_FLAG_LABELS[ai] if ai < len(self._ALARM_FLAG_LABELS) else f"alarm_unknown_{ai}"
            text = f[idx].strip()
            color = f[idx + 1].strip() if idx + 1 < len(f) else ""
            result[label] = text
            result[f"{label}_color"] = color
            if text and text != "-" and text.lower() != "normal":
                alarm_flags.append({"param": label.replace("alarm_", ""), "status": text, "color": color})
            ai += 1
            idx += 2
        result["alarm_flags"] = alarm_flags

        # Breakers: everything between telemetry labels and alarm flags
        breakers = []
        breaker_end = alarm_start
        idx = tele_end
        while idx + 1 < breaker_end:
            status = f[idx].strip()
            color = f[idx + 1].strip() if idx + 1 < len(f) else ""
            # Skip dash-only entries (unused fields)
            if status and status != "-":
                breakers.append({"status": status, "color": color})
            idx += 2
        result["breakers"] = breakers

        return result

    # ------------------------------------------------------------------
    # Event logs
    # ------------------------------------------------------------------

    def get_logs(self) -> List[Dict[str, str]]:
        f = self._get_cgi("log_Onceload.cgi?")
        logs = []
        # Skip btn_display [0] and headname [1]
        idx = 2
        while idx + 3 < len(f):
            date = f[idx].strip()
            time_str = f[idx + 1].strip()
            category = f[idx + 2].strip()
            color = f[idx + 3].strip()
            # Next field might be the event text (sometimes padded)
            event = f[idx + 4].strip() if idx + 4 < len(f) else ""
            if date:
                logs.append({
                    "date": date,
                    "time": time_str,
                    "category": category,
                    "color": color,
                    "event": event,
                })
            idx += 5
        return logs

    # ------------------------------------------------------------------
    # Alarm threshold config
    # ------------------------------------------------------------------

    def get_alarm_thresholds(self) -> Dict[str, Any]:
        """Read device + sensor alarm thresholds from ts_cfg_Onceload.cgi.

        Field order (from parameter_cfg0.html JS):
          [0] Pagename ("Host PDU Configure")
          [1] Headname ("")
          [2] btn1.display   [3] btn2.display   [4] btn3.display
          [5] BeepAlarm (1=ON, 0=OFF)
          [6] Utop0 (L1 V upper)  [7] Ubottom0 (L1 V lower)
          [8] Itop0 (L1 A upper)  [9] Ibottom0 (L1 A lower)
          [10] Utop1 (L2 V upper) [11] Ubottom1 (L2 V lower)
          [12] Itop1 (L2 A upper) [13] Ibottom1 (L2 A lower)
          [14] Utop2 (L3 V upper) [15] Ubottom2 (L3 V lower)
          [16] Itop2 (L3 A upper) [17] Ibottom2 (L3 A lower)
          [18] ZeroIrms (neutral line)  [19] PhaseUnbalance
          [20] Ttop0  [21] Tbottom0  [22] Htop0  [23] Hbottom0
          [24] Ttop1  [25] Tbottom1  [26] Htop1  [27] Hbottom1
          [28] Ttop2  [29] Tbottom2  [30] Htop2  [31] Hbottom2
          [32] Ttop3  [33] Tbottom3  [34] Htop3  [35] Hbottom3
          [36] I_randnum (rated current)
          [37] loginname   [38] CSRF token   [39] page index
        """
        f = self._get_cgi("ts_cfg_Onceload.cgi?")
        result: Dict[str, Any] = {"raw_fields": len(f)}

        def _g(idx: int) -> str:
            return f[idx].strip() if idx < len(f) else ""

        result["beep_alarm"] = _g(5)

        result["l1_voltage_upper"] = _g(6)
        result["l1_voltage_lower"] = _g(7)
        result["l1_current_upper"] = _g(8)
        result["l1_current_lower"] = _g(9)
        result["l2_voltage_upper"] = _g(10)
        result["l2_voltage_lower"] = _g(11)
        result["l2_current_upper"] = _g(12)
        result["l2_current_lower"] = _g(13)
        result["l3_voltage_upper"] = _g(14)
        result["l3_voltage_lower"] = _g(15)
        result["l3_current_upper"] = _g(16)
        result["l3_current_lower"] = _g(17)
        result["neutral_line"] = _g(18)
        result["phase_unbalance"] = _g(19)

        result["temp1_upper"] = _g(20)
        result["temp1_lower"] = _g(21)
        result["hum1_upper"] = _g(22)
        result["hum1_lower"] = _g(23)
        result["temp2_upper"] = _g(24)
        result["temp2_lower"] = _g(25)
        result["hum2_upper"] = _g(26)
        result["hum2_lower"] = _g(27)
        result["temp3_upper"] = _g(28)
        result["temp3_lower"] = _g(29)
        result["hum3_upper"] = _g(30)
        result["hum3_lower"] = _g(31)
        result["temp4_upper"] = _g(32)
        result["temp4_lower"] = _g(33)
        result["hum4_upper"] = _g(34)
        result["hum4_lower"] = _g(35)

        result["rated_current"] = _g(36)
        result["csrf_token"] = _g(38)

        return result

    def set_alarm_thresholds(self, **kwargs) -> bool:
        """Write alarm thresholds.  Accepts any subset of the fields
        returned by get_alarm_thresholds(); unspecified fields keep
        their current values.  Posts to Meter_limit.cgi (phase/device)
        and Sensor_limit.cgi (temp/humidity) separately."""
        with self._lock:
            cur = self.get_alarm_thresholds()
            csrf = cur.get("csrf_token", "")

            def _v(key: str) -> str:
                return str(kwargs[key]) if key in kwargs else str(cur.get(key, ""))

            # Form 1: Meter_limit.cgi (phase voltage/current, neutral, unbalance, beep)
            meter_data = {
                "ts_csrftoken1": csrf,
                "BeepAlarm": _v("beep_alarm"),
                "Utop0": _v("l1_voltage_upper"),
                "Ubottom0": _v("l1_voltage_lower"),
                "Itop0": _v("l1_current_upper"),
                "Ibottom0": _v("l1_current_lower"),
                "Utop1": _v("l2_voltage_upper"),
                "Ubottom1": _v("l2_voltage_lower"),
                "Itop1": _v("l2_current_upper"),
                "Ibottom1": _v("l2_current_lower"),
                "Utop2": _v("l3_voltage_upper"),
                "Ubottom2": _v("l3_voltage_lower"),
                "Itop2": _v("l3_current_upper"),
                "Ibottom2": _v("l3_current_lower"),
                "ZeroIrms": _v("neutral_line"),
                "PhaseUnbalance": _v("phase_unbalance"),
            }
            resp1 = self._post_cgi("Meter_limit.cgi", meter_data)

            # Form 2: Sensor_limit.cgi (temperature/humidity for 4 sensors)
            sensor_data = {
                "ts_csrftoken2": csrf,
                "Ttop0": _v("temp1_upper"), "Tbottom0": _v("temp1_lower"),
                "Htop0": _v("hum1_upper"), "Hbottom0": _v("hum1_lower"),
                "Ttop1": _v("temp2_upper"), "Tbottom1": _v("temp2_lower"),
                "Htop1": _v("hum2_upper"), "Hbottom1": _v("hum2_lower"),
                "Ttop2": _v("temp3_upper"), "Tbottom2": _v("temp3_lower"),
                "Htop2": _v("hum3_upper"), "Hbottom2": _v("hum3_lower"),
                "Ttop3": _v("temp4_upper"), "Tbottom3": _v("temp4_lower"),
                "Htop3": _v("hum4_upper"), "Hbottom3": _v("hum4_lower"),
            }
            resp2 = self._post_cgi("Sensor_limit.cgi", sensor_data)

            return "404" not in resp1 and "404" not in resp2

    # ------------------------------------------------------------------
    # System / Device settings (hostname, LCD, logout)
    # ------------------------------------------------------------------

    def get_system_config(self) -> Dict[str, Any]:
        f = self._get_cgi("Tool_Onceload.cgi?")
        return {
            "device_name": f[4] if len(f) > 4 else "",
            "lcd_title": f[5] if len(f) > 5 else "",
            "display_direction": f[6] if len(f) > 6 else "0",
            "lcd_backlight_mode": f[7] if len(f) > 7 else "0",
            "lcd_backlight_time": f[8] if len(f) > 8 else "3",
            "lcd_rest_brightness": f[9] if len(f) > 9 else "0",
            "logout_enabled": f[10] if len(f) > 10 else "1",
            "logout_time": f[11] if len(f) > 11 else "3",
            "web_title_enabled": f[12] if len(f) > 12 else "0",
            "router_hostname": f[14] if len(f) > 14 else "",
            "csrf_token": f[17] if len(f) > 17 else f[16] if len(f) > 16 else "",
        }

    def set_system_config(
        self,
        device_name: str | None = None,
        lcd_title: str | None = None,
        display_direction: str | None = None,
        lcd_backlight_mode: str | None = None,
        lcd_backlight_time: str | None = None,
        lcd_rest_brightness: str | None = None,
        logout_enabled: str | None = None,
        logout_time: str | None = None,
        web_title_enabled: str | None = None,
        router_hostname: str | None = None,
    ) -> bool:
        with self._lock:
            cur = self.get_system_config()
            csrf = cur["csrf_token"]
            resp = self._post_cgi(
                "Tool_device_set.cgi",
                {
                    "sys_tool_csrftoken1": csrf,
                    "Device_name": device_name or cur["device_name"],
                    "LCD_title": lcd_title or cur["lcd_title"],
                    "Display_Mode": display_direction or cur["display_direction"],
                    "LCD_BL": lcd_backlight_mode or cur["lcd_backlight_mode"],
                    "LCD_BL_Time": lcd_backlight_time or cur["lcd_backlight_time"],
                    "LCD_BL_PWM": lcd_rest_brightness or cur["lcd_rest_brightness"],
                    "logoutflag": logout_enabled or cur["logout_enabled"],
                    "logouttime": logout_time or cur["logout_time"],
                    "webtitleflag": web_title_enabled or cur["web_title_enabled"],
                    "router_hostname": router_hostname or cur["router_hostname"],
                },
            )
            return "404" not in resp

    # ------------------------------------------------------------------
    # User management
    # ------------------------------------------------------------------

    def get_users(self) -> Dict[str, Any]:
        f = self._get_cgi("User_read_Onceload.cgi?")
        return {
            "admin_username": f[2] if len(f) > 2 else "admin",
            "admin_password_masked": f[3] if len(f) > 3 else "",
            "user1_username": f[4] if len(f) > 4 else "",
            "user1_password_masked": f[5] if len(f) > 5 else "",
            "user2_username": f[6] if len(f) > 6 else "",
            "user2_password_masked": f[7] if len(f) > 7 else "",
            "csrf_token": f[9] if len(f) > 9 else f[8] if len(f) > 8 else "",
        }

    def set_users(
        self,
        admin_username: str | None = None,
        admin_password: str | None = None,
        user1_username: str | None = None,
        user1_password: str | None = None,
        user2_username: str | None = None,
        user2_password: str | None = None,
    ) -> bool:
        with self._lock:
            cur = self.get_users()
            csrf = cur["csrf_token"]
            fields: Dict[str, Any] = {
                "switch_userset_csrftoken1": csrf,
                "Meter_admin_User": admin_username or cur["admin_username"],
                "Meter_User2": user1_username or cur["user1_username"],
                "Meter_password2": user1_password or "",
                "Meter_User3": user2_username or cur["user2_username"],
                "Meter_password3": user2_password or "",
            }
            if admin_password is not None:
                fields["Meter_admin_password"] = admin_password
            resp = self._post_cgi("User_set.cgi", fields)
            return "404" not in resp

            return "404" not in resp

    # ------------------------------------------------------------------
    # Web access (HTTP / HTTPS) — sys_http.html / http_https_set.cgi
    # ------------------------------------------------------------------

    def get_web_access_config(self) -> Dict[str, Any]:
        """Read HTTP/HTTPS mode and ports from http_Onceload.cgi."""
        f = self._get_cgi("http_Onceload.cgi?")
        return {
            "https_http": f[4] if len(f) > 4 else "0",  # 0=HTTP, 1=HTTPS
            "http_port": f[5] if len(f) > 5 else "80",
            "https_port": f[6] if len(f) > 6 else "443",
            "default_cert": f[7] if len(f) > 7 else "",
            "user_cert": f[8] if len(f) > 8 else "",
            "csrf_token": f[10] if len(f) > 10 else f[9] if len(f) > 9 else "",
        }

    def set_web_access(
        self,
        https_http: str | None = None,
        http_port: str | None = None,
        https_port: str | None = None,
    ) -> bool:
        """Switch web admin between HTTP and HTTPS. Requires a PDU reboot."""
        with self._lock:
            cur = self.get_web_access_config()
            csrf = cur["csrf_token"]
            resp = self._post_cgi(
                "http_https_set.cgi",
                {
                    "switch_netset_csrftoken3": csrf,
                    "https_http": https_http if https_http is not None else cur["https_http"],
                    "HTTPPort": http_port or cur["http_port"],
                    "HTTPSPort": https_port or cur["https_port"],
                },
            )
            return "404" not in resp

    # ------------------------------------------------------------------
    # Batch apply: push a full template in one go
    # ------------------------------------------------------------------

    def apply_batch_template(
        self, template: Dict[str, Any], *, reboot_after: bool = False
    ) -> Dict[str, Any]:
        """Apply a commissioning template under one exclusive session.

        Holds the client lock for the entire apply so the background poller
        cannot steal the PDU's single web-admin session mid-template.
        Call ``reboot()`` after apply when a reboot is required — same as
        Apply & Reboot in PDU Settings / Remote PDU commissioning.
        """
        with self._lock:
            prev_ttl = self._session_ttl
            self._session_ttl = 300
            try:
                report = self._apply_batch_template_body(template)
                if reboot_after:
                    ok = self.reboot()
                    report["_reboot"] = {"success": ok}
                return report
            finally:
                self._session_ttl = prev_ttl

    def _apply_batch_template_body(self, template: Dict[str, Any]) -> Dict[str, Any]:
        """Inner batch apply — caller must hold self._lock."""
        report: Dict[str, Any] = {}

        # 1. DHCP → Static if needed
        net = template.get("network", {})
        if net:
            try:
                if net.get("dhcp") == "OFF":
                    self.set_dhcp(False)
                ok = self.set_ipv4(
                    ip=net.get("ip", ""),
                    mask=net.get("mask", "255.255.255.0"),
                    gateway=net.get("gateway", ""),
                    dns1=net.get("dns1", ""),
                    dns2=net.get("dns2", ""),
                )
                report["network"] = {"success": ok}
            except Exception as e:
                report["network"] = {"success": False, "error": str(e)}

        # 2. System / hostname
        sys_cfg = template.get("system", {})
        if sys_cfg:
            try:
                ok = self.set_system_config(**sys_cfg)
                report["system"] = {"success": ok}
            except Exception as e:
                report["system"] = {"success": False, "error": str(e)}

        # 3. User credentials — only push when the operator actually set a value.
        users = template.get("users") or {}
        admin_pw = (users.get("admin_password") or "").strip()
        admin_user = (users.get("admin_username") or "").strip()
        extra_users = any(
            (users.get(k) or "").strip()
            for k in ("user1_username", "user1_password", "user2_username", "user2_password")
        )
        if admin_pw or admin_user or extra_users:
            try:
                user_kwargs: Dict[str, Any] = {}
                if admin_user:
                    user_kwargs["admin_username"] = admin_user
                if admin_pw:
                    user_kwargs["admin_password"] = admin_pw
                for k in ("user1_username", "user1_password", "user2_username", "user2_password"):
                    v = (users.get(k) or "").strip()
                    if v:
                        user_kwargs[k] = v
                ok = self.set_users(**user_kwargs)
                report["users"] = {"success": ok}
            except Exception as e:
                report["users"] = {"success": False, "error": str(e)}

        # 4. SNMP
        snmp = template.get("snmp", {})
        if snmp:
            try:
                ok = self.set_snmp(**snmp)
                report["snmp"] = {"success": ok}
            except Exception as e:
                report["snmp"] = {"success": False, "error": str(e)}

        # 5. NTP / Time
        ntp = template.get("ntp", {})
        if ntp:
            try:
                ntp_payload = dict(ntp)
                # PDU accepts a single SNTPStatu_Server — join primary + secondary.
                primary = (ntp_payload.pop("sntp_server", None) or "").strip()
                secondary = (ntp_payload.pop("sntp_server2", None) or "").strip()
                servers = [s for s in [primary, secondary] if s]
                if servers:
                    ntp_payload["sntp_server"] = ",".join(servers)
                # Checkbox on PDU web UI: "true" when enabled, empty when off.
                enabled = ntp_payload.get("sntp_enabled")
                if isinstance(enabled, bool):
                    ntp_payload["sntp_enabled"] = "true" if enabled else ""
                ok = self.set_time(**ntp_payload)
                report["ntp"] = {"success": ok}
            except Exception as e:
                report["ntp"] = {"success": False, "error": str(e)}

        # 6. Web access (HTTP/HTTPS) — apply last while still on HTTP; needs reboot.
        web = template.get("web_access") or {}
        if web:
            try:
                ok = self.set_web_access(
                    https_http=str(web.get("https_http", "0")),
                    http_port=str(web.get("http_port", "80")),
                    https_port=str(web.get("https_port", "443")),
                )
                report["web_access"] = {"success": ok, "needs_reboot": ok}
            except Exception as e:
                report["web_access"] = {"success": False, "error": str(e)}

        return report

    # ------------------------------------------------------------------
    # All settings in one call
    # ------------------------------------------------------------------

    def get_all_settings(self) -> Dict[str, Any]:
        with self._lock:
            prev_ttl = self._session_ttl
            self._session_ttl = 120  # bulk read can take 30-60 s over VPN
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
                self._session_ttl = prev_ttl
