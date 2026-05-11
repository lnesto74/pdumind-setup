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
import time as _time
import threading
from typing import Any, Dict, List, Optional

import requests

_NONCE_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"


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
    ):
        self.base_url = f"http://{host}:{port}"
        self.username = username
        self.password = password
        self.timeout = timeout
        self._session = requests.Session()
        self._logged_in = False
        self._login_time: float = 0
        self._session_ttl = 15  # PDU times out after ~20 s; refresh at 15
        self._lock = threading.RLock()  # serialize all PDU interactions (reentrant)

    # ------------------------------------------------------------------
    # Authentication
    # ------------------------------------------------------------------

    def login(self) -> bool:
        self._session = requests.Session()
        sha1_pass = hashlib.sha1(self.password.encode()).hexdigest()
        nonce = _nonce()
        hmac_val = hmac.new(
            sha1_pass.encode(), nonce.encode(), hashlib.sha1
        ).hexdigest()

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
        )
        if resp.status_code == 200 and "home0.html" in resp.text:
            self._logged_in = True
            self._login_time = _time.time()
            return True

        self._logged_in = False
        return False

    def _ensure_session(self) -> None:
        if not self._logged_in or (_time.time() - self._login_time > self._session_ttl):
            for attempt in range(5):
                if self.login():
                    return
                _time.sleep(1.0 * (attempt + 1))
            raise ConnectionError("PDU login failed after 5 retries")

    def _get_cgi(self, path: str) -> List[str]:
        with self._lock:
            self._ensure_session()
            resp = self._session.get(
                f"{self.base_url}/{path}", timeout=self.timeout
            )
            resp.raise_for_status()
            return _parse_csv(resp.text)

    def _post_cgi(self, path: str, data: Dict[str, Any]) -> str:
        with self._lock:
            self._ensure_session()
            resp = self._session.post(
                f"{self.base_url}/{path}", data=data, timeout=self.timeout
            )
            resp.raise_for_status()
            return resp.text

    # ------------------------------------------------------------------
    # Reboot
    # ------------------------------------------------------------------

    def reboot(self) -> bool:
        """Trigger a device reboot.  Returns True if the CGI responded (the
        PDU will go offline for 30-60 s while it restarts)."""
        with self._lock:
            self._ensure_session()
            try:
                resp = self._session.get(
                    f"{self.base_url}/reboot.cgi", timeout=self.timeout
                )
                self._logged_in = False
                return resp.status_code == 200
            except requests.exceptions.ConnectionError:
                self._logged_in = False
                return True  # PDU already rebooting

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

            resp = self._post_cgi(
                "snmp_set.cgi",
                {
                    "switch_netset_csrftoken2": csrf,
                    "SNMPStatu_Ver1": _bool_val(snmpv1, cur["snmpv1_enabled"]),
                    "SNMPStatu_Ver2": _bool_val(snmpv2, cur["snmpv2_enabled"]),
                    "SNMPStatu_Ver3": _bool_val(snmpv3, cur["snmpv3_enabled"]),
                    "SNMPStatu_Community_Read": read_community or cur["community_read"],
                    "SNMPStatu_Community_Write": write_community or cur["community_write"],
                    "SNMPStatu_User_Name": snmpv3_username or cur["snmpv3_username"],
                    "SNMPStatu_VerifyProtocol": verify_protocol or cur["verify_protocol"],
                    "SNMPStatu_AUTH_KEY": auth_key or cur["auth_key"],
                    "SNMPStatu_EncrypyProtocol": encrypt_protocol or cur["encrypt_protocol"],
                    "SNMPStatu_PRIV_KEY": priv_key or cur["priv_key"],
                    "SNMPStatu_TrapManageIP1": trap_ip or cur["trap_ip"],
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

    _TELE_LABELS = [
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

    def get_live_telemetry(self) -> Dict[str, Any]:
        f = self._get_cgi("Home_Upload.cgi?")
        result: Dict[str, Any] = {}
        for i, val in enumerate(f):
            key = self._TELE_LABELS[i] if i < len(self._TELE_LABELS) else f"field_{i}"
            result[key] = val
        # Parse breaker statuses (fields 42+, pairs of status+color)
        breakers = []
        idx = len(self._TELE_LABELS)
        while idx + 1 < len(f):
            status = f[idx]
            color = f[idx + 1] if idx + 1 < len(f) else ""
            if status and status != "-":
                breakers.append({"status": status, "color": color})
            idx += 2
        result["breakers"] = breakers

        # Extract the tail fields (datetime, alarm)
        if len(f) >= 3:
            result["datetime"] = f[-3] if len(f) >= 3 else ""
            result["alarm_status"] = f[-2] if len(f) >= 2 else ""
            result["alarm_color"] = f[-1] if len(f) >= 1 else ""

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
        """Read device + sensor alarm thresholds from parameter_cfg_Onceload.cgi."""
        f = self._get_cgi("parameter_cfg_Onceload.cgi?")
        result: Dict[str, Any] = {"raw_fields": len(f), "raw": f[:60]}

        # The CGI returns semicolon-delimited fields.  Exact layout is
        # discovered empirically; we parse what we can and return a
        # structured dict.  Field order (observed on IPDUv1H firmware):
        #   [0] csrf_or_header
        #   [1] select_index (Host/Guest)
        #   [2] beep_alarm  ("0"=OFF, "1"=ON)
        #   [3] L1 voltage upper, [4] L1 voltage lower
        #   [5] L1 current upper, [6] L1 current lower
        #   [7] L2 voltage upper, [8] L2 voltage lower
        #   [9] L2 current upper, [10] L2 current lower
        #   [11] L3 voltage upper, [12] L3 voltage lower
        #   [13] L3 current upper, [14] L3 current lower
        #   [15] neutral_line
        #   [16] phase_unbalance
        #   [17..18] temp1 upper/lower, [19..20] hum1 upper/lower
        #   [21..22] temp2 upper/lower, [23..24] hum2 upper/lower
        #   [25..26] temp3 upper/lower, [27..28] hum3 upper/lower
        #   [29..30] temp4 upper/lower, [31..32] hum4 upper/lower
        #   [...] csrf token near the end

        def _g(idx: int) -> str:
            return f[idx].strip() if idx < len(f) else ""

        result["beep_alarm"] = _g(2)

        result["l1_voltage_upper"] = _g(3)
        result["l1_voltage_lower"] = _g(4)
        result["l1_current_upper"] = _g(5)
        result["l1_current_lower"] = _g(6)
        result["l2_voltage_upper"] = _g(7)
        result["l2_voltage_lower"] = _g(8)
        result["l2_current_upper"] = _g(9)
        result["l2_current_lower"] = _g(10)
        result["l3_voltage_upper"] = _g(11)
        result["l3_voltage_lower"] = _g(12)
        result["l3_current_upper"] = _g(13)
        result["l3_current_lower"] = _g(14)
        result["neutral_line"] = _g(15)
        result["phase_unbalance"] = _g(16)

        result["temp1_upper"] = _g(17)
        result["temp1_lower"] = _g(18)
        result["hum1_upper"] = _g(19)
        result["hum1_lower"] = _g(20)
        result["temp2_upper"] = _g(21)
        result["temp2_lower"] = _g(22)
        result["hum2_upper"] = _g(23)
        result["hum2_lower"] = _g(24)
        result["temp3_upper"] = _g(25)
        result["temp3_lower"] = _g(26)
        result["hum3_upper"] = _g(27)
        result["hum3_lower"] = _g(28)
        result["temp4_upper"] = _g(29)
        result["temp4_lower"] = _g(30)
        result["hum4_upper"] = _g(31)
        result["hum4_lower"] = _g(32)

        # CSRF token is typically the last meaningful field
        for i in range(len(f) - 1, max(len(f) - 5, 32), -1):
            val = f[i].strip() if i < len(f) else ""
            if len(val) >= 10 and val.isalnum():
                result["csrf_token"] = val
                break
        else:
            result["csrf_token"] = ""

        return result

    def set_alarm_thresholds(self, **kwargs) -> bool:
        """Write alarm thresholds.  Accepts any subset of the fields
        returned by get_alarm_thresholds(); unspecified fields keep
        their current values."""
        with self._lock:
            cur = self.get_alarm_thresholds()
            csrf = cur.get("csrf_token", "")

            def _v(key: str) -> str:
                return str(kwargs[key]) if key in kwargs else str(cur.get(key, ""))

            data = {
                "switch_netset_csrftoken2": csrf,
                "BeepAlarm": _v("beep_alarm"),
                "L1_Voltage_Upper": _v("l1_voltage_upper"),
                "L1_Voltage_Lower": _v("l1_voltage_lower"),
                "L1_Current_Upper": _v("l1_current_upper"),
                "L1_Current_Lower": _v("l1_current_lower"),
                "L2_Voltage_Upper": _v("l2_voltage_upper"),
                "L2_Voltage_Lower": _v("l2_voltage_lower"),
                "L2_Current_Upper": _v("l2_current_upper"),
                "L2_Current_Lower": _v("l2_current_lower"),
                "L3_Voltage_Upper": _v("l3_voltage_upper"),
                "L3_Voltage_Lower": _v("l3_voltage_lower"),
                "L3_Current_Upper": _v("l3_current_upper"),
                "L3_Current_Lower": _v("l3_current_lower"),
                "Neutral_Line": _v("neutral_line"),
                "Phase_Unbalance": _v("phase_unbalance"),
                "Temp1_Upper": _v("temp1_upper"),
                "Temp1_Lower": _v("temp1_lower"),
                "Hum1_Upper": _v("hum1_upper"),
                "Hum1_Lower": _v("hum1_lower"),
                "Temp2_Upper": _v("temp2_upper"),
                "Temp2_Lower": _v("temp2_lower"),
                "Hum2_Upper": _v("hum2_upper"),
                "Hum2_Lower": _v("hum2_lower"),
                "Temp3_Upper": _v("temp3_upper"),
                "Temp3_Lower": _v("temp3_lower"),
                "Hum3_Upper": _v("hum3_upper"),
                "Hum3_Lower": _v("hum3_lower"),
                "Temp4_Upper": _v("temp4_upper"),
                "Temp4_Lower": _v("temp4_lower"),
                "Hum4_Upper": _v("hum4_upper"),
                "Hum4_Lower": _v("hum4_lower"),
            }

            resp = self._post_cgi("parameter_cfg_set.cgi", data)
            return "404" not in resp

    # ------------------------------------------------------------------
    # All settings in one call
    # ------------------------------------------------------------------

    def get_all_settings(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "device": self.get_device_info(),
                "network": self.get_network_config(),
                "snmp": self.get_snmp_config(),
                "time": self.get_time_config(),
                "alarm_thresholds": self.get_alarm_thresholds(),
            }
