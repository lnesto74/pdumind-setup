"""
SNMP Client - Wrapper with timeouts, GETBULK, retries, and instrumentation.

Features:
- Configurable timeouts and retries per operation type
- GETBULK for efficient table retrieval
- Request instrumentation and metrics
- Cancellation support
"""

import subprocess
import time
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Any
from concurrent.futures import ThreadPoolExecutor, Future
from enum import Enum


class SnmpOperation(Enum):
    GET = "get"
    GETBULK = "getbulk"
    WALK = "walk"


@dataclass
class SnmpConfig:
    """SNMP client configuration."""
    community: str = "private"
    version: str = "2c"
    
    # Timeouts (seconds)
    health_timeout: float = 2.0
    health_retries: int = 1
    
    core_timeout: float = 3.0
    core_retries: int = 2
    
    outlet_timeout: float = 5.0
    outlet_retries: int = 2
    
    bulk_timeout: float = 10.0
    bulk_retries: int = 2
    bulk_max_repetitions: int = 25  # Max rows per GETBULK
    
    # Concurrency
    max_concurrent_requests: int = 30


@dataclass
class SnmpMetrics:
    """SNMP operation metrics."""
    total_requests: int = 0
    successful_requests: int = 0
    failed_requests: int = 0
    timeout_count: int = 0
    total_latency_ms: float = 0.0
    requests_per_operation: Dict[str, int] = field(default_factory=dict)
    
    @property
    def avg_latency_ms(self) -> float:
        if self.successful_requests == 0:
            return 0.0
        return self.total_latency_ms / self.successful_requests
    
    @property
    def success_rate(self) -> float:
        if self.total_requests == 0:
            return 0.0
        return self.successful_requests / self.total_requests


class SnmpClient:
    """SNMP client with instrumentation and efficient batching."""
    
    def __init__(self, config: SnmpConfig = None):
        self.config = config or SnmpConfig()
        self.metrics = SnmpMetrics()
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=self.config.max_concurrent_requests)
        self._active_requests: Dict[str, Future] = {}  # ip -> future
    
    def _run_snmp_command(self, cmd: List[str], timeout: float) -> Tuple[bool, str, float]:
        """Execute SNMP command and return (success, output, latency_ms)."""
        start = time.time()
        try:
            result = subprocess.run(
                cmd, 
                capture_output=True, 
                text=True, 
                timeout=timeout
            )
            latency_ms = (time.time() - start) * 1000
            
            if result.returncode != 0:
                return False, result.stderr.strip(), latency_ms
            
            return True, result.stdout.strip(), latency_ms
            
        except subprocess.TimeoutExpired:
            latency_ms = (time.time() - start) * 1000
            with self._lock:
                self.metrics.timeout_count += 1
            return False, "Timeout", latency_ms
        except Exception as e:
            latency_ms = (time.time() - start) * 1000
            return False, str(e), latency_ms
    
    def _record_request(self, operation: str, success: bool, latency_ms: float):
        """Record request metrics."""
        with self._lock:
            self.metrics.total_requests += 1
            if success:
                self.metrics.successful_requests += 1
                self.metrics.total_latency_ms += latency_ms
            else:
                self.metrics.failed_requests += 1
            
            op_key = operation
            self.metrics.requests_per_operation[op_key] = \
                self.metrics.requests_per_operation.get(op_key, 0) + 1
    
    def health_check(self, ip: str, port: int = 161) -> Tuple[bool, Dict[str, str], float]:
        """Quick health check with minimal OIDs and low timeout."""
        oids = [
            ".1.3.6.1.2.1.1.3.0",  # sysUpTime
            ".1.3.6.1.2.1.1.5.0",  # sysName
        ]
        
        cmd = [
            "snmpget",
            f"-v{self.config.version}",
            "-c", self.config.community,
            "-t", str(int(self.config.health_timeout)),
            "-r", str(self.config.health_retries),
            "-Oqv", "-Oe",
            f"{ip}:{port}"
        ] + oids
        
        success, output, latency_ms = self._run_snmp_command(
            cmd, 
            self.config.health_timeout * (self.config.health_retries + 1)
        )
        
        self._record_request("health", success, latency_ms)
        
        results = {}
        if success:
            lines = output.strip().split('\n')
            for i, oid in enumerate(oids):
                if i < len(lines):
                    name = "sysUpTime" if "1.3.0" in oid else "sysName"
                    results[name] = lines[i]
        
        return success, results, latency_ms
    
    def get_batch(self, ip: str, port: int, oids: List[str],
                  timeout: float = None, retries: int = None) -> Tuple[bool, Dict[str, str], float]:
        """Fetch multiple OIDs in a single SNMPGET call."""
        if not oids:
            return True, {}, 0.0
        
        timeout = timeout or self.config.core_timeout
        retries = retries if retries is not None else self.config.core_retries
        
        cmd = [
            "snmpget",
            f"-v{self.config.version}",
            "-c", self.config.community,
            "-t", str(int(timeout)),
            "-r", str(retries),
            "-Oqv", "-Oe",
            f"{ip}:{port}"
        ] + oids
        
        success, output, latency_ms = self._run_snmp_command(
            cmd,
            timeout * (retries + 1)
        )
        
        self._record_request("get_batch", success, latency_ms)
        
        results = {}
        if success:
            lines = output.strip().split('\n')
            for i, oid in enumerate(oids):
                if i < len(lines):
                    results[oid] = lines[i]
        
        return success, results, latency_ms
    
    def get_bulk(self, ip: str, port: int, base_oid: str,
                 max_repetitions: int = None) -> Tuple[bool, Dict[str, str], float]:
        """Use GETBULK for efficient table retrieval."""
        max_rep = max_repetitions or self.config.bulk_max_repetitions
        
        cmd = [
            "snmpbulkget",
            f"-v{self.config.version}",
            "-c", self.config.community,
            "-t", str(int(self.config.bulk_timeout)),
            "-r", str(self.config.bulk_retries),
            "-Cn0",  # Non-repeaters = 0
            f"-Cr{max_rep}",  # Max-repetitions
            "-OQn",  # Numeric OIDs, quick print
            f"{ip}:{port}",
            base_oid
        ]
        
        success, output, latency_ms = self._run_snmp_command(
            cmd,
            self.config.bulk_timeout * (self.config.bulk_retries + 1)
        )
        
        self._record_request("getbulk", success, latency_ms)
        
        results = {}
        if success:
            for line in output.strip().split('\n'):
                if '=' in line:
                    parts = line.split('=', 1)
                    if len(parts) == 2:
                        oid = parts[0].strip()
                        value = parts[1].strip()
                        # Only include OIDs under the base OID
                        if oid.startswith(base_oid):
                            results[oid] = value
        
        return success, results, latency_ms
    
    def poll_outlets_bulk(self, ip: str, port: int, 
                          outlet_bases: List[Tuple[str, str]],
                          outlet_count: int = 24) -> Tuple[bool, Dict[str, Any], float]:
        """Poll outlet tables using GETBULK for efficiency.
        
        Args:
            outlet_bases: List of (name, base_oid) tuples
            outlet_count: Number of outlets to expect
        """
        all_results = {}
        total_latency = 0.0
        any_success = False
        
        for name, base_oid in outlet_bases:
            success, results, latency = self.get_bulk(ip, port, base_oid, outlet_count + 2)
            total_latency += latency
            
            if success:
                any_success = True
                # Parse results into named format
                for oid, value in results.items():
                    # Extract outlet number from OID suffix
                    suffix = oid[len(base_oid):].strip('.')
                    parts = suffix.split('.')
                    if parts:
                        try:
                            outlet_num = int(parts[0])
                            key = f"{name}{outlet_num}"
                            all_results[key] = {"name": key, "oid": oid, "value": value}
                        except ValueError:
                            pass
        
        return any_success, all_results, total_latency
    
    def poll_device(self, ip: str, port: int, 
                    health_oids: List[str] = None,
                    core_oids: List[str] = None,
                    outlet_bases: List[Tuple[str, str]] = None,
                    active_outlets_only: bool = False,
                    active_outlets: set = None) -> Tuple[bool, Dict[str, Any], float]:
        """Full device poll with configurable groups."""
        all_results = {}
        total_latency = 0.0
        any_success = False
        
        # Health check
        if health_oids:
            success, results, latency = self.get_batch(
                ip, port, health_oids,
                timeout=self.config.health_timeout,
                retries=self.config.health_retries
            )
            total_latency += latency
            if success:
                any_success = True
                for oid, value in results.items():
                    name = "sysUpTime" if "1.3.0" in oid else "sysName" if "1.5.0" in oid else oid
                    all_results[name] = {"name": name, "oid": oid, "value": value}
        
        # Core OIDs
        if core_oids:
            success, results, latency = self.get_batch(
                ip, port, core_oids,
                timeout=self.config.core_timeout,
                retries=self.config.core_retries
            )
            total_latency += latency
            if success:
                any_success = True
                for oid, value in results.items():
                    # Extract meaningful name from OID
                    name = self._oid_to_name(oid)
                    all_results[name] = {"name": name, "oid": oid, "value": value}
        
        # Outlets (use GETBULK for efficiency)
        if outlet_bases:
            if active_outlets_only and active_outlets:
                # Poll only specific outlets with GET
                outlet_oids = []
                for name, base in outlet_bases:
                    for outlet_num in active_outlets:
                        outlet_oids.append(f"{base}.{outlet_num}.0")
                
                if outlet_oids:
                    success, results, latency = self.get_batch(
                        ip, port, outlet_oids,
                        timeout=self.config.outlet_timeout,
                        retries=self.config.outlet_retries
                    )
                    total_latency += latency
                    if success:
                        any_success = True
                        for oid, value in results.items():
                            name = self._oid_to_name(oid)
                            all_results[name] = {"name": name, "oid": oid, "value": value}
            else:
                # Full outlet poll with GETBULK
                success, results, latency = self.poll_outlets_bulk(ip, port, outlet_bases)
                total_latency += latency
                if success:
                    any_success = True
                    all_results.update(results)
        
        return any_success, all_results, total_latency
    
    def _oid_to_name(self, oid: str) -> str:
        """Convert OID to human-readable name based on NPDU MIB."""
        # Map NPDU MIB OIDs - masterpdu structure:
        # .1 = masterInformation, .2 = masterP1, .3 = masterP2, .4 = masterP3
        oid_map = {
            # Phase 1 (masterP1 = .2)
            ".1.3.6.1.4.1.23273.3.1.1.2.1.0": "MasterVoltageP1",
            ".1.3.6.1.4.1.23273.3.1.1.2.2.0": "MasterCurrentP1",
            ".1.3.6.1.4.1.23273.3.1.1.2.3.0": "MasterPowerP1",
            ".1.3.6.1.4.1.23273.3.1.1.2.4.0": "MasterPFP1",
            ".1.3.6.1.4.1.23273.3.1.1.2.5.0": "MasterEnergyP1",
            # Phase 2 (masterP2 = .3)
            ".1.3.6.1.4.1.23273.3.1.1.3.1.0": "MasterVoltageP2",
            ".1.3.6.1.4.1.23273.3.1.1.3.2.0": "MasterCurrentP2",
            ".1.3.6.1.4.1.23273.3.1.1.3.3.0": "MasterPowerP2",
            ".1.3.6.1.4.1.23273.3.1.1.3.4.0": "MasterPFP2",
            ".1.3.6.1.4.1.23273.3.1.1.3.5.0": "MasterEnergyP2",
            # Phase 3 (masterP3 = .4)
            ".1.3.6.1.4.1.23273.3.1.1.4.1.0": "MasterVoltageP3",
            ".1.3.6.1.4.1.23273.3.1.1.4.2.0": "MasterCurrentP3",
            ".1.3.6.1.4.1.23273.3.1.1.4.3.0": "MasterPowerP3",
            ".1.3.6.1.4.1.23273.3.1.1.4.4.0": "MasterPFP3",
            ".1.3.6.1.4.1.23273.3.1.1.4.5.0": "MasterEnergyP3",
            # Device info (masterInformation = .1)
            ".1.3.6.1.4.1.23273.3.1.1.1.1.0": "DeviceName",
            ".1.3.6.1.4.1.23273.3.1.1.1.2.0": "DeviceType",
            ".1.3.6.1.4.1.23273.3.1.1.1.3.0": "DeviceOutputNum",
            ".1.3.6.1.4.1.23273.3.1.1.1.4.0": "DeviceMac",
        }
        
        if oid in oid_map:
            return oid_map[oid]
        
        # Handle outlet OIDs
        outlet_prefixes = {
            ".1.3.6.1.4.1.23273.3.1.1.5.": "OutletName",
            ".1.3.6.1.4.1.23273.3.1.1.6.": "OutletStatus",
            ".1.3.6.1.4.1.23273.3.1.1.7.": "OutletCurrent",
            ".1.3.6.1.4.1.23273.3.1.1.10.": "OutletEnergy",
        }
        
        for prefix, name in outlet_prefixes.items():
            if oid.startswith(prefix):
                suffix = oid[len(prefix):].rstrip('.0')
                parts = suffix.split('.')
                if parts:
                    return f"{name}{parts[0]}"
        
        return oid
    
    def is_device_busy(self, ip: str) -> bool:
        """Check if device has an active poll in progress."""
        with self._lock:
            if ip in self._active_requests:
                future = self._active_requests[ip]
                return not future.done()
        return False
    
    def cancel_device_polls(self, ip: str):
        """Cancel any pending polls for a device."""
        with self._lock:
            if ip in self._active_requests:
                future = self._active_requests[ip]
                future.cancel()
                del self._active_requests[ip]
    
    def get_metrics(self) -> Dict[str, Any]:
        """Get current SNMP metrics."""
        with self._lock:
            return {
                "total_requests": self.metrics.total_requests,
                "successful_requests": self.metrics.successful_requests,
                "failed_requests": self.metrics.failed_requests,
                "timeout_count": self.metrics.timeout_count,
                "avg_latency_ms": self.metrics.avg_latency_ms,
                "success_rate": self.metrics.success_rate,
                "requests_by_operation": dict(self.metrics.requests_per_operation)
            }
    
    def reset_metrics(self):
        """Reset metrics counters."""
        with self._lock:
            self.metrics = SnmpMetrics()
    
    def shutdown(self):
        """Shutdown the executor."""
        self._executor.shutdown(wait=False)
