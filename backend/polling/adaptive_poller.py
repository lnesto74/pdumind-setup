"""
Adaptive Poller - Main integration module for the adaptive polling system.

This module replaces the fixed-interval multi_pdu_poller with an efficient
adaptive system that:
- Reduces SNMP traffic for offline/idle devices
- Increases polling for active/alarmed devices
- Uses state machines for per-device polling decisions
- Persists device states and metrics
"""

import time
import threading
from typing import Dict, Any, Optional, Callable, List
from dataclasses import dataclass

from .device_state import DeviceState, DeviceStateManager, DeviceStateConfig
from .oid_profiles import OidGroup, OidProfiles
from .snmp_client import SnmpClient, SnmpConfig
from .scheduler import PollScheduler, SchedulerConfig


@dataclass
class AdaptivePollerConfig:
    """Configuration for the adaptive poller."""
    # Database
    db_path: str = "data/pdumind.db"
    
    # Concurrency
    max_workers: int = 30
    
    # SNMP settings
    snmp_community: str = "private"
    snmp_version: str = "2c"
    
    # State thresholds
    offline_after_fails: int = 3
    idle_load_threshold_w: float = 10.0
    active_load_threshold_w: float = 50.0
    load_delta_threshold_w: float = 5.0
    
    # Polling intervals (seconds)
    offline_health_interval: float = 15.0
    offline_backoff_max: float = 900.0  # 15 min
    
    idle_health_interval: float = 60.0
    idle_core_interval: float = 120.0
    idle_outlets_interval: float = 300.0
    
    active_health_interval: float = 30.0
    active_core_interval: float = 10.0
    active_outlets_interval: float = 30.0
    
    alarm_core_interval: float = 5.0
    alarm_duration: float = 120.0


class AdaptivePoller:
    """Main adaptive polling system."""
    
    def __init__(self, config: AdaptivePollerConfig = None,
                 on_telemetry: Callable[[str, Dict], None] = None):
        self.config = config or AdaptivePollerConfig()
        self._on_telemetry = on_telemetry
        
        # Build component configs
        state_config = DeviceStateConfig()
        state_config.OFFLINE_AFTER_FAILS = self.config.offline_after_fails
        state_config.IDLE_LOAD_THRESHOLD = self.config.idle_load_threshold_w
        state_config.ACTIVE_LOAD_THRESHOLD = self.config.active_load_threshold_w
        state_config.LOAD_DELTA_THRESHOLD = self.config.load_delta_threshold_w
        state_config.OFFLINE_HEALTH_INTERVAL = self.config.offline_health_interval
        state_config.BACKOFF_MAX = self.config.offline_backoff_max
        state_config.IDLE_HEALTH_INTERVAL = self.config.idle_health_interval
        state_config.IDLE_CORE_INTERVAL = self.config.idle_core_interval
        state_config.IDLE_OUTLETS_INTERVAL = self.config.idle_outlets_interval
        state_config.ACTIVE_HEALTH_INTERVAL = self.config.active_health_interval
        state_config.ACTIVE_CORE_INTERVAL = self.config.active_core_interval
        state_config.ACTIVE_OUTLETS_INTERVAL = self.config.active_outlets_interval
        state_config.ALARM_CORE_INTERVAL = self.config.alarm_core_interval
        state_config.ALARM_DURATION = self.config.alarm_duration
        
        snmp_config = SnmpConfig()
        snmp_config.community = self.config.snmp_community
        snmp_config.version = self.config.snmp_version
        snmp_config.max_concurrent_requests = self.config.max_workers
        
        scheduler_config = SchedulerConfig()
        scheduler_config.max_workers = self.config.max_workers
        
        # Initialize components
        self.state_manager = DeviceStateManager(self.config.db_path, state_config)
        self.snmp_client = SnmpClient(snmp_config)
        self.scheduler = PollScheduler(self.state_manager, self.snmp_client, scheduler_config)
        
        # Set callbacks
        self.scheduler.set_callbacks(
            on_complete=self._handle_poll_complete,
            on_error=self._handle_poll_error
        )
        
        # Live results cache (for API compatibility)
        self._live_results: Dict[str, Dict[str, Any]] = {}
        self._live_errors: Dict[str, Dict[str, Any]] = {}
        self._results_lock = threading.Lock()
        
        self._running = False
    
    def _handle_poll_complete(self, ip: str, results: Dict[str, Any]):
        """Handle successful poll completion."""
        with self._results_lock:
            self._live_results[ip] = results
            self._live_errors[ip] = {}
        
        # Call external telemetry handler
        if self._on_telemetry:
            try:
                self._on_telemetry(ip, results)
            except Exception as e:
                print(f"[AdaptivePoller] Telemetry callback error: {e}")
    
    def _handle_poll_error(self, ip: str, error: str):
        """Handle poll error."""
        with self._results_lock:
            self._live_errors[ip] = {"error": error, "timestamp": time.time()}
    
    def add_device(self, ip_address: str, port: int = 161):
        """Add a device to be polled."""
        self.state_manager.get_or_create(ip_address, port)
        self.scheduler.schedule_device(ip_address, port, {OidGroup.HEALTH, OidGroup.CORE})
    
    def add_devices_from_db(self, pdu_list: List[Dict[str, Any]]):
        """Add multiple devices from database PDU list."""
        for pdu in pdu_list:
            ip = pdu.get("ip_address")
            port = pdu.get("snmp_port", 161)
            if ip:
                self.add_device(ip, port)
        
        print(f"[AdaptivePoller] Added {len(pdu_list)} devices")
    
    def start(self):
        """Start the adaptive poller."""
        if self._running:
            return
        
        self._running = True
        self.scheduler.start()
        self.scheduler.schedule_all_devices()
        print("[AdaptivePoller] Started adaptive polling system")
    
    def stop(self):
        """Stop the adaptive poller."""
        self._running = False
        self.scheduler.stop()
        self.snmp_client.shutdown()
        print("[AdaptivePoller] Stopped")
    
    def trigger_immediate_poll(self, ip_address: str):
        """Trigger immediate poll for a device."""
        status = self.state_manager.get_device(ip_address)
        port = status.port if status else 161
        self.scheduler.trigger_immediate_poll(ip_address, port)
    
    def get_live_data(self, ip_address: str) -> Dict[str, Any]:
        """Get live telemetry data for a device (API compatibility)."""
        with self._results_lock:
            results = self._live_results.get(ip_address, {})
            errors = self._live_errors.get(ip_address, {})
        
        status = self.state_manager.get_device(ip_address)
        
        if not results and not errors:
            if not status:
                return {"error": "Device not found", "ip": ip_address}
            return {
                "ip": ip_address,
                "results": [],
                "errors": [],
                "status": "pending",
                "message": "Waiting for first poll cycle"
            }
        
        return {
            "ip": ip_address,
            "results": list(results.values()) if isinstance(results, dict) else results,
            "errors": [errors] if errors else [],
            "status": "error" if errors else ("partial" if not results else "success"),
            "device_state": status.state.value if status else "unknown",
            "last_poll_at": status.last_poll_at if status else 0,
            "avg_latency_ms": status.avg_latency_ms if status else 0
        }
    
    def get_all_live_data(self) -> Dict[str, Dict[str, Any]]:
        """Get live data for all devices."""
        with self._results_lock:
            return {ip: self.get_live_data(ip) for ip in self._live_results.keys()}
    
    def get_device_status(self, ip_address: str) -> Optional[Dict[str, Any]]:
        """Get device polling status."""
        status = self.state_manager.get_device(ip_address)
        if not status:
            return None
        
        schedule = self.scheduler.get_device_schedule(ip_address)
        
        return {
            "ip_address": status.ip_address,
            "state": status.state.value,
            "last_seen_at": status.last_seen_at,
            "last_ok_at": status.last_ok_at,
            "last_fail_at": status.last_fail_at,
            "fail_count": status.fail_count,
            "consecutive_fails": status.consecutive_fails,
            "backoff_sec": status.backoff_sec,
            "last_load_w": status.last_load_w,
            "active_outlets": list(status.active_outlets),
            "total_polls": status.total_polls,
            "successful_polls": status.successful_polls,
            "avg_latency_ms": status.avg_latency_ms,
            "schedule": schedule
        }
    
    def get_stats(self) -> Dict[str, Any]:
        """Get comprehensive polling statistics."""
        state_stats = self.state_manager.get_stats()
        queue_stats = self.scheduler.get_queue_status()
        snmp_stats = self.snmp_client.get_metrics()
        
        return {
            "devices": state_stats,
            "scheduler": queue_stats,
            "snmp": snmp_stats,
            "running": self._running
        }
    
    def get_devices_by_state(self) -> Dict[str, List[str]]:
        """Get device IPs grouped by state."""
        result = {s.value: [] for s in DeviceState}
        
        for status in self.state_manager.get_all_devices():
            result[status.state.value].append(status.ip_address)
        
        return result


# Global singleton instance
_adaptive_poller: Optional[AdaptivePoller] = None
_poller_lock = threading.Lock()


def get_adaptive_poller(config: AdaptivePollerConfig = None,
                        on_telemetry: Callable = None) -> AdaptivePoller:
    """Get or create the global adaptive poller instance."""
    global _adaptive_poller
    
    with _poller_lock:
        if _adaptive_poller is None:
            _adaptive_poller = AdaptivePoller(config, on_telemetry)
        return _adaptive_poller


def ensure_adaptive_poller(pdu_list: List[Dict[str, Any]] = None,
                           on_telemetry: Callable = None) -> AdaptivePoller:
    """Ensure adaptive poller is running with devices loaded."""
    poller = get_adaptive_poller(on_telemetry=on_telemetry)
    
    if pdu_list:
        poller.add_devices_from_db(pdu_list)
    
    if not poller._running:
        poller.start()
    
    return poller
