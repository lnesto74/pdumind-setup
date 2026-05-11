"""
Poll Scheduler - Priority queue-based scheduler with worker pool.

Features:
- Per-device "nextPollAt" tracking for each OID group
- Priority queue/min-heap for efficient scheduling
- Non-overlapping polls per device
- Configurable concurrency limits
- Graceful shutdown
"""

import heapq
import time
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Callable, Any, Set, Tuple
from concurrent.futures import ThreadPoolExecutor, Future
from enum import Enum

from .device_state import DeviceState, DeviceStatus, DeviceStateManager
from .oid_profiles import OidGroup, OidProfiles, VendorProfile
from .snmp_client import SnmpClient


@dataclass(order=True)
class PollJob:
    """Scheduled poll job with priority based on next_poll_time."""
    next_poll_at: float
    ip_address: str = field(compare=False)
    port: int = field(compare=False, default=161)
    groups: Set[OidGroup] = field(compare=False, default_factory=set)
    priority: int = field(compare=False, default=0)  # Lower = higher priority
    
    def __hash__(self):
        return hash(self.ip_address)


@dataclass
class SchedulerConfig:
    """Scheduler configuration."""
    max_workers: int = 10  # Balance between performance and memory
    tick_interval_sec: float = 0.5  # Fast tick for real-time polling
    batch_size: int = 10  # Process more jobs per tick for real-time
    
    # Starvation prevention
    max_poll_age_sec: float = 300.0  # Force poll if not polled for this long
    
    # Health check priority boost
    health_priority_boost: int = -10  # Negative = higher priority


class PollScheduler:
    """Adaptive poll scheduler with priority queue."""
    
    def __init__(self, 
                 state_manager: DeviceStateManager,
                 snmp_client: SnmpClient = None,
                 config: SchedulerConfig = None):
        self.state_manager = state_manager
        self.snmp_client = snmp_client or SnmpClient()
        self.config = config or SchedulerConfig()
        
        self._queue: List[PollJob] = []  # Min-heap
        self._queue_lock = threading.Lock()
        self._active_polls: Dict[str, Future] = {}  # ip -> future
        self._active_lock = threading.Lock()
        
        self._executor = ThreadPoolExecutor(max_workers=self.config.max_workers)
        self._running = False
        self._scheduler_thread: Optional[threading.Thread] = None
        
        # Metrics
        self._polls_dispatched = 0
        self._polls_completed = 0
        self._polls_failed = 0
        self._last_tick_jobs = 0
        
        # Callbacks
        self._on_poll_complete: Optional[Callable] = None
        self._on_poll_error: Optional[Callable] = None
    
    def set_callbacks(self, 
                      on_complete: Callable[[str, Dict], None] = None,
                      on_error: Callable[[str, str], None] = None):
        """Set callbacks for poll completion/error."""
        self._on_poll_complete = on_complete
        self._on_poll_error = on_error
    
    def schedule_device(self, ip_address: str, port: int = 161, 
                        groups: Set[OidGroup] = None,
                        priority: int = 0,
                        delay_sec: float = 0.0):
        """Schedule a device for polling."""
        if groups is None:
            groups = {OidGroup.HEALTH, OidGroup.CORE}
        
        next_poll = time.time() + delay_sec
        job = PollJob(
            next_poll_at=next_poll,
            ip_address=ip_address,
            port=port,
            groups=groups,
            priority=priority
        )
        
        with self._queue_lock:
            # Remove existing job for same device if present
            self._queue = [j for j in self._queue if j.ip_address != ip_address]
            heapq.heappush(self._queue, job)
            heapq.heapify(self._queue)
    
    def schedule_all_devices(self):
        """Schedule all known devices based on their states."""
        devices = self.state_manager.get_all_devices()
        now = time.time()
        
        for status in devices:
            groups = self._get_groups_for_state(status.state)
            
            # Calculate delay based on state
            if status.state == DeviceState.OFFLINE:
                delay = max(0, status.next_poll_at - now)
            else:
                delay = 0  # Poll immediately for online devices
            
            priority = self._get_priority_for_state(status.state)
            self.schedule_device(status.ip_address, status.port, groups, priority, delay)
        
        print(f"[Scheduler] Scheduled {len(devices)} devices")
    
    def _get_groups_for_state(self, state: DeviceState) -> Set[OidGroup]:
        """Determine which OID groups to poll based on state."""
        if state == DeviceState.OFFLINE:
            return {OidGroup.HEALTH}
        elif state == DeviceState.ONLINE_IDLE:
            return {OidGroup.HEALTH, OidGroup.CORE, OidGroup.PHASE, OidGroup.OUTLETS}
        elif state == DeviceState.ONLINE_ACTIVE:
            return {OidGroup.HEALTH, OidGroup.CORE, OidGroup.PHASE, OidGroup.OUTLETS}
        elif state == DeviceState.ALARM:
            return {OidGroup.HEALTH, OidGroup.CORE, OidGroup.PHASE, OidGroup.ALARM, OidGroup.OUTLETS}
        return {OidGroup.HEALTH}
    
    def _get_priority_for_state(self, state: DeviceState) -> int:
        """Get poll priority based on state (lower = higher priority)."""
        priorities = {
            DeviceState.ALARM: 0,  # Highest
            DeviceState.ONLINE_ACTIVE: 10,
            DeviceState.ONLINE_IDLE: 20,
            DeviceState.OFFLINE: 100,  # Lowest
        }
        return priorities.get(state, 50)
    
    def start(self):
        """Start the scheduler loop."""
        if self._running:
            return
        
        self._running = True
        self._scheduler_thread = threading.Thread(target=self._run_loop, daemon=True)
        self._scheduler_thread.start()
        print("[Scheduler] Started")
    
    def stop(self):
        """Stop the scheduler."""
        self._running = False
        if self._scheduler_thread:
            self._scheduler_thread.join(timeout=5.0)
        self._executor.shutdown(wait=False)
        print("[Scheduler] Stopped")
    
    def _run_loop(self):
        """Main scheduler loop."""
        while self._running:
            try:
                self._tick()
            except Exception as e:
                print(f"[Scheduler] Tick error: {e}")
            
            time.sleep(self.config.tick_interval_sec)
    
    def _tick(self):
        """Process one scheduler tick."""
        now = time.time()
        jobs_to_dispatch = []
        
        with self._queue_lock:
            # Collect due jobs
            while self._queue and len(jobs_to_dispatch) < self.config.batch_size:
                if self._queue[0].next_poll_at <= now:
                    job = heapq.heappop(self._queue)
                    
                    # Skip if device already has active poll
                    with self._active_lock:
                        if job.ip_address in self._active_polls:
                            future = self._active_polls[job.ip_address]
                            if not future.done():
                                # Re-schedule with small delay
                                job.next_poll_at = now + 1.0
                                heapq.heappush(self._queue, job)
                                continue
                    
                    jobs_to_dispatch.append(job)
                else:
                    break
        
        self._last_tick_jobs = len(jobs_to_dispatch)
        
        # Dispatch jobs
        for job in jobs_to_dispatch:
            self._dispatch_poll(job)
    
    def _dispatch_poll(self, job: PollJob):
        """Dispatch a poll job to the worker pool."""
        def poll_task():
            return self._execute_poll(job)
        
        future = self._executor.submit(poll_task)
        
        with self._active_lock:
            self._active_polls[job.ip_address] = future
        
        self._polls_dispatched += 1
        
        # Add completion callback
        future.add_done_callback(
            lambda f: self._on_poll_done(job.ip_address, f)
        )
    
    def _execute_poll(self, job: PollJob) -> Tuple[bool, Dict[str, Any], float]:
        """Execute the actual poll."""
        status = self.state_manager.get_or_create(job.ip_address, job.port)
        profile = OidProfiles.get_profile(profile_name=status.vendor_profile)
        
        # Build OID lists based on groups
        health_oids = None
        core_oids = None
        phase_oids = None
        outlet_bases = None
        
        if OidGroup.HEALTH in job.groups:
            health_oids = OidProfiles.get_health_oids(profile)
        
        if OidGroup.CORE in job.groups:
            core_oids = OidProfiles.get_core_oids(profile)
        
        if OidGroup.PHASE in job.groups:
            phase_defs = OidProfiles.get_oids_for_group(profile, OidGroup.PHASE)
            phase_oids = [o.oid for o in phase_defs if not o.is_table]
        
        if OidGroup.OUTLETS in job.groups:
            outlet_defs = OidProfiles.get_outlet_base_oids(profile)
            outlet_bases = [(od.name, od.oid) for od in outlet_defs]
        
        # Merge phase OIDs with core OIDs for polling
        all_core_oids = (core_oids or []) + (phase_oids or [])
        
        # Execute poll - always poll all outlets when outlets are in the group
        # (active_outlets_only optimization disabled for now to ensure dashboard works)
        success, results, latency = self.snmp_client.poll_device(
            job.ip_address, job.port,
            health_oids=health_oids,
            core_oids=all_core_oids if all_core_oids else None,
            outlet_bases=outlet_bases,
            active_outlets_only=False,
            active_outlets=None
        )
        
        return success, results, latency
    
    def _on_poll_done(self, ip_address: str, future: Future):
        """Handle poll completion."""
        with self._active_lock:
            self._active_polls.pop(ip_address, None)
        
        try:
            success, results, latency = future.result()
            
            if success:
                self._polls_completed += 1
                # Update state manager
                status = self.state_manager.record_poll_success(ip_address, latency, results)
                
                # Call completion callback
                if self._on_poll_complete:
                    self._on_poll_complete(ip_address, results)
                
                # Re-schedule based on new state
                groups = self._get_groups_for_state(status.state)
                priority = self._get_priority_for_state(status.state)
                delay = self._get_delay_for_state(status)
                self.schedule_device(ip_address, status.port, groups, priority, delay)
                
            else:
                self._polls_failed += 1
                # Update state manager
                status = self.state_manager.record_poll_failure(ip_address)
                
                # Call error callback
                if self._on_poll_error:
                    self._on_poll_error(ip_address, "Poll failed")
                
                # Re-schedule with backoff
                self.schedule_device(
                    ip_address, status.port, 
                    {OidGroup.HEALTH},  # Only health check for failed devices
                    priority=100,  # Low priority
                    delay_sec=status.backoff_sec
                )
                
        except Exception as e:
            self._polls_failed += 1
            print(f"[Scheduler] Poll error for {ip_address}: {e}")
            
            # Re-schedule with backoff
            status = self.state_manager.record_poll_failure(ip_address, str(e))
            self.schedule_device(
                ip_address, status.port,
                {OidGroup.HEALTH},
                priority=100,
                delay_sec=status.backoff_sec
            )
    
    def _get_delay_for_state(self, status: DeviceStatus) -> float:
        """Calculate next poll delay based on state."""
        cfg = self.state_manager.config
        
        if status.state == DeviceState.OFFLINE:
            return status.backoff_sec
        elif status.state == DeviceState.ONLINE_IDLE:
            return cfg.IDLE_CORE_INTERVAL
        elif status.state == DeviceState.ONLINE_ACTIVE:
            return cfg.ACTIVE_CORE_INTERVAL
        elif status.state == DeviceState.ALARM:
            return cfg.ALARM_CORE_INTERVAL
        
        return 60.0  # Default
    
    def trigger_immediate_poll(self, ip_address: str, port: int = 161,
                               groups: Set[OidGroup] = None):
        """Trigger immediate poll for a device (e.g., on trap or user request)."""
        if groups is None:
            groups = {OidGroup.HEALTH, OidGroup.CORE, OidGroup.OUTLETS}
        
        # Cancel any pending poll
        with self._active_lock:
            if ip_address in self._active_polls:
                future = self._active_polls[ip_address]
                if not future.done():
                    return  # Already polling
        
        # Schedule with high priority and no delay
        self.schedule_device(ip_address, port, groups, priority=-100, delay_sec=0)
    
    def get_queue_status(self) -> Dict[str, Any]:
        """Get current queue status."""
        with self._queue_lock:
            queue_size = len(self._queue)
            next_job = self._queue[0] if self._queue else None
        
        with self._active_lock:
            active_count = len(self._active_polls)
        
        return {
            "queue_size": queue_size,
            "active_polls": active_count,
            "polls_dispatched": self._polls_dispatched,
            "polls_completed": self._polls_completed,
            "polls_failed": self._polls_failed,
            "last_tick_jobs": self._last_tick_jobs,
            "next_job_at": next_job.next_poll_at if next_job else None,
            "next_job_ip": next_job.ip_address if next_job else None,
        }
    
    def get_device_schedule(self, ip_address: str) -> Optional[Dict[str, Any]]:
        """Get schedule info for a specific device."""
        with self._queue_lock:
            for job in self._queue:
                if job.ip_address == ip_address:
                    return {
                        "next_poll_at": job.next_poll_at,
                        "groups": [g.value for g in job.groups],
                        "priority": job.priority,
                        "delay_sec": max(0, job.next_poll_at - time.time())
                    }
        
        with self._active_lock:
            if ip_address in self._active_polls:
                return {"status": "polling"}
        
        return None
