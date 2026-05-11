"""
OID Profiles - Vendor-based OID grouping for efficient polling.

Groups:
- GROUP_HEALTH: Lightweight health check OIDs (sysUpTime, sysName)
- GROUP_CORE: Total power/current, device status, alarm summary
- GROUP_PHASE: Per-phase currents/voltage, branch circuits
- GROUP_OUTLETS: Per-outlet state/current (only when needed)
- GROUP_STATIC: Inventory/config tables (rare, cached)
"""

from enum import Enum
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set


class OidGroup(Enum):
    HEALTH = "health"
    CORE = "core"
    PHASE = "phase"
    OUTLETS = "outlets"
    STATIC = "static"
    ALARM = "alarm"


@dataclass
class OidDefinition:
    """Single OID definition with metadata."""
    name: str
    oid: str
    group: OidGroup
    is_table: bool = False  # True for tabular OIDs (need GETBULK)
    table_size: int = 0  # Expected table size (e.g., 24 outlets)
    description: str = ""
    unit: str = ""
    scale: float = 1.0  # Multiplier for value conversion


@dataclass
class VendorProfile:
    """Vendor-specific OID profile."""
    name: str
    vendor_id: str  # sysObjectID prefix to match
    description: str = ""
    oids: List[OidDefinition] = field(default_factory=list)
    outlet_count: int = 24
    supports_getbulk: bool = True
    supports_traps: bool = False


class OidProfiles:
    """Manager for vendor OID profiles."""
    
    # Standard MIB-2 OIDs
    STANDARD_HEALTH = [
        OidDefinition("sysUpTime", ".1.3.6.1.2.1.1.3.0", OidGroup.HEALTH, description="System uptime"),
        OidDefinition("sysName", ".1.3.6.1.2.1.1.5.0", OidGroup.HEALTH, description="System name"),
        OidDefinition("sysDescr", ".1.3.6.1.2.1.1.1.0", OidGroup.HEALTH, description="System description"),
    ]
    
    # NPDU MIB (enterprise OID .1.3.6.1.4.1.23273)
    # Based on npdu-n-v2-bu.MIB: pdu.npdu.master.masterpdu
    # masterpdu.1 = masterInformation, .2 = masterP1, .3 = masterP2, .4 = masterP3
    # masterpdu.5 = masterOutputName, .6 = masterOutputStatus, .7 = masterOutputCurrent, .10 = masterOutputEnergy
    SCHLEIFENBAUER_OIDS = [
        # Health
        OidDefinition("sysUpTime", ".1.3.6.1.2.1.1.3.0", OidGroup.HEALTH),
        OidDefinition("sysName", ".1.3.6.1.2.1.1.5.0", OidGroup.HEALTH),
        
        # Core - Phase 1 data (masterP1 = .2)
        OidDefinition("MasterVoltageP1", ".1.3.6.1.4.1.23273.3.1.1.2.1.0", OidGroup.CORE, unit="V"),
        OidDefinition("MasterCurrentP1", ".1.3.6.1.4.1.23273.3.1.1.2.2.0", OidGroup.CORE, unit="A"),
        OidDefinition("MasterPowerP1", ".1.3.6.1.4.1.23273.3.1.1.2.3.0", OidGroup.CORE, unit="W"),
        OidDefinition("MasterPFP1", ".1.3.6.1.4.1.23273.3.1.1.2.4.0", OidGroup.CORE),
        OidDefinition("MasterEnergyP1", ".1.3.6.1.4.1.23273.3.1.1.2.5.0", OidGroup.CORE, unit="kWh"),
        
        # Phase 2 data (masterP2 = .3)
        OidDefinition("MasterVoltageP2", ".1.3.6.1.4.1.23273.3.1.1.3.1.0", OidGroup.PHASE, unit="V"),
        OidDefinition("MasterCurrentP2", ".1.3.6.1.4.1.23273.3.1.1.3.2.0", OidGroup.PHASE, unit="A"),
        OidDefinition("MasterPowerP2", ".1.3.6.1.4.1.23273.3.1.1.3.3.0", OidGroup.PHASE, unit="W"),
        OidDefinition("MasterPFP2", ".1.3.6.1.4.1.23273.3.1.1.3.4.0", OidGroup.PHASE),
        OidDefinition("MasterEnergyP2", ".1.3.6.1.4.1.23273.3.1.1.3.5.0", OidGroup.PHASE, unit="kWh"),
        
        # Phase 3 data (masterP3 = .4)
        OidDefinition("MasterVoltageP3", ".1.3.6.1.4.1.23273.3.1.1.4.1.0", OidGroup.PHASE, unit="V"),
        OidDefinition("MasterCurrentP3", ".1.3.6.1.4.1.23273.3.1.1.4.2.0", OidGroup.PHASE, unit="A"),
        OidDefinition("MasterPowerP3", ".1.3.6.1.4.1.23273.3.1.1.4.3.0", OidGroup.PHASE, unit="W"),
        OidDefinition("MasterPFP3", ".1.3.6.1.4.1.23273.3.1.1.4.4.0", OidGroup.PHASE),
        OidDefinition("MasterEnergyP3", ".1.3.6.1.4.1.23273.3.1.1.4.5.0", OidGroup.PHASE, unit="kWh"),
        
        # Device info (masterInformation = .1)
        OidDefinition("DeviceName", ".1.3.6.1.4.1.23273.3.1.1.1.1.0", OidGroup.STATIC),
        OidDefinition("DeviceType", ".1.3.6.1.4.1.23273.3.1.1.1.2.0", OidGroup.STATIC),
        OidDefinition("DeviceOutputNum", ".1.3.6.1.4.1.23273.3.1.1.1.3.0", OidGroup.STATIC),
        OidDefinition("DeviceMac", ".1.3.6.1.4.1.23273.3.1.1.1.4.0", OidGroup.STATIC),
        
        # Outlet tables (indexed 1-24)
        OidDefinition("OutletName", ".1.3.6.1.4.1.23273.3.1.1.5", OidGroup.OUTLETS, is_table=True, table_size=24),
        OidDefinition("OutletStatus", ".1.3.6.1.4.1.23273.3.1.1.6", OidGroup.OUTLETS, is_table=True, table_size=24),
        OidDefinition("OutletCurrent", ".1.3.6.1.4.1.23273.3.1.1.7", OidGroup.OUTLETS, is_table=True, table_size=24, unit="A"),
        OidDefinition("OutletEnergy", ".1.3.6.1.4.1.23273.3.1.1.10", OidGroup.OUTLETS, is_table=True, table_size=24, unit="kWh"),
        
        # Sensors (masterSerson = .11)
        OidDefinition("SensorStatus", ".1.3.6.1.4.1.23273.3.1.1.11.0", OidGroup.ALARM),
    ]
    
    # Generic PDU profile (fallback)
    GENERIC_OIDS = [
        OidDefinition("sysUpTime", ".1.3.6.1.2.1.1.3.0", OidGroup.HEALTH),
        OidDefinition("sysName", ".1.3.6.1.2.1.1.5.0", OidGroup.HEALTH),
        OidDefinition("sysDescr", ".1.3.6.1.2.1.1.1.0", OidGroup.HEALTH),
        OidDefinition("sysObjectID", ".1.3.6.1.2.1.1.2.0", OidGroup.STATIC),
    ]
    
    # Vendor profiles registry
    PROFILES: Dict[str, VendorProfile] = {
        "schleifenbauer": VendorProfile(
            name="Schleifenbauer",
            vendor_id=".1.3.6.1.4.1.23273",
            description="Schleifenbauer PDU",
            oids=SCHLEIFENBAUER_OIDS,
            outlet_count=24,
            supports_getbulk=True,
            supports_traps=True
        ),
        "generic": VendorProfile(
            name="Generic",
            vendor_id="",
            description="Generic SNMP device",
            oids=GENERIC_OIDS,
            outlet_count=0,
            supports_getbulk=True,
            supports_traps=False
        ),
    }
    
    @classmethod
    def get_profile(cls, vendor_id: str = None, profile_name: str = None) -> VendorProfile:
        """Get vendor profile by sysObjectID or name."""
        if profile_name and profile_name in cls.PROFILES:
            return cls.PROFILES[profile_name]
        
        if vendor_id:
            for profile in cls.PROFILES.values():
                if profile.vendor_id and vendor_id.startswith(profile.vendor_id):
                    return profile
        
        return cls.PROFILES["generic"]
    
    @classmethod
    def get_oids_for_group(cls, profile: VendorProfile, group: OidGroup) -> List[OidDefinition]:
        """Get OIDs for a specific group from a profile."""
        return [oid for oid in profile.oids if oid.group == group]
    
    @classmethod
    def get_health_oids(cls, profile: VendorProfile = None) -> List[str]:
        """Get lightweight health check OIDs."""
        if profile:
            oids = cls.get_oids_for_group(profile, OidGroup.HEALTH)
            if oids:
                return [o.oid for o in oids]
        return [o.oid for o in cls.STANDARD_HEALTH]
    
    @classmethod
    def get_core_oids(cls, profile: VendorProfile) -> List[str]:
        """Get core telemetry OIDs (non-table)."""
        oids = cls.get_oids_for_group(profile, OidGroup.CORE)
        return [o.oid for o in oids if not o.is_table]
    
    @classmethod
    def get_outlet_base_oids(cls, profile: VendorProfile) -> List[OidDefinition]:
        """Get outlet table base OIDs for GETBULK."""
        return [o for o in cls.get_oids_for_group(profile, OidGroup.OUTLETS) if o.is_table]
    
    @classmethod
    def expand_outlet_oids(cls, profile: VendorProfile, outlets: Set[int] = None) -> List[str]:
        """Expand outlet OIDs for specific outlets or all."""
        outlet_defs = cls.get_outlet_base_oids(profile)
        if not outlet_defs:
            return []
        
        expanded = []
        outlet_range = outlets if outlets else range(1, profile.outlet_count + 1)
        
        for oid_def in outlet_defs:
            for outlet_num in outlet_range:
                expanded.append(f"{oid_def.oid}.{outlet_num}.0")
        
        return expanded
    
    @classmethod
    def get_alarm_oids(cls, profile: VendorProfile) -> List[str]:
        """Get alarm-related OIDs."""
        oids = cls.get_oids_for_group(profile, OidGroup.ALARM)
        return [o.oid for o in oids]
    
    @classmethod
    def get_static_oids(cls, profile: VendorProfile) -> List[str]:
        """Get static/inventory OIDs (poll rarely)."""
        oids = cls.get_oids_for_group(profile, OidGroup.STATIC)
        return [o.oid for o in oids if not o.is_table]
    
    @classmethod
    def build_poll_oids(cls, profile: VendorProfile, groups: Set[OidGroup],
                        active_outlets: Set[int] = None) -> Dict[OidGroup, List[str]]:
        """Build OID lists for requested groups."""
        result = {}
        
        if OidGroup.HEALTH in groups:
            result[OidGroup.HEALTH] = cls.get_health_oids(profile)
        
        if OidGroup.CORE in groups:
            result[OidGroup.CORE] = cls.get_core_oids(profile)
        
        if OidGroup.PHASE in groups:
            phase_oids = cls.get_oids_for_group(profile, OidGroup.PHASE)
            result[OidGroup.PHASE] = [o.oid for o in phase_oids if not o.is_table]
        
        if OidGroup.OUTLETS in groups:
            if active_outlets:
                result[OidGroup.OUTLETS] = cls.expand_outlet_oids(profile, active_outlets)
            else:
                result[OidGroup.OUTLETS] = cls.expand_outlet_oids(profile)
        
        if OidGroup.ALARM in groups:
            result[OidGroup.ALARM] = cls.get_alarm_oids(profile)
        
        if OidGroup.STATIC in groups:
            result[OidGroup.STATIC] = cls.get_static_oids(profile)
        
        return result
    
    @classmethod
    def get_oid_name(cls, profile: VendorProfile, oid: str) -> str:
        """Get human-readable name for an OID."""
        # Check exact match first
        for oid_def in profile.oids:
            if oid_def.oid == oid:
                return oid_def.name
            # Check if it's a table entry
            if oid_def.is_table and oid.startswith(oid_def.oid):
                # Extract index
                suffix = oid[len(oid_def.oid):]
                parts = suffix.strip('.').split('.')
                if parts:
                    return f"{oid_def.name}{parts[0]}"
        
        return oid.split('.')[-1]  # Return last component as fallback
