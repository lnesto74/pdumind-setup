"""
Device State Manager - State machine for adaptive polling decisions.

States:
- OFFLINE: Device unreachable, exponential backoff for health checks only
- ONLINE_IDLE: Device reachable but no significant load, reduced polling
- ONLINE_ACTIVE: Device with active load, frequent polling
- ALARM: Device with active alarm, aggressive polling

Transitions are based on:
- Health check success/failure
- Load thresholds and deltas
- Alarm OID values
"""

import time
import json
import sqlite3
import threading
from enum import Enum
from dataclasses import dataclass, field, asdict
from typing import Dict, Optional, List, Any, Set
from datetime import datetime


class DeviceState(Enum):
    OFFLINE = "offline"
    ONLINE_IDLE = "online_idle"
    ONLINE_ACTIVE = "online_active"
    ALARM = "alarm"


@dataclass
class DeviceStatus:
    """Per-device status tracking."""
    ip_address: str
    port: int = 161
    state: DeviceState = DeviceState.OFFLINE
    
    # Timing
    last_seen_at: float = 0.0
    last_ok_at: float = 0.0
    last_fail_at: float = 0.0
    last_poll_at: float = 0.0
    
    # Failure tracking
    fail_count: int = 0
    consecutive_fails: int = 0
    
    # Backoff for offline devices (seconds)
    backoff_sec: float = 15.0
    next_poll_at: float = 0.0
    
    # Load tracking
    last_load_w: float = 0.0
    last_load_delta: float = 0.0
    load_history: List[float] = field(default_factory=list)
    
    # Active outlets tracking
    active_outlets: Set[int] = field(default_factory=set)
    last_active_at: float = 0.0
    
    # Device info
    sys_uptime: int = 0
    sys_name: str = ""
    vendor_profile: str = "schleifenbauer"  # Default to Schleifenbauer for this deployment
    
    # Alarm tracking
    alarm_active: bool = False
    alarm_start_at: float = 0.0
    alarm_codes: List[str] = field(default_factory=list)
    
    # Poll group scheduling
    next_health_at: float = 0.0
    next_core_at: float = 0.0
    next_outlets_at: float = 0.0
    next_extended_at: float = 0.0
    
    # Metrics
    total_polls: int = 0
    successful_polls: int = 0
    avg_latency_ms: float = 0.0


class DeviceStateConfig:
    """Configuration for state machine behavior."""
    
    # Failure thresholds
    OFFLINE_AFTER_FAILS = 3  # Mark offline after N consecutive failures
    
    # Backoff settings (seconds) - increased to reduce load when devices offline
    BACKOFF_INITIAL = 60.0  # Start at 1 minute
    BACKOFF_MAX = 1800.0  # 30 minutes max
    BACKOFF_MULTIPLIER = 2.0
    
    # Load thresholds (watts)
    IDLE_LOAD_THRESHOLD = 10.0  # Below this = idle
    ACTIVE_LOAD_THRESHOLD = 50.0  # Above this = definitely active
    LOAD_DELTA_THRESHOLD = 5.0  # Change threshold to trigger active
    
    # Polling intervals (seconds) - optimized for near real-time telemetry
    OFFLINE_HEALTH_INTERVAL = 30.0  # Initial, then backoff
    
    IDLE_HEALTH_INTERVAL = 10.0
    IDLE_CORE_INTERVAL = 2.0  # Fast core telemetry
    IDLE_OUTLETS_INTERVAL = 2.0  # Fast outlet polling
    
    ACTIVE_HEALTH_INTERVAL = 10.0
    ACTIVE_CORE_INTERVAL = 1.0  # ~1 poll/sec for active devices
    ACTIVE_OUTLETS_INTERVAL = 1.0  # ~1 poll/sec for outlets
    ACTIVE_EXTENDED_INTERVAL = 30.0
    
    ALARM_CORE_INTERVAL = 1.0  # Fastest for alarms
    ALARM_DURATION = 120.0  # Stay in alarm mode for 2 minutes
    
    # History settings
    LOAD_HISTORY_SIZE = 10


class DeviceStateManager:
    """Manages device states and transitions for adaptive polling."""
    
    def __init__(self, db_path: str = "data/pdumind.db", config: DeviceStateConfig = None):
        self.db_path = db_path
        self.config = config or DeviceStateConfig()
        self.devices: Dict[str, DeviceStatus] = {}
        self._lock = threading.RLock()
        self._init_db()
        self._load_from_db()
    
    def _init_db(self):
        """Initialize device state table in database."""
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS device_poll_state (
                ip_address TEXT PRIMARY KEY,
                port INTEGER DEFAULT 161,
                state TEXT DEFAULT 'offline',
                last_seen_at REAL DEFAULT 0,
                last_ok_at REAL DEFAULT 0,
                last_fail_at REAL DEFAULT 0,
                fail_count INTEGER DEFAULT 0,
                consecutive_fails INTEGER DEFAULT 0,
                backoff_sec REAL DEFAULT 15,
                last_load_w REAL DEFAULT 0,
                sys_uptime INTEGER DEFAULT 0,
                sys_name TEXT DEFAULT '',
                vendor_profile TEXT DEFAULT 'schleifenbauer',
                alarm_active INTEGER DEFAULT 0,
                active_outlets_json TEXT DEFAULT '[]',
                total_polls INTEGER DEFAULT 0,
                successful_polls INTEGER DEFAULT 0,
                avg_latency_ms REAL DEFAULT 0,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # Update existing rows to use schleifenbauer profile
        conn.execute("UPDATE device_poll_state SET vendor_profile = 'schleifenbauer' WHERE vendor_profile = 'generic'")
        conn.commit()
        conn.close()
    
    def _load_from_db(self):
        """Load device states from database."""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM device_poll_state").fetchall()
        conn.close()
        
        with self._lock:
            for row in rows:
                status = DeviceStatus(
                    ip_address=row["ip_address"],
                    port=row["port"],
                    state=DeviceState(row["state"]),
                    last_seen_at=row["last_seen_at"],
                    last_ok_at=row["last_ok_at"],
                    last_fail_at=row["last_fail_at"],
                    fail_count=row["fail_count"],
                    consecutive_fails=row["consecutive_fails"],
                    backoff_sec=row["backoff_sec"],
                    last_load_w=row["last_load_w"],
                    sys_uptime=row["sys_uptime"],
                    sys_name=row["sys_name"],
                    vendor_profile=row["vendor_profile"],
                    alarm_active=bool(row["alarm_active"]),
                    total_polls=row["total_polls"],
                    successful_polls=row["successful_polls"],
                    avg_latency_ms=row["avg_latency_ms"]
                )
                try:
                    status.active_outlets = set(json.loads(row["active_outlets_json"]))
                except:
                    status.active_outlets = set()
                self.devices[row["ip_address"]] = status
    
    def _save_device(self, status: DeviceStatus):
        """Persist device state to database."""
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            INSERT OR REPLACE INTO device_poll_state 
            (ip_address, port, state, last_seen_at, last_ok_at, last_fail_at,
             fail_count, consecutive_fails, backoff_sec, last_load_w,
             sys_uptime, sys_name, vendor_profile, alarm_active,
             active_outlets_json, total_polls, successful_polls, avg_latency_ms, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            status.ip_address, status.port, status.state.value,
            status.last_seen_at, status.last_ok_at, status.last_fail_at,
            status.fail_count, status.consecutive_fails, status.backoff_sec,
            status.last_load_w, status.sys_uptime, status.sys_name,
            status.vendor_profile, int(status.alarm_active),
            json.dumps(list(status.active_outlets)),
            status.total_polls, status.successful_polls, status.avg_latency_ms,
            datetime.utcnow().isoformat()
        ))
        conn.commit()
        conn.close()
    
    def get_or_create(self, ip_address: str, port: int = 161) -> DeviceStatus:
        """Get existing device status or create new one."""
        with self._lock:
            if ip_address not in self.devices:
                self.devices[ip_address] = DeviceStatus(ip_address=ip_address, port=port)
                self._save_device(self.devices[ip_address])
            return self.devices[ip_address]
    
    def get_device(self, ip_address: str) -> Optional[DeviceStatus]:
        """Get device status if exists."""
        with self._lock:
            return self.devices.get(ip_address)
    
    def get_all_devices(self) -> List[DeviceStatus]:
        """Get all tracked devices."""
        with self._lock:
            return list(self.devices.values())
    
    def record_poll_success(self, ip_address: str, latency_ms: float, 
                            results: Dict[str, Any]) -> DeviceStatus:
        """Record successful poll and update state."""
        now = time.time()
        
        with self._lock:
            status = self.get_or_create(ip_address)
            status.last_seen_at = now
            status.last_ok_at = now
            status.last_poll_at = now
            status.consecutive_fails = 0
            status.total_polls += 1
            status.successful_polls += 1
            
            # Update rolling average latency
            alpha = 0.2
            status.avg_latency_ms = (alpha * latency_ms + 
                                     (1 - alpha) * status.avg_latency_ms)
            
            # Reset backoff on success
            status.backoff_sec = self.config.BACKOFF_INITIAL
            
            # Extract load from results
            load_w = self._extract_load(results)
            if load_w is not None:
                status.last_load_delta = abs(load_w - status.last_load_w)
                status.last_load_w = load_w
                status.load_history.append(load_w)
                if len(status.load_history) > self.config.LOAD_HISTORY_SIZE:
                    status.load_history.pop(0)
            
            # Extract active outlets
            active = self._extract_active_outlets(results)
            if active:
                status.active_outlets = active
                status.last_active_at = now
            
            # Check for alarms
            alarm_active = self._check_alarms(results)
            if alarm_active and not status.alarm_active:
                status.alarm_active = True
                status.alarm_start_at = now
            
            # Determine new state
            new_state = self._determine_state(status)
            if new_state != status.state:
                print(f"[DeviceState] {ip_address}: {status.state.value} -> {new_state.value}")
                status.state = new_state
            
            # Schedule next polls based on state
            self._schedule_polls(status)
            self._save_device(status)
            
            return status
    
    def record_poll_failure(self, ip_address: str, error: str = None) -> DeviceStatus:
        """Record failed poll and update state."""
        now = time.time()
        
        with self._lock:
            status = self.get_or_create(ip_address)
            status.last_fail_at = now
            status.last_poll_at = now
            status.fail_count += 1
            status.consecutive_fails += 1
            status.total_polls += 1
            
            # Check if should go offline
            if status.consecutive_fails >= self.config.OFFLINE_AFTER_FAILS:
                if status.state != DeviceState.OFFLINE:
                    print(f"[DeviceState] {ip_address}: {status.state.value} -> offline (fails={status.consecutive_fails})")
                    status.state = DeviceState.OFFLINE
                
                # Increase backoff
                status.backoff_sec = min(
                    status.backoff_sec * self.config.BACKOFF_MULTIPLIER,
                    self.config.BACKOFF_MAX
                )
            
            # Schedule next poll with backoff
            status.next_poll_at = now + status.backoff_sec
            status.next_health_at = status.next_poll_at
            
            self._save_device(status)
            return status
    
    def _extract_load(self, results: Dict[str, Any]) -> Optional[float]:
        """Extract total load from poll results."""
        for key in ["TotalPower", "TotalCurrent", "InputPower"]:
            if key in results:
                val = results[key]
                if isinstance(val, dict):
                    val = val.get("value")
                if val:
                    try:
                        return float(str(val).replace('"', ''))
                    except:
                        pass
        return None
    
    def _extract_active_outlets(self, results: Dict[str, Any]) -> Set[int]:
        """Extract set of active outlet numbers from results."""
        active = set()
        for key, val in results.items():
            if "Current" in key and "Output" in key:
                try:
                    outlet_num = int(''.join(filter(str.isdigit, key.split("Output")[1].split("Current")[0])))
                    value = val.get("value") if isinstance(val, dict) else val
                    current = float(str(value).replace('"', ''))
                    if current > 0.1:  # More than 0.1A = active
                        active.add(outlet_num)
                except:
                    pass
        return active
    
    def _check_alarms(self, results: Dict[str, Any]) -> bool:
        """Check if any alarm conditions present in results."""
        alarm_keywords = ["alarm", "warning", "critical", "fault", "error"]
        for key, val in results.items():
            key_lower = key.lower()
            if any(kw in key_lower for kw in alarm_keywords):
                value = val.get("value") if isinstance(val, dict) else val
                if value and str(value).lower() not in ["0", "none", "ok", "normal", '""']:
                    return True
        return False
    
    def _determine_state(self, status: DeviceStatus) -> DeviceState:
        """Determine device state based on current metrics."""
        now = time.time()
        
        # Check alarm timeout
        if status.alarm_active:
            if now - status.alarm_start_at < self.config.ALARM_DURATION:
                return DeviceState.ALARM
            else:
                status.alarm_active = False
        
        # Check load levels
        load = status.last_load_w
        delta = status.last_load_delta
        
        if load > self.config.ACTIVE_LOAD_THRESHOLD:
            return DeviceState.ONLINE_ACTIVE
        
        if delta > self.config.LOAD_DELTA_THRESHOLD:
            return DeviceState.ONLINE_ACTIVE
        
        if status.active_outlets and now - status.last_active_at < 300:
            return DeviceState.ONLINE_ACTIVE
        
        if load < self.config.IDLE_LOAD_THRESHOLD:
            return DeviceState.ONLINE_IDLE
        
        # Default to idle for moderate load
        return DeviceState.ONLINE_IDLE
    
    def _schedule_polls(self, status: DeviceStatus):
        """Schedule next poll times based on current state."""
        now = time.time()
        cfg = self.config
        
        if status.state == DeviceState.OFFLINE:
            status.next_health_at = now + status.backoff_sec
            status.next_core_at = 0  # No core polling when offline
            status.next_outlets_at = 0
            status.next_extended_at = 0
            
        elif status.state == DeviceState.ONLINE_IDLE:
            status.next_health_at = now + cfg.IDLE_HEALTH_INTERVAL
            status.next_core_at = now + cfg.IDLE_CORE_INTERVAL
            status.next_outlets_at = now + cfg.IDLE_OUTLETS_INTERVAL
            status.next_extended_at = now + cfg.IDLE_OUTLETS_INTERVAL * 2
            
        elif status.state == DeviceState.ONLINE_ACTIVE:
            status.next_health_at = now + cfg.ACTIVE_HEALTH_INTERVAL
            status.next_core_at = now + cfg.ACTIVE_CORE_INTERVAL
            status.next_outlets_at = now + cfg.ACTIVE_OUTLETS_INTERVAL
            status.next_extended_at = now + cfg.ACTIVE_EXTENDED_INTERVAL
            
        elif status.state == DeviceState.ALARM:
            status.next_health_at = now + cfg.ALARM_CORE_INTERVAL
            status.next_core_at = now + cfg.ALARM_CORE_INTERVAL
            status.next_outlets_at = now + cfg.ALARM_CORE_INTERVAL * 2
            status.next_extended_at = now + cfg.ALARM_CORE_INTERVAL * 4
        
        status.next_poll_at = min(
            t for t in [status.next_health_at, status.next_core_at] if t > 0
        )
    
    def get_devices_due_for_poll(self, group: str = "health") -> List[DeviceStatus]:
        """Get devices that are due for polling a specific group."""
        now = time.time()
        due = []
        
        with self._lock:
            for status in self.devices.values():
                if group == "health" and status.next_health_at <= now:
                    due.append(status)
                elif group == "core" and status.next_core_at <= now and status.state != DeviceState.OFFLINE:
                    due.append(status)
                elif group == "outlets" and status.next_outlets_at <= now and status.state in [DeviceState.ONLINE_ACTIVE, DeviceState.ALARM]:
                    due.append(status)
                elif group == "extended" and status.next_extended_at <= now and status.state == DeviceState.ONLINE_ACTIVE:
                    due.append(status)
        
        return due
    
    def get_stats(self) -> Dict[str, Any]:
        """Get aggregate statistics."""
        with self._lock:
            states = {s.value: 0 for s in DeviceState}
            total_polls = 0
            successful_polls = 0
            
            for status in self.devices.values():
                states[status.state.value] += 1
                total_polls += status.total_polls
                successful_polls += status.successful_polls
            
            return {
                "total_devices": len(self.devices),
                "states": states,
                "total_polls": total_polls,
                "successful_polls": successful_polls,
                "success_rate": successful_polls / total_polls if total_polls > 0 else 0
            }
