import os
from flask import Flask, request, jsonify, make_response
from flask_cors import CORS
import json
import time
import requests as _requests_lib
from typing import List, Tuple, Dict, Any, Optional
from threading import Thread, Lock
# Parallelization helpers
from concurrent.futures import ThreadPoolExecutor, as_completed

# Maximum number of concurrent SNMP queries (tunable via env)
MAX_SNMP_THREADS = int(os.getenv("MAX_SNMP_THREADS", "12"))  # 12 threads = 24 outlets / 2 OIDs per batch
# Batch size for grouping OIDs per snmpget call
SNMP_BATCH_SIZE = int(os.getenv('SNMP_BATCH_SIZE', 2))  # Small batches to avoid timeouts
# Number of outputs (outlet count)
OUTPUT_COUNT = 24
OUTLET_BATCH_SIZE = 2  # Small batches to avoid timeouts

# SNMP settings
DEFAULT_COMMUNITY = os.getenv('SNMP_COMMUNITY', 'private')

# Timeouts and retries for outlet polling
OUTLET_BASE_TIMEOUT = 5
OUTLET_BASE_RETRIES = 3

GENERIC_TIMEOUT = 5
GENERIC_RETRIES = 3

BATCH_SIZE = 1 # Two retries to handle occasional timeouts

# Master outlet OIDs for v1.0.1 PDU structure
# Each OID needs .{outlet_number}.0 appended for the actual SNMP query
# e.g. .1.3.6.1.4.1.23273.3.1.1.6.1.0 for outlet 1 status
OUTPUT_PREFIXES: dict[str, str] = {
    'Status': '.1.3.6.1.4.1.23273.3.1.1.6',   # Returns ON/OFF string
    'Current': '.1.3.6.1.4.1.23273.3.1.1.7',  # Returns amperage value
    'Energy': '.1.3.6.1.4.1.23273.3.1.1.10',  # Returns energy consumption
    'Name': '.1.3.6.1.4.1.23273.3.1.1.5'      # Returns outlet name
}

from database import init_db, store_poll_results

# Try to import PM agent, but don't fail if OpenAI has issues
try:
    from pm_agent.agent import answer as pm_answer
except Exception as e:
    print(f"Warning: PM Agent failed to load: {e}")
    def pm_answer(question: str) -> str:
        return "AI agent unavailable due to configuration issue. Telemetry data is still accessible."

# Import new persistence layer
from db import init_db as init_persistence_db, HallRepo, RackRepo, PDURepo, TelemetryRepo, EventRepo, MibRepo
from db.persistence import save_hall_state, store_poll_snapshot

# Import adaptive polling system
from polling import (
    AdaptivePoller, AdaptivePollerConfig, 
    get_adaptive_poller, ensure_adaptive_poller,
    DeviceState
)

# Import auth module
from auth import register_auth_routes, ensure_default_admin, require_auth

def snmp_walk(ip: str, port: int, base_oid: str, timeout: int = OUTLET_BASE_TIMEOUT, snmp_version: str = "2c") -> dict[str, str]:
    """Walk an OID tree and return {full_oid: value} mapping. Uses numeric OIDs and prints
    value only for easier parsing while keeping the OID on each line ("-On -Ov").
    """
    import subprocess
    try:
        cmd = [
            "snmpwalk",
            f"-v{snmp_version}",
            "-c", DEFAULT_COMMUNITY,
            "-t", str(timeout),
            "-r", str(OUTLET_MAX_RETRIES),
            "-On",   # Numeric OIDs
            "-Oe",   # Enumerations where applicable
            "-Ov",   # Value only (but keep OID due to default format "OID VALUE")
            f"{ip}:{port}",
            base_oid,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 2)
        if result.returncode == 0:
            values: dict[str, str] = {}
            for line in result.stdout.strip().splitlines():
                if not line:
                    continue
                # Expected format after -On -Ov: "<oid> <value>"
                parts = line.split(" ", 1)
                if len(parts) != 2:
                    continue
                oid, value = parts
                value = value.strip(' "')
                if "No Such Object" in value or "No Such Instance" in value:
                    continue
                values[oid] = value
            return values

        print(f"[snmpwalk] failed with rc={result.returncode}")
        if result.stderr:
            print(f"[snmpwalk] stderr: {result.stderr.strip()}")
        
    except subprocess.TimeoutExpired:
        print(f"[snmpwalk] timeout after {timeout}s")
    except Exception as exc:
        print(f"[snmpwalk] unexpected error: {exc}")

    return {}

try:
    # pysnmp is the most portable, easysnmp relies on net-snmp libs on host
    from pysnmp.hlapi import (
        getCmd,
        SnmpEngine,
        CommunityData,
        UdpTransportTarget,
        ContextData,
        ObjectType,
        ObjectIdentity,
    )
except ImportError:
    # Allow the backend to start even if pysnmp is missing (e.g. during CI)
    getCmd = None  # type: ignore

# ---------------------------------------------------------------------------
# Configuration helpers
# ---------------------------------------------------------------------------

DATA_DIR = os.getenv("DATA_DIR", "data")
os.makedirs(DATA_DIR, exist_ok=True)
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
DEFAULT_COMMUNITY = os.getenv("SNMP_COMMUNITY", "private")

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*", "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"]}})


def load_config() -> Dict[str, Any]:
    if not os.path.exists(CONFIG_PATH):
        return {}
    with open(CONFIG_PATH, "r", encoding="utf-8") as fp:
        try:
            return json.load(fp)
        except json.JSONDecodeError:
            return {}


def save_config(cfg: Dict[str, Any]) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as fp:
        json.dump(cfg, fp, indent=2)


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

def parse_mib_text(mib_text: str) -> List[Tuple[str, str]]:
    """Enhanced MIB parser for hierarchical OID definitions.
    
    Handles both OBJECT IDENTIFIER and OBJECT-TYPE definitions.
    Builds complete OID paths by resolving parent references.
    """
    # Store all OID definitions (name -> numeric parts)
    oid_defs = {
        'enterprises': ['1', '3', '6', '1', '4', '1']  # Standard enterprises prefix
    }
    
    # First pass: collect all OBJECT IDENTIFIER definitions
    for line in mib_text.splitlines():
        line = line.strip()
        if not line or line.startswith('--') or line.startswith('#'):
            continue
            
        if 'OBJECT IDENTIFIER' in line and '::=' in line:
            parts = line.split('OBJECT IDENTIFIER', 1)
            name = parts[0].strip()
            after = parts[1].split('::=', 1)[1].strip()
            
            if '{' in after and '}' in after:
                ref_parts = after[after.index('{') + 1:after.index('}')].strip().split()
                if len(ref_parts) >= 2:
                    parent_name = ref_parts[0]
                    number = ref_parts[-1]  # Take last part as number
                    if number.isdigit():
                        if parent_name in oid_defs:
                            # Build complete OID by appending to parent's OID
                            oid_defs[name] = oid_defs[parent_name] + [number]
                        else:
                            # Store just this number if parent not found yet
                            oid_defs[name] = [number]
    
    # Second pass: collect all OBJECT-TYPE definitions
    result: List[Tuple[str, str]] = []
    
    # Store lines in memory for easier processing
    lines = mib_text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        
        if 'OBJECT-TYPE' in line:
            name = line.split('OBJECT-TYPE')[0].strip()
            
            # Look ahead for ::= line
            while i < len(lines) and '::=' not in lines[i]:
                i += 1
            
            if i < len(lines):
                after = lines[i].split('::=', 1)[1].strip()
                if '{' in after and '}' in after:
                    ref_parts = after[after.index('{') + 1:after.index('}')].strip().split()
                    if len(ref_parts) >= 2:
                        parent_name = ref_parts[0]
                        number = ref_parts[-1]  # Take last part as number
                        if number.isdigit() and parent_name in oid_defs:
                            # Build complete OID using parent's OID
                            full_oid = oid_defs[parent_name] + [number]
                            result.append((name, '.'.join(full_oid)))
        i += 1
    
    return result


def test_parse_mib():
    """Test the MIB parser with a sample from your MIB."""
    test_mib = """
    pdu OBJECT IDENTIFIER ::= { enterprises 23273}
    npdu OBJECT IDENTIFIER ::= { pdu 3 }
    master OBJECT IDENTIFIER ::= { npdu 1 }
    masterpdu OBJECT IDENTIFIER ::= { master 1 }
    masterInformation OBJECT IDENTIFIER ::= { masterpdu 1 }
    
    MasterDeviceName OBJECT-TYPE
        SYNTAX DisplayString (SIZE (255))
        MAX-ACCESS read-write
        STATUS current
        DESCRIPTION
                "device name."
        ::= { masterInformation 1 }
    """
    
    oids = parse_mib_text(test_mib)
    print("\nParsed OIDs:")
    for name, oid in oids:
        print(f"{name}: {oid}")


# Run test when module loads
# if __name__ == "__main__":
#     test_parse_mib()


# Optimised batch SNMP fetcher
def snmp_get_batch(ip: str, port: int, oids: list[str], retries: int | None = None, timeout: int | None = None, snmp_version: str = "2c") -> dict[str, str | None]:
    """Fetch a list of OIDs in a *single* snmpget process call to drastically
    reduce overhead. Returns a mapping of oid -> value (None on error).
    Optionally override timeout (seconds) and retries for this batch.
    """
    import subprocess, shlex

    retry_count = retries if retries is not None else 3
    base_timeout = timeout if timeout is not None else 2

    cmd = [
        "snmpget",
        f"-v{snmp_version}",
        "-c", DEFAULT_COMMUNITY,
        "-t", str(base_timeout),
        "-r", str(retry_count),
        "-Oqv",        # numerics for enums
        "-Oe",         # 
        f"{ip}:{port}",
    ] + oids

    start_time = time.time()
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=base_timeout * (retry_count + 1))
        elapsed = time.time() - start_time
        print(f"[snmp_get_batch] {len(oids)} OIDs took {elapsed:.2f}s (rc={result.returncode})")
        if result.returncode != 0:
            print("[snmp_get_batch] stderr:", result.stderr.strip())
            return {oid: None for oid in oids}

        values = result.stdout.strip().splitlines()
        mapping: dict[str, str | None] = {}
        for oid, line in zip(oids, values):
            mapping[oid] = line.strip()
        # Any missing lines -> None
        for oid in oids[len(values):]:
            mapping[oid] = None
        return mapping
    except Exception as e:
        print(f"[snmp_get_batch] Error: {str(e)}")
        return {oid: None for oid in oids}


def snmp_get_outlets(ip: str, port: int, base_oid: str, timeout: int = 3, snmp_version: str = "2c") -> Dict[str, str]:
    """Run snmpget for all outlet OIDs of a given type.
    Returns a mapping of OID to value.
    """
    import subprocess
    try:
        oids = [f"{base_oid}.{i}.0" for i in range(1, 25)]
        
        cmd = [
            "snmpget",
            f"-v{snmp_version}",
            "-c", "private",
            "-t", str(timeout),
            "-r", "2",
            "-On", "-Ov", "-Oe",
            f"{ip}:{port}"
        ] + oids

        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode == 0:
            # Parse output lines and map OIDs to values
            mapping: Dict[str, str] = {}
            lines = proc.stdout.strip().split('\n')
            for oid_full, line in zip(oids, lines):
                try:
                    _, value = line.split(" = ", 1)
                    if value.startswith("STRING: "):
                        value = value[8:].strip('"')
                    if "No Such Object" not in value and "Error:" not in value and "Timeout:" not in value:
                        mapping[oid_full] = value
                except Exception:
                    mapping[oid_full] = None
            return mapping
        return {oid: None for oid in oids}
    except Exception as e:
        print(f"[snmp_get_outlets] Error: {str(e)}")
        return {oid: None for oid in oids}


def poll_outlet_status_priority(ip: str, outlet: int) -> None:
    """Poll a specific outlet's status with high priority after control."""
    try:
        # Build OIDs for this outlet
        oids = [
            f".1.3.6.1.4.1.23273.3.1.1.6.{outlet}.0",  # status
            f".1.3.6.1.4.1.23273.3.1.1.7.{outlet}.0",  # current
            f".1.3.6.1.4.1.23273.3.1.1.10.{outlet}.0"  # energy
        ]
        
        # Use higher timeout and retries for priority polling
        cmd = [
            "snmpget", "-v2c", "-c", "private",
            "-t", "3",  # 3 second timeout
            "-r", "3",  # 3 retries
            "-Oqv", "-Oe",
            f"{ip}:1663"
        ] + oids
        
        print(f"[DEBUG] Priority polling outlet {outlet}")
        subprocess.run(cmd, capture_output=True, text=True, timeout=12)  # 3s * (3+1) retries
        print(f"[DEBUG] Priority polling completed for outlet {outlet}")
    except Exception as e:
        print(f"[DEBUG] Priority polling failed for outlet {outlet}: {str(e)}")

def set_outlet_status_via_http(ip: str, outlet: int, state: str, slave: int = 0) -> tuple[bool, str]:
    """Set outlet status using HTTP control interface.
    state must be 'on' or 'off'. `ip` is the reachable endpoint (the chain
    master for slaves) and `slave` is the daisy-chain index (0 = master).
    Returns (success, error_message)
    """
    try:
        print(f"[DEBUG] set_outlet_status_via_http called with ip={ip}, outlet={outlet}, state={state}, slave={slave}")
        # PDU uses port 80 for control interface
        # b=2 for ON, b=1 for OFF; trailing &=<slave> selects the chain unit
        value = "2" if state.lower() == "on" else "1"  # b=2 for ON, b=1 for OFF

        url = f"http://{ip}:80/setcontrol?a={outlet}&b={value}&={int(slave)}"
        print(f"[DEBUG] Sending request to: {url}")
        response = _requests_lib.get(url, timeout=5)
        print(f"[DEBUG] Response status: {response.status_code}, text: {response.text}")
        
        if response.status_code == 200 and response.text.strip() == "OK":
            print(f"[DEBUG] Control operation successful")
            return True, ""
        error_msg = f"HTTP Error: {response.status_code} - {response.text}"
        print(f"[DEBUG] Control operation failed: {error_msg}")
        return False, error_msg
        
    except Exception as e:
        error_msg = f"Request failed: {str(e)}"
        print(f"[DEBUG] Control operation exception: {error_msg}")
        return False, error_msg


def snmp_set_outlet_status(ip: str, port: int, outlet: int, state: str) -> tuple[bool, str]:
    """Set outlet status using HTTP control interface.
    This function now uses HTTP instead of SNMP for better reliability.
    state must be 'on' or 'off'
    Returns (success, error_message)
    """
    # Ignore the SNMP port parameter, use HTTP control interface
    return set_outlet_status_via_http(ip, outlet, state)

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

POLL_LOCK: Lock = Lock()
POLL_RESULTS: Dict[str, Dict[str, Any]] = {}
POLL_ERRORS: Dict[str, Dict[str, Any]] = {}
POLL_THREAD: Thread | None = None
POLL_STOP: bool = False

init_db()
init_persistence_db()  # Initialize new persistence layer
register_auth_routes(app)
ensure_default_admin()

from hub import (
    register_hub_routes,
    register_api_guard,
    sanitize_hall_state,
    is_coordinator_authenticated,
)

try:
    from demo.routes import register_demo_routes, init_demo_on_startup
    register_demo_routes(app)
except ImportError:
    def init_demo_on_startup(_app):
        pass

try:
    from ops_routes import register_ops_routes, init_ops_on_startup
    register_ops_routes(app)
except ImportError:
    def init_ops_on_startup(_app):
        pass

register_hub_routes(app)
register_api_guard(app)
init_demo_on_startup(app)
init_ops_on_startup(app)

@app.route("/api/outlet/<int:outlet>/status", methods=["PUT"])
def set_outlet_status(outlet: int):
    try:
        print(f"[DEBUG] ====== START OUTLET CONTROL REQUEST ======")
        print(f"[DEBUG] Received PUT request for outlet {outlet}")
        print(f"[DEBUG] Request headers: {dict(request.headers)}")
        raw_data = request.get_data(as_text=True)
        print(f"[DEBUG] Raw request data: {raw_data}")
        print(f"[DEBUG] Request form: {request.form}")
        print(f"[DEBUG] Request args: {request.args}")
        try:
            body = request.get_json(force=True)
            print(f"[DEBUG] Parsed JSON body: {body}")
            state = body.get("state")
            ip = body.get("ip")  # Accept IP from request
        except Exception as e:
            print(f"[DEBUG] Error parsing JSON: {str(e)}")
            return jsonify({"error": "Invalid JSON body"}), 400
        
        if not state or state not in ["on", "off"]:
            print(f"[DEBUG] Invalid state: {state}")
            return jsonify({"error": "Invalid state, must be 'on' or 'off'"}), 400
            
        # Use IP from request, fall back to config file
        if not ip:
            cfg = load_config()
            ip = cfg.get("ip") if cfg else None
        
        if not ip:
            print(f"[DEBUG] No IP provided")
            return jsonify({"error": "No PDU IP provided"}), 400
            
        # Resolve daisy-chain: a slave's outlets are controlled THROUGH its
        # master's IP using the slave index (slaves are unreachable directly).
        target_pdu = PDURepo.get_by_ip(ip)
        target_ip, slave_index = ip, 0
        if target_pdu:
            target_ip, slave_index, _role = _chain_source_for(target_pdu)
        print(f"[DEBUG] Calling set_outlet_status_via_http ip={target_ip} slave={slave_index} outlet={outlet} state={state}")
        success, error = set_outlet_status_via_http(
            target_ip,
            outlet,
            state,
            slave=slave_index,
        )
        
        print(f"[DEBUG] Control result: success={success}, error={error}")
        if success:
            pdu = PDURepo.get_by_ip(ip)
            if pdu and pdu.get("web_admin_port"):
                # Remote web-admin PDU (e.g. NPDU): patch the outlet cache right away
                # (single /getoutput read) so the Outlets panel reflects the new state
                # within ~1s instead of waiting up to 30s for the next poll cycle.
                try:
                    time.sleep(0.4)  # let the relay settle before reading back
                    patch_outlet_cache(ip)
                except Exception as e:
                    print(f"[DEBUG] Remote refresh after toggle failed (non-fatal): {e}")
            else:
                # Local SNMP PDU: priority SNMP poll for this outlet
                try:
                    poll_outlet_status_priority(ip, outlet)
                except Exception as e:
                    print(f"[DEBUG] Priority polling error (non-fatal): {str(e)}")
            return jsonify({"status": "success", "state": state})
            
        return jsonify({"error": error or "Failed to set outlet status"}), 500
        
    except Exception as e:
        print(f"[DEBUG] Exception in set_outlet_status: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Internal error: {str(e)}"}), 500

# ------------------------------ Poller Thread ------------------------------ #
def poller():
    """Background polling thread that continuously fetches all configured OIDs.
    Uses snmpget in small batches for reliable polling.
    """
    global POLL_RESULTS, POLL_ERRORS
    while not POLL_STOP:
        cfg = load_config()
        if not cfg or "ip" not in cfg:
            print("[poller] No configuration present; sleeping 2 s")
            time.sleep(2)
            continue

        ip = cfg["ip"]
        port = int(cfg.get("port", 161))
        symbols: List[Tuple[str, str]] = cfg.get("symbols", [])

        cycle_start = time.time()
        print(f"[poller] Cycle start {time.strftime('%H:%M:%S')} with {len(symbols)} symbols")

        # Build task list for parallel polling of both generic symbols and outlets
        generic_symbols = [pair for pair in symbols 
                         if not pair[0].startswith("Output") 
                         and not any(pair[0].startswith(slave) for slave in ["SlaveOne", "SlaveTwo", "SlaveThree", "SlaveFour"])]

        def fetch_generic_batch(batch: list[tuple[str, str]]):
            """Poll a batch of generic (non-outlet) symbols and return list of tuples."""
            names: list[str] = []
            oids: list[str] = []
            for n, o in batch:
                names.append(n)
                oids.append(o if o.endswith(".0") else f"{o}.0")
            print(f"[poller] polling generic batch of {len(batch)} OIDs ...")
            mapping = snmp_get_batch(ip, port, oids)
            return [(names[i], oids[i], mapping.get(oids[i])) for i in range(len(oids))]

        def fetch_outlet(outlet: int):
            """Poll a single outlet (two 2-OID batches) and return list of tuples."""
            tuples: list[tuple[str, str, Any]] = []
            # Batch 1: Status + Current (higher retries/timeout for critical metrics)
            status_oid = f"{OUTPUT_PREFIXES['Status']}.{outlet}.0"
            current_oid = f"{OUTPUT_PREFIXES['Current']}.{outlet}.0"
            mapping1 = snmp_get_batch(ip, port, [status_oid, current_oid], retries=4, timeout=4)
            tuples.append((f"Output{outlet}Status", status_oid, mapping1.get(status_oid)))
            tuples.append((f"Output{outlet}Current", current_oid, mapping1.get(current_oid)))

            # Batch 2: Energy + Name (standard retries/timeout for non-critical metrics)
            energy_oid = f"{OUTPUT_PREFIXES['Energy']}.{outlet}.0"
            name_oid = f"{OUTPUT_PREFIXES['Name']}.{outlet}.0"
            mapping2 = snmp_get_batch(ip, port, [energy_oid, name_oid])
            tuples.append((f"Output{outlet}Energy", energy_oid, mapping2.get(energy_oid)))
            tuples.append((f"Output{outlet}Name", name_oid, mapping2.get(name_oid)))
            return tuples

        # Prepare batches for generic symbols
        generic_batches = [generic_symbols[i : i + SNMP_BATCH_SIZE] for i in range(0, len(generic_symbols), SNMP_BATCH_SIZE)]

        # Interleave generic and outlet polling tasks for true parallelism
        tasks = []
        with ThreadPoolExecutor(max_workers=MAX_SNMP_THREADS) as executor:
            # Submit tasks in a round-robin fashion
            generic_iter = iter(generic_batches)
            outlet_range = range(1, OUTPUT_COUNT + 1)
            outlet_iter = iter(outlet_range)
            
            while True:
                # Try to submit a generic batch
                try:
                    batch = next(generic_iter)
                    tasks.append(executor.submit(fetch_generic_batch, batch))
                except StopIteration:
                    pass
                
                # Try to submit an outlet
                try:
                    outlet = next(outlet_iter)
                    tasks.append(executor.submit(fetch_outlet, outlet))
                except StopIteration:
                    pass
                
                # If both iterators are exhausted, we're done
                if len(tasks) == len(generic_batches) + OUTPUT_COUNT:
                    break

            # Collect results as they complete
            for fut in as_completed(tasks):
                try:
                    for name, oid_full, value in fut.result():
                        with POLL_LOCK:
                            if value is not None and not str(value).startswith("Error:"):
                                POLL_RESULTS[name] = {"name": name, "oid": oid_full, "value": value}
                                POLL_ERRORS.pop(name, None)
                            else:
                                POLL_ERRORS[name] = {"name": name, "oid": oid_full, "error": "No response"}
                                POLL_RESULTS.pop(name, None)
                except Exception as e:
                    print(f"[poller] Task error: {e}")
        
        elapsed = time.time() - cycle_start
        print(f"[poller] Cycle finished in {elapsed:.2f}s")
        if elapsed < 2:
            time.sleep(2 - elapsed)


# ------------------------------ Multi-PDU Poller ------------------------------ #
# Global storage for multi-PDU results keyed by IP address
MULTI_PDU_RESULTS: Dict[str, Dict[str, Any]] = {}
MULTI_PDU_ERRORS: Dict[str, Dict[str, Any]] = {}
MULTI_PDU_LOCK = Lock()
MULTI_PDU_THREAD: Thread | None = None
MULTI_PDU_STOP = False

# --------------------------- NPDU daisy-chain topology --------------------------- #
# Slaves are not network-reachable on their own IP; their telemetry/outlets are
# read THROUGH their chain master's web CGI using a slave index. We resolve the
# master<->slave mapping from the hostname convention ("-1" master, "-2/3/4"
# slaves) and cache it briefly so request paths + the poller share one view.
import npdu_chain  # noqa: E402

_CHAIN_TTL = 30.0
_chain_cache: Dict[str, Any] = {"ts": 0.0, "slaves_by_master_ip": {}, "slave_ips": set()}
_chain_lock = Lock()


def _chain_topology(force: bool = False) -> Dict[str, Any]:
    """Resolve { master_ip -> [(slave_pdu, slave_index), ...] } and the set of
    slave IPs, cached for _CHAIN_TTL seconds. Derived from the hostname
    convention; a slave only counts if its "-1" master sibling exists."""
    now = time.time()
    with _chain_lock:
        if not force and (now - _chain_cache["ts"] < _CHAIN_TTL) and _chain_cache["ts"]:
            return _chain_cache
    try:
        pdus = PDURepo.get_all_active()
    except Exception:
        return _chain_cache
    by_hostname: Dict[str, Dict[str, Any]] = {}
    for p in pdus:
        hn = p.get("hostname") or p.get("label")
        if hn:
            by_hostname[hn] = p
    slaves_by_master_ip: Dict[str, list] = {}
    slave_ips: set = set()
    for p in pdus:
        hn = p.get("hostname") or p.get("label")
        parsed = npdu_chain.parse_suffix(hn)
        if not parsed:
            continue
        stem, idx = parsed
        if idx <= 1:
            continue  # master / standalone
        master = by_hostname.get(f"{stem}-1")
        master_ip = master.get("ip_address") if master else None
        if not master_ip:
            continue  # no reachable master sibling -> treat as standalone elsewhere
        slaves_by_master_ip.setdefault(master_ip, []).append((p, idx - 1))
        if p.get("ip_address"):
            slave_ips.add(p["ip_address"])
    snapshot = {"ts": now, "slaves_by_master_ip": slaves_by_master_ip, "slave_ips": slave_ips}
    with _chain_lock:
        _chain_cache.update(snapshot)
    return snapshot


def _chain_source_for(pdu: Dict[str, Any]) -> Tuple[str, int, str]:
    """Where should this PDU's telemetry be fetched from?

    Returns (source_ip, slave_index, role) where role is
    'master' | 'slave' | 'standalone'. Masters/standalone read their own IP at
    index 0; slaves read their master's IP at their slave index.
    """
    own_ip = pdu.get("ip_address")
    hn = pdu.get("hostname") or pdu.get("label")
    parsed = npdu_chain.parse_suffix(hn)
    if not parsed:
        return own_ip, 0, "standalone"
    _stem, idx = parsed
    if idx <= 1:
        return own_ip, 0, "master"
    topo = _chain_topology()
    for master_ip, slaves in topo["slaves_by_master_ip"].items():
        for slave_pdu, slave_index in slaves:
            if slave_pdu.get("ip_address") == own_ip:
                return master_ip, slave_index, "slave"
    return own_ip, 0, "standalone"


def _is_chain_slave_ip(ip: str) -> bool:
    return ip in _chain_topology().get("slave_ips", set())


def _web_connect_target(host: str) -> Tuple[str, int, str, str]:
    """Where the web CGI actually lives for this hall IP.

    Daisy slaves have no Ethernet NIC — login / network / SNMP CGI is on the
    chain master. Returns (connect_ip, slave_index, role, master_hostname).
    """
    try:
        pdu = PDURepo.get_by_ip(host)
    except Exception:
        pdu = None
    if not pdu:
        return host, 0, "unknown", ""
    src, idx, role = _chain_source_for(pdu)
    connect = src or host
    master_hn = ""
    if role == "slave" and src:
        try:
            master = PDURepo.get_by_ip(src)
        except Exception:
            master = None
        master_hn = (master or {}).get("hostname") or (master or {}).get("label") or src
    return connect, idx, role, master_hn


def _merge_npdu_tele_into(tele: Dict[str, Any], results: Dict[str, Any]) -> None:
    """Transform an NPDU get_live_telemetry() dict into poller `results` entries."""
    _skip = {"csrf", "breakers", "datetime", "alarm_flags",
             "l1_color", "l2_color", "l3_color", "name", "firmware"}
    for key, val in tele.items():
        if key in _skip or key.startswith("field_"):
            continue
        results[key] = {"name": key, "oid": f"web:{key}", "value": str(val)}

    _aliases = {
        "MasterVoltageP1": "l1_voltage", "MasterCurrentP1": "l1_current",
        "MasterPowerP1": "l1_active_power",
        "MasterVoltageP2": "l2_voltage", "MasterVoltageP3": "l3_voltage",
        "TotalCurrent": "neutral_current", "TotalPower": "total_active_power",
        "TotalEnergy": "total_active_energy",
    }
    for alias, cgi_key in _aliases.items():
        if cgi_key in tele:
            results[alias] = {"name": alias, "oid": f"web:{cgi_key}", "value": str(tele[cgi_key])}

    for i, br in enumerate(tele.get("breakers", []), 1):
        results[f"Output{i}Status"] = {
            "name": f"Output{i}Status", "oid": f"web:breaker_{i}",
            "value": br.get("status", "0"),
        }

    alarm_flags = tele.get("alarm_flags", [])
    results["_alarm_flags"] = {
        "name": "_alarm_flags", "oid": "web:alarm_flags", "value": json.dumps(alarm_flags),
    }
    results["_alarm_count"] = {
        "name": "_alarm_count", "oid": "web:alarm_count", "value": str(len(alarm_flags)),
    }


def _poll_chain_slaves(master_ip: str, client) -> None:
    """Fan-out: read each chained slave's telemetry via the master's session and
    write it into the slave's own-IP cache (slaves are unreachable directly).
    Best-effort; never raises into the master poll."""
    slaves = _chain_topology()["slaves_by_master_ip"].get(master_ip, [])
    for slave_pdu, slave_index in slaves:
        slave_ip = slave_pdu.get("ip_address")
        if not slave_ip:
            continue
        try:
            tele = client.get_live_telemetry(slave=slave_index)
            sresults: Dict[str, Any] = {}
            _merge_npdu_tele_into(tele, sresults)
            _apply_outlet_load_alarms(slave_ip, sresults)
            with MULTI_PDU_LOCK:
                MULTI_PDU_RESULTS[slave_ip] = sresults
                MULTI_PDU_ERRORS[slave_ip] = {}
            _remote_pdu_last_poll[slave_ip] = time.time()
            _pdu_consecutive_failures[slave_ip] = 0
            _remote_pdu_last_error.pop(slave_ip, None)
            try:
                store_poll_snapshot(slave_ip, sresults)
            except Exception:
                pass
            print(f"[poll_remote] {master_ip} chain -> a{slave_index} {slave_ip}: {len(sresults)} keys")
        except Exception as e:
            print(f"[poll_remote] {master_ip} slave a{slave_index} {slave_ip} read failed: {e}")


def _poll_remote_pdu(
    pdu: Dict[str, Any], *, _allow_repair: bool = True
) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
    """Poll a remote PDU via its web admin CGI panel.
    Uses non-blocking lock acquisition: if the client is busy (e.g. settings
    panel open), skip this cycle and return cached results instead of blocking
    the entire poller thread."""
    ip = pdu["ip_address"]
    host, web_port, web_user, web_pass, use_https = _web_admin_creds_from_pdu(pdu)

    if _is_pdu_session_held(host):
        print(f"[poll_remote] {ip} skipped — PDU Settings session active")
        with MULTI_PDU_LOCK:
            cached = MULTI_PDU_RESULTS.get(ip, {})
        return ip, cached, {}

    if _is_batch_commission_active(ip):
        print(f"[poll_remote] {ip} skipped — batch commissioning active")
        with MULTI_PDU_LOCK:
            cached = MULTI_PDU_RESULTS.get(ip, {})
        return ip, cached, {}

    results = {}
    errors = {}

    # Fast TCP reachability pre-check. Unreachable IPs otherwise burn ~100s each
    # (443 connect-timeout + 5 login retries, then 80) and starve the worker pool
    # so the genuinely-online PDUs never get polled. We probe candidate ports with
    # a short timeout and only attempt login on ports that are actually open,
    # trying the DB-configured endpoint first (HTTP:80 for NPDU).
    import socket as _socket

    def _port_open(p: int, to: float = 1.5) -> bool:
        s = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        s.settimeout(to)
        try:
            return s.connect_ex((host, int(p))) == 0
        except Exception:
            return False
        finally:
            try:
                s.close()
            except Exception:
                pass

    poll_plans: list[tuple[int, bool]] = []
    seen_plans: set[tuple[int, bool]] = set()
    for poll_port, poll_https in [
        (web_port, use_https),
        (_DEFAULT_WEB_ADMIN_PORT, False),
        (443, True),
    ]:
        key = (int(poll_port), bool(poll_https))
        if key in seen_plans:
            continue
        seen_plans.add(key)
        if _port_open(poll_port):
            poll_plans.append(key)

    if not poll_plans:
        msg = f"unreachable — no open web port ({host}:{web_port}/80/443)"
        return ip, {}, {"_unreachable": {"name": "_unreachable", "oid": "web:probe", "value": msg}}

    last_err: Exception | None = None
    winning_plan: tuple[int, bool] | None = None
    winning_creds: tuple[str, str] | None = None

    cred_sets: list[tuple[str, str, str]] = [(web_user, web_pass, "db")]
    if (web_user, web_pass) != ("admin", "admin"):
        cred_sets.append(("admin", "admin", "factory"))

    for cred_user, cred_pass, cred_src in cred_sets:
        for poll_port, poll_https in poll_plans:
            _evict_pdu_client(host, poll_port, poll_https)
            client = _get_pdu_client(host, poll_port, cred_user, cred_pass, use_https=poll_https)
            if poll_port != web_port or poll_https != use_https or cred_src != "db":
                scheme = "HTTPS" if poll_https else "HTTP"
                print(
                    f"[poll_remote] {ip} trying {scheme}:{poll_port} "
                    f"({cred_src} creds) — DB has {'HTTPS' if use_https else 'HTTP'}:{web_port}"
                )

            if not client._lock.acquire(blocking=False):
                print(f"[poll_remote] {ip} skipped — client busy (settings/admin)")
                with MULTI_PDU_LOCK:
                    cached = MULTI_PDU_RESULTS.get(ip, {})
                return ip, cached, {}

            try:
                tele = client.get_live_telemetry()
                _merge_npdu_tele_into(tele, results)

                # Daisy-chain fan-out: this master also serves its slaves' data
                # via the slave index. Read each chained slave over the SAME
                # live session and write to that slave's own-IP cache (slaves are
                # not reachable on their own IP). NPDU firmware only.
                if isinstance(client, NPDUWebClient):
                    try:
                        _poll_chain_slaves(ip, client)
                    except Exception as _ce:
                        print(f"[poll_remote] {ip} chain fan-out error: {_ce}")

                last_err = None
                winning_plan = (poll_port, poll_https)
                winning_creds = (cred_user, cred_pass)
                break

            except Exception as e:
                last_err = e
                errors["_remote"] = {"name": "_remote", "error": str(e)}
                with MULTI_PDU_LOCK:
                    results = MULTI_PDU_RESULTS.get(ip, {})
                print(
                    f"[poll_remote] {ip} error on {'HTTPS' if poll_https else 'HTTP'} "
                    f"({cred_src} creds): {e}"
                )
            finally:
                try:
                    client.logout()
                except Exception:
                    pass
                client._lock.release()

        if winning_plan:
            break

    db_updates: Dict[str, Any] = {}
    if winning_plan and (winning_plan[0] != web_port or winning_plan[1] != use_https):
        wp, wh = winning_plan
        print(f"[poll_remote] {ip} auto-corrected DB → {'https' if wh else 'http'}:{wp}")
        db_updates["web_admin_port"] = wp
        db_updates["web_admin_https"] = wh
    if winning_creds and winning_creds != (web_user, web_pass):
        cu, cp = winning_creds
        print(f"[poll_remote] {ip} auto-corrected credentials → user={cu!r}")
        db_updates["web_admin_user"] = cu
        db_updates["web_admin_pass"] = cp
    if db_updates:
        PDURepo.upsert(pdu["hall_id"], ip, db_updates)

    if last_err is not None and not results:
        repaired, repair_msg = _repair_pdu_web_credentials(pdu)
        if _allow_repair and repaired:
            fresh = PDURepo.get_by_ip(ip)
            if fresh:
                return _poll_remote_pdu(fresh, _allow_repair=False)
        return ip, results, errors

    if results:
        _apply_outlet_load_alarms(ip, results)

    return ip, results, errors


## ---------------------------------------------------------------------------
## SNMP OID definitions for both MIB families
## ---------------------------------------------------------------------------

# npdu-n-v2-bu.MIB  (enterprise 23273)  – older / string-valued
_E23273 = ".1.3.6.1.4.1.23273.3.1.1"
_NPDU_TELEMETRY_OIDS: List[Tuple[str, str]] = [
    # Per-phase voltage / current / power / PF / energy
    ("MasterVoltageP1",  f"{_E23273}.2.1.0"),
    ("MasterCurrentP1",  f"{_E23273}.2.2.0"),
    ("MasterPowerP1",    f"{_E23273}.2.3.0"),
    ("MasterPFP1",       f"{_E23273}.2.4.0"),
    ("MasterEnergyP1",   f"{_E23273}.2.5.0"),
    ("MasterVoltageP2",  f"{_E23273}.3.1.0"),
    ("MasterCurrentP2",  f"{_E23273}.3.2.0"),
    ("MasterPowerP2",    f"{_E23273}.3.3.0"),
    ("MasterPFP2",       f"{_E23273}.3.4.0"),
    ("MasterEnergyP2",   f"{_E23273}.3.5.0"),
    ("MasterVoltageP3",  f"{_E23273}.4.1.0"),
    ("MasterCurrentP3",  f"{_E23273}.4.2.0"),
    ("MasterPowerP3",    f"{_E23273}.4.3.0"),
    ("MasterPFP3",       f"{_E23273}.4.4.0"),
    ("MasterEnergyP3",   f"{_E23273}.4.5.0"),
    # Sensors (masterSerson = masterpdu.11)
    ("MasterTemperature1", f"{_E23273}.11.1.0"),
    ("MasterTemperature2", f"{_E23273}.11.2.0"),
    ("MasterTemperature3", f"{_E23273}.11.3.0"),
    ("MasterTemperature4", f"{_E23273}.11.4.0"),
    ("MasterHumidity1",   f"{_E23273}.11.5.0"),
    ("MasterHumidity2",   f"{_E23273}.11.6.0"),
    ("MasterHumidity3",   f"{_E23273}.11.7.0"),
    ("MasterHumidity4",   f"{_E23273}.11.8.0"),
    # Info
    ("MasterDeviceName",  f"{_E23273}.1.1.0"),
    ("MasterDeviceMac",   f"{_E23273}.1.4.0"),
]

# PDUMIBV07.mib  (enterprise 23280)  – newer / integer-valued
_E23280 = ".1.3.6.1.4.1.23280"
_V07_DEVICE_OIDS: List[Tuple[str, str]] = [
    ("deviceStatusActivePower",        f"{_E23280}.2.1.5.1"),
    ("deviceStatusReactivePower",      f"{_E23280}.2.1.6.1"),
    ("deviceStatusApparentPower",      f"{_E23280}.2.1.7.1"),
    ("deviceStatusPowerFactor",        f"{_E23280}.2.1.8.1"),
    ("deviceStatusActiveEnergy",       f"{_E23280}.2.1.9.1"),
    ("deviceStatusReactiveEnergy",     f"{_E23280}.2.1.10.1"),
    ("deviceStatusFrequency",          f"{_E23280}.2.1.11.1"),
    ("deviceStatusZeroLineCurrent",    f"{_E23280}.2.1.12.1"),
    ("deviceStatusThreePhaseUnbalance", f"{_E23280}.2.1.13.1"),
]
_V07_PHASE_OIDS: List[Tuple[str, str]] = []
for _ph in (1, 2, 3):
    _pfx = f"phase{_ph}"
    _V07_PHASE_OIDS += [
        (f"{_pfx}Voltage",        f"{_E23280}.6.1.2.{_ph}"),
        (f"{_pfx}Current",        f"{_E23280}.6.1.3.{_ph}"),
        (f"{_pfx}ActivePower",    f"{_E23280}.6.1.4.{_ph}"),
        (f"{_pfx}ReactivePower",  f"{_E23280}.6.1.5.{_ph}"),
        (f"{_pfx}ApparentPower",  f"{_E23280}.6.1.6.{_ph}"),
        (f"{_pfx}PowerFactor",    f"{_E23280}.6.1.7.{_ph}"),
        (f"{_pfx}ActiveEnergy",   f"{_E23280}.6.1.8.{_ph}"),
        (f"{_pfx}ReactiveEnergy", f"{_E23280}.6.1.9.{_ph}"),
        # Alarm limit states (1=normal, 2=upper, 3=lower)
        (f"{_pfx}VoltageLimitState",  f"{_E23280}.6.1.10.{_ph}"),
        (f"{_pfx}CurrentLimitState",  f"{_E23280}.6.1.11.{_ph}"),
    ]
_V07_SENSOR_OIDS: List[Tuple[str, str]] = []
for _si in (1, 2, 3, 4):
    _V07_SENSOR_OIDS += [
        (f"sensor{_si}Temperature",        f"{_E23280}.12.1.2.{_si}"),
        (f"sensor{_si}Humidity",           f"{_E23280}.12.1.3.{_si}"),
        (f"sensor{_si}TempLimitState",     f"{_E23280}.12.1.4.{_si}"),
        (f"sensor{_si}HumidityLimitState", f"{_E23280}.12.1.5.{_si}"),
        (f"sensor{_si}IOSensorState",      f"{_E23280}.12.1.6.{_si}"),
    ]

# Cache: per-IP which enterprise the PDU responds to ("23273", "23280", or None)
_pdu_mib_family: Dict[str, str] = {}

def _detect_mib_family(ip: str, port: int, snmp_version: str = "2c") -> str:
    """Probe one OID from each enterprise to figure out which MIB the PDU supports."""
    cached = _pdu_mib_family.get(ip)
    if cached:
        return cached
    probe_23273 = snmp_get_batch(ip, port, [f"{_E23273}.2.1.0"], retries=1, timeout=2, snmp_version=snmp_version)
    val = probe_23273.get(f"{_E23273}.2.1.0")
    if val and not str(val).startswith("Error:") and str(val).strip():
        _pdu_mib_family[ip] = "23273"
        print(f"[MIB detect] {ip} → enterprise 23273 (npdu-n-v2)")
        return "23273"
    probe_23280 = snmp_get_batch(ip, port, [f"{_E23280}.2.1.5.1"], retries=1, timeout=2, snmp_version=snmp_version)
    val = probe_23280.get(f"{_E23280}.2.1.5.1")
    if val and not str(val).startswith("Error:") and str(val).strip():
        _pdu_mib_family[ip] = "23280"
        print(f"[MIB detect] {ip} → enterprise 23280 (PDUMIBV07)")
        return "23280"
    _pdu_mib_family[ip] = "23273"
    print(f"[MIB detect] {ip} → no response from either probe, defaulting to 23273")
    return "23273"


def _snmp_fetch_oids(ip: str, port: int, oid_list: List[Tuple[str, str]],
                     results: Dict, errors: Dict, retries: int = 3, timeout: int = 3, snmp_version: str = "2c"):
    """Fetch a list of (name, oid) tuples via SNMP and populate results/errors."""
    if not oid_list:
        return
    mapping = snmp_get_batch(ip, port, [oid for _, oid in oid_list], retries=retries, timeout=timeout, snmp_version=snmp_version)
    for name, oid in oid_list:
        value = mapping.get(oid)
        if value is not None and not str(value).startswith("Error:"):
            results[name] = {"name": name, "oid": oid, "value": str(value)}
        else:
            errors[name] = {"name": name, "oid": oid, "error": "No response"}


def _build_snmp_alarm_flags(results: Dict, mib_family: str) -> List[Dict]:
    """Extract alarm flags from SNMP results.
    For 23280: limit states 2=upper, 3=lower are alarms.
    For 23273: no native alarm OIDs exist, but we include sensor IO states if present."""
    import json
    alarm_flags = []

    if mib_family == "23280":
        _LIMIT_MAP = {1: "Normal", 2: "Upper Limit", 3: "Lower Limit"}
        _IO_MAP = {1: "Normal", 2: "Alarm"}
        phase_checks = [
            ("l1_voltage",  "phase1VoltageLimitState"),
            ("l1_current",  "phase1CurrentLimitState"),
            ("l2_voltage",  "phase2VoltageLimitState"),
            ("l2_current",  "phase2CurrentLimitState"),
            ("l3_voltage",  "phase3VoltageLimitState"),
            ("l3_current",  "phase3CurrentLimitState"),
        ]
        for param, key in phase_checks:
            entry = results.get(key)
            if entry:
                val = int(entry["value"]) if str(entry["value"]).isdigit() else 0
                if val in (2, 3):
                    alarm_flags.append({"param": param, "status": _LIMIT_MAP[val], "color": "red"})
                # Store as alarm_ field for frontend consistency
                results[f"alarm_{param}"] = {
                    "name": f"alarm_{param}", "oid": entry["oid"],
                    "value": _LIMIT_MAP.get(val, "Normal"),
                }

        for si in (1, 2, 3, 4):
            for kind, key_suffix in [("temp", "TempLimitState"), ("hum", "HumidityLimitState")]:
                key = f"sensor{si}{key_suffix}"
                entry = results.get(key)
                if entry:
                    val = int(entry["value"]) if str(entry["value"]).isdigit() else 0
                    if val in (2, 3):
                        alarm_flags.append({"param": f"{kind}{si}", "status": _LIMIT_MAP[val], "color": "red"})
                    results[f"alarm_{kind}{si}"] = {
                        "name": f"alarm_{kind}{si}", "oid": entry["oid"],
                        "value": _LIMIT_MAP.get(val, "Normal"),
                    }
            io_key = f"sensor{si}IOSensorState"
            entry = results.get(io_key)
            if entry:
                val = int(entry["value"]) if str(entry["value"]).isdigit() else 0
                if val == 2:
                    alarm_flags.append({"param": f"sensor{si}", "status": "Alarm", "color": "red"})
                results[f"alarm_sensor{si}"] = {
                    "name": f"alarm_sensor{si}", "oid": entry["oid"],
                    "value": _IO_MAP.get(val, "Normal"),
                }

    results["_alarm_flags"] = {
        "name": "_alarm_flags", "oid": "snmp:alarm_flags",
        "value": json.dumps(alarm_flags),
    }
    results["_alarm_count"] = {
        "name": "_alarm_count", "oid": "snmp:alarm_count",
        "value": str(len(alarm_flags)),
    }
    return alarm_flags


def _apply_outlet_load_alarms(ip: str, results: Dict[str, Any]) -> None:
    """Detect unplugged loads on energized outlets and merge into alarm flags."""
    if not ip or not results:
        return
    try:
        from polling.outlet_load_monitor import apply_outlet_load_alarms
        apply_outlet_load_alarms(ip, results)
    except Exception as exc:
        print(f"[outlet_load_monitor] {ip}: {exc}")


def poll_single_pdu(pdu: Dict[str, Any]) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
    """Poll a single PDU and return (ip, results, errors).
    Uses web admin CGI for remote PDUs, SNMP for local PDUs.
    SNMP auto-detects whether the PDU uses enterprise 23273 (npdu-n-v2)
    or 23280 (PDUMIBV07) and fetches the full telemetry + alarm set."""
    if pdu.get("web_admin_port"):
        return _poll_remote_pdu(pdu)

    ip = pdu["ip_address"]
    port = pdu.get("snmp_port", 161)
    sv = pdu.get("snmp_version", "2c") or "2c"

    results: Dict[str, Any] = {}
    errors: Dict[str, Any] = {}

    mib = _detect_mib_family(ip, port, snmp_version=sv)

    if mib == "23273":
        _snmp_fetch_oids(ip, port, _NPDU_TELEMETRY_OIDS, results, errors, snmp_version=sv)
        # Convenience aliases for the dashboard (expects TotalCurrent, TotalPower, etc.)
        _alias_map = {
            "TotalCurrent": "MasterCurrentP1",
            "TotalPower":   "MasterPowerP1",
            "TotalEnergy":  "MasterEnergyP1",
        }
        for alias, src in _alias_map.items():
            if src in results and alias not in results:
                results[alias] = {"name": alias, "oid": results[src]["oid"], "value": results[src]["value"]}
        # Also map CGI-compatible keys for consistent frontend display
        _cgi_compat = {
            "l1_voltage": "MasterVoltageP1", "l1_current": "MasterCurrentP1",
            "l1_active_power": "MasterPowerP1", "l1_pf": "MasterPFP1",
            "l1_active_energy": "MasterEnergyP1",
            "l2_voltage": "MasterVoltageP2", "l2_current": "MasterCurrentP2",
            "l2_active_power": "MasterPowerP2", "l2_pf": "MasterPFP2",
            "l2_active_energy": "MasterEnergyP2",
            "l3_voltage": "MasterVoltageP3", "l3_current": "MasterCurrentP3",
            "l3_active_power": "MasterPowerP3", "l3_pf": "MasterPFP3",
            "l3_active_energy": "MasterEnergyP3",
            "neutral_current": "MasterCurrentP1",
            "total_active_power": "MasterPowerP1",
            "total_active_energy": "MasterEnergyP1",
        }
        for cgi_key, src in _cgi_compat.items():
            if src in results and cgi_key not in results:
                results[cgi_key] = {"name": cgi_key, "oid": f"snmp:{cgi_key}", "value": results[src]["value"]}

    else:
        _snmp_fetch_oids(ip, port, _V07_DEVICE_OIDS, results, errors, snmp_version=sv)
        _snmp_fetch_oids(ip, port, _V07_PHASE_OIDS, results, errors, snmp_version=sv)
        _snmp_fetch_oids(ip, port, _V07_SENSOR_OIDS, results, errors, snmp_version=sv)

        # --- Scale raw integer values per PDUMIBV07.mib spec ---
        # -1 means "not applicable / sensor absent" — replace with None
        _V07_SCALE = {
            # Device-level
            "deviceStatusActivePower":        (1, "W"),     # Units: 1 W
            "deviceStatusReactivePower":      (1, "VAR"),
            "deviceStatusApparentPower":      (1, "VA"),
            "deviceStatusPowerFactor":        (1000, ""),   # Units: 0.1% → raw 1000 = PF 1.000
            "deviceStatusActiveEnergy":       (1000, "kWh"),  # Wh → kWh
            "deviceStatusReactiveEnergy":     (1000, "kVARh"),
            "deviceStatusFrequency":          (1000, "Hz"),  # Units: 0.001 Hz
            "deviceStatusZeroLineCurrent":    (100, "A"),    # Units: 0.01 A
            "deviceStatusThreePhaseUnbalance": (1, "%"),
        }
        for _ph in (1, 2, 3):
            _pfx = f"phase{_ph}"
            _V07_SCALE[f"{_pfx}Voltage"]        = (10, "V")      # Units: 0.1 V
            _V07_SCALE[f"{_pfx}Current"]        = (100, "A")     # Units: 0.01 A
            _V07_SCALE[f"{_pfx}ActivePower"]    = (1, "W")
            _V07_SCALE[f"{_pfx}ReactivePower"]  = (1, "VAR")
            _V07_SCALE[f"{_pfx}ApparentPower"]  = (1, "VA")
            _V07_SCALE[f"{_pfx}PowerFactor"]    = (1000, "")     # Units: 0.1% → PF ratio
            _V07_SCALE[f"{_pfx}ActiveEnergy"]   = (1000, "kWh")  # Wh → kWh
            _V07_SCALE[f"{_pfx}ReactiveEnergy"] = (1000, "kVARh")

        for key, (divisor, _unit) in _V07_SCALE.items():
            if key in results:
                try:
                    raw = int(results[key]["value"])
                    if raw == -1:
                        # -1 = not applicable / not connected
                        del results[key]
                        continue
                    scaled = raw / divisor if divisor > 1 else raw
                    results[key]["value"] = str(round(scaled, 3))
                except (ValueError, TypeError):
                    pass

        # Detect phase count (single-phase if phase2Voltage is absent or was -1)
        phase_count = 1
        if "phase2Voltage" in results:
            phase_count = 3
        results["_phase_count"] = {"name": "_phase_count", "oid": "meta", "value": str(phase_count)}

        # Map to dashboard-expected keys
        _v07_alias = {
            "TotalCurrent": "deviceStatusZeroLineCurrent",
            "TotalPower": "deviceStatusActivePower",
            "TotalEnergy": "deviceStatusActiveEnergy",
            "Frequency": "deviceStatusFrequency",
            "MasterVoltageP1": "phase1Voltage",
            "MasterCurrentP1": "phase1Current",
            "MasterPowerP1": "phase1ActivePower",
            "MasterVoltageP2": "phase2Voltage",
            "MasterVoltageP3": "phase3Voltage",
        }
        for alias, src in _v07_alias.items():
            if src in results and alias not in results:
                results[alias] = {"name": alias, "oid": results[src]["oid"], "value": results[src]["value"]}

        # For single-phase: totals = phase 1 values (device-level may be -1/absent)
        if phase_count == 1:
            _sp_fallbacks = {
                "deviceStatusActivePower": "phase1ActivePower",
                "deviceStatusReactivePower": "phase1ReactivePower",
                "deviceStatusApparentPower": "phase1ApparentPower",
                "deviceStatusActiveEnergy": "phase1ActiveEnergy",
                "deviceStatusReactiveEnergy": "phase1ReactiveEnergy",
                "deviceStatusZeroLineCurrent": "phase1Current",
            }
            for dev_key, phase_key in _sp_fallbacks.items():
                if dev_key not in results and phase_key in results:
                    results[dev_key] = {"name": dev_key, "oid": results[phase_key]["oid"], "value": results[phase_key]["value"]}

        # CGI-compatible keys for consistent frontend display
        _v07_cgi = {
            "l1_voltage": "phase1Voltage", "l1_current": "phase1Current",
            "l1_active_power": "phase1ActivePower", "l1_reactive_power": "phase1ReactivePower",
            "l1_apparent_power": "phase1ApparentPower", "l1_pf": "phase1PowerFactor",
            "l1_active_energy": "phase1ActiveEnergy", "l1_reactive_energy": "phase1ReactiveEnergy",
            "frequency": "deviceStatusFrequency",
            "neutral_current": "deviceStatusZeroLineCurrent",
            "neutral_load_pct": "deviceStatusThreePhaseUnbalance",
            "total_active_power": "deviceStatusActivePower",
            "total_reactive_power": "deviceStatusReactivePower",
            "total_apparent_power": "deviceStatusApparentPower",
            "total_pf": "deviceStatusPowerFactor",
            "total_active_energy": "deviceStatusActiveEnergy",
            "total_reactive_energy": "deviceStatusReactiveEnergy",
        }
        if phase_count == 3:
            _v07_cgi.update({
                "l2_voltage": "phase2Voltage", "l2_current": "phase2Current",
                "l2_active_power": "phase2ActivePower", "l2_reactive_power": "phase2ReactivePower",
                "l2_apparent_power": "phase2ApparentPower", "l2_pf": "phase2PowerFactor",
                "l2_active_energy": "phase2ActiveEnergy", "l2_reactive_energy": "phase2ReactiveEnergy",
                "l3_voltage": "phase3Voltage", "l3_current": "phase3Current",
                "l3_active_power": "phase3ActivePower", "l3_reactive_power": "phase3ReactivePower",
                "l3_apparent_power": "phase3ApparentPower", "l3_pf": "phase3PowerFactor",
                "l3_active_energy": "phase3ActiveEnergy", "l3_reactive_energy": "phase3ReactiveEnergy",
            })
        for cgi_key, src in _v07_cgi.items():
            if src in results and cgi_key not in results:
                results[cgi_key] = {"name": cgi_key, "oid": f"snmp:{cgi_key}", "value": results[src]["value"]}

    # ---- Outlets (same OIDs for both MIBs – enterprise 23273 prefix) ----
    for outlet in range(1, 25):
        status_oid = f"{OUTPUT_PREFIXES['Status']}.{outlet}.0"
        current_oid = f"{OUTPUT_PREFIXES['Current']}.{outlet}.0"
        energy_oid = f"{OUTPUT_PREFIXES['Energy']}.{outlet}.0"
        name_oid = f"{OUTPUT_PREFIXES['Name']}.{outlet}.0"

        outlet_mapping = snmp_get_batch(ip, port, [status_oid, current_oid, energy_oid, name_oid], retries=2, timeout=2, snmp_version=sv)

        for metric, oid in [
            (f"Output{outlet}Status", status_oid),
            (f"Output{outlet}Current", current_oid),
            (f"Output{outlet}Energy", energy_oid),
            (f"Output{outlet}Name", name_oid)
        ]:
            value = outlet_mapping.get(oid)
            if value is not None and not str(value).startswith("Error:"):
                results[metric] = {"name": metric, "oid": oid, "value": str(value)}
            else:
                errors[metric] = {"name": metric, "oid": oid, "error": "No response"}

    # ---- Build alarm flags (consistent with HTTP/CGI format) ----
    _build_snmp_alarm_flags(results, mib)
    _apply_outlet_load_alarms(ip, results)

    return ip, results, errors


_REMOTE_PDU_POLL_INTERVAL = 30  # seconds between web admin polls (avoid session churn)
_LOCAL_PDU_POLL_INTERVAL = 10   # seconds between SNMP polls for local PDUs
_REMOTE_PDU_ERROR_BACKOFF = 90  # wait longer after a failure before retrying
_remote_pdu_last_poll: Dict[str, float] = {}
_remote_pdu_last_error: Dict[str, float] = {}  # track last failure time per IP

_pdu_consecutive_failures: Dict[str, int] = {}
_MAX_CONSECUTIVE_FAILURES = 5          # after 5 fails, back off to 5-minute intervals
_UNREACHABLE_BACKOFF = 300             # 5 minutes for PDUs that keep failing


def _is_ip_reachable(ip: str, timeout: float = 2.0) -> bool:
    """Quick TCP probe on port 161 (SNMP) or ICMP-like check."""
    import socket
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((ip, 161))
        sock.close()
        return result == 0
    except Exception:
        return False


def multi_pdu_poller():
    """Background polling thread for active PDUs.
    Only polls PDUs that are reachable and respects per-PDU intervals."""
    global MULTI_PDU_RESULTS, MULTI_PDU_ERRORS
    
    while not MULTI_PDU_STOP:
        try:
            if _poller_is_paused():
                time.sleep(1)
                continue

            all_pdus = PDURepo.get_all_active()
            
            if not all_pdus:
                time.sleep(10)
                continue
            
            cycle_start = time.time()
            now = time.time()

            # Refresh daisy-chain topology; slaves are polled THROUGH their
            # master (fan-out in _poll_remote_pdu), never on their own IP.
            chain_slave_ips = _chain_topology(force=True).get("slave_ips", set())

            pdus_to_poll = []
            for pdu in all_pdus:
                ip = pdu.get("ip_address", "")
                if not ip:
                    continue
                if ip in chain_slave_ips:
                    continue  # filled by its chain master's poll

                last = _remote_pdu_last_poll.get(ip, 0)
                last_err = _remote_pdu_last_error.get(ip, 0)
                fails = _pdu_consecutive_failures.get(ip, 0)

                # Determine polling interval based on PDU type and health
                if fails >= _MAX_CONSECUTIVE_FAILURES:
                    interval = _UNREACHABLE_BACKOFF
                elif pdu.get("web_admin_port"):
                    interval = _REMOTE_PDU_ERROR_BACKOFF if last_err > last else _REMOTE_PDU_POLL_INTERVAL
                else:
                    interval = _LOCAL_PDU_POLL_INTERVAL

                if now - max(last, last_err) < interval:
                    continue
                pdus_to_poll.append(pdu)

            if not pdus_to_poll:
                time.sleep(2)
                continue

            print(f"[multi_pdu_poller] Polling {len(pdus_to_poll)} PDUs (of {len(all_pdus)} active)...")
            
            with ThreadPoolExecutor(max_workers=min(len(pdus_to_poll), 8)) as executor:
                futures = {executor.submit(poll_single_pdu, pdu): pdu for pdu in pdus_to_poll}
                
                for future in as_completed(futures, timeout=120):
                    pdu_obj = futures[future]
                    ip = pdu_obj.get("ip_address", "")
                    try:
                        ip, results, errors = future.result(timeout=60)
                        with MULTI_PDU_LOCK:
                            if results:
                                MULTI_PDU_RESULTS[ip] = results
                                MULTI_PDU_ERRORS[ip] = errors
                            else:
                                MULTI_PDU_ERRORS[ip] = errors
                                if ip not in MULTI_PDU_RESULTS:
                                    MULTI_PDU_RESULTS[ip] = {}
                        
                        _remote_pdu_last_poll[ip] = time.time()
                        if errors and not results:
                            _remote_pdu_last_error[ip] = time.time()
                            _pdu_consecutive_failures[ip] = _pdu_consecutive_failures.get(ip, 0) + 1
                        else:
                            if ip in _remote_pdu_last_error:
                                del _remote_pdu_last_error[ip]
                            _pdu_consecutive_failures[ip] = 0

                        if results:
                            try:
                                store_poll_snapshot(ip, results)
                            except Exception as e:
                                print(f"[multi_pdu_poller] Error storing snapshot for {ip}: {e}")
                                
                    except Exception as e:
                        print(f"[multi_pdu_poller] Error polling {ip}: {e}")
                        _remote_pdu_last_poll[ip] = time.time()
                        _remote_pdu_last_error[ip] = time.time()
                        _pdu_consecutive_failures[ip] = _pdu_consecutive_failures.get(ip, 0) + 1
            
            elapsed = time.time() - cycle_start
            print(f"[multi_pdu_poller] Cycle finished in {elapsed:.2f}s for {len(pdus_to_poll)} PDUs")
            
            sleep_time = max(5 - elapsed, 1)
            time.sleep(sleep_time)
            
        except Exception as e:
            print(f"[multi_pdu_poller] Unexpected error: {e}")
            time.sleep(5)


def ensure_multi_pdu_poller():
    """Ensure the multi-PDU poller thread is running."""
    global MULTI_PDU_THREAD, MULTI_PDU_STOP
    if MULTI_PDU_THREAD is None or not MULTI_PDU_THREAD.is_alive():
        MULTI_PDU_STOP = False
        MULTI_PDU_THREAD = Thread(target=multi_pdu_poller, daemon=True)
        MULTI_PDU_THREAD.start()
        print("[multi_pdu_poller] Started background polling thread")
    ensure_outlet_fast_poller()


def force_remote_pdu_refresh(ip: str) -> bool:
    """Immediately re-poll a remote web-admin PDU and update the cache.

    The background poller only refreshes remote PDUs every ~30s, so after an
    outlet toggle (or explicit trigger) we poll once synchronously and write
    MULTI_PDU_RESULTS so the very next /live read reflects the new outlet state.
    Returns True if fresh results were obtained."""
    pdu = PDURepo.get_by_ip(ip)
    if not (pdu and pdu.get("web_admin_port")):
        return False
    try:
        _ip, results, errors = poll_single_pdu(pdu)
        with MULTI_PDU_LOCK:
            if results:
                MULTI_PDU_RESULTS[ip] = results
                MULTI_PDU_ERRORS[ip] = errors
            else:
                MULTI_PDU_ERRORS[ip] = errors
        _remote_pdu_last_poll[ip] = time.time()
        return bool(results)
    except Exception as e:
        print(f"[force_refresh] {ip} failed: {e}")
        return False


def patch_outlet_cache(ip: str) -> bool:
    """Fast outlet-only cache refresh after a switched-outlet toggle.

    For NPDU we read just /getoutput (one cheap CGI call) and patch the
    Output{N}* keys in MULTI_PDU_RESULTS, blocking briefly for the client lock
    so it never gets skipped (unlike the full poll's non-blocking acquire).
    Falls back to a full re-poll for non-NPDU web PDUs. Keeps outlet UX snappy
    without waiting for the 30s background cycle."""
    pdu = PDURepo.get_by_ip(ip)
    if not (pdu and pdu.get("web_admin_port")):
        return False

    # Daisy chain: a slave's outlets live on the master at its slave index.
    src_ip, slave_index, role = _chain_source_for(pdu)
    creds_pdu = pdu
    if role == "slave":
        creds_pdu = PDURepo.get_by_ip(src_ip) or pdu
    host, web_port, web_user, web_pass, use_https = _web_admin_creds_from_pdu(creds_pdu)
    if not _is_npdu_endpoint(host, web_port, use_https):
        return force_remote_pdu_refresh(ip)

    client = _get_pdu_client(host, web_port, web_user, web_pass, use_https=use_https)
    got = client._lock.acquire(timeout=8)
    try:
        outlets = client.get_outlets(slave=slave_index)
    except Exception as e:
        print(f"[patch_outlets] {ip} (slave={slave_index}) failed: {e}")
        return False
    finally:
        if got:
            client._lock.release()

    with MULTI_PDU_LOCK:
        results = MULTI_PDU_RESULTS.get(ip)
        if results is None:
            results = {}
            MULTI_PDU_RESULTS[ip] = results
        for o in outlets:
            n = o["index"]
            results[f"Output{n}Status"] = {
                "name": f"Output{n}Status", "oid": f"web:outlet_{n}",
                "value": "on" if o["state"] == "on" else "off"}
            results[f"Output{n}Current"] = {
                "name": f"Output{n}Current", "oid": f"web:outlet_{n}_cur",
                "value": str(o.get("current", "0"))}
            results[f"Output{n}Energy"] = {
                "name": f"Output{n}Energy", "oid": f"web:outlet_{n}_energy",
                "value": str(o.get("energy", "0"))}
        _apply_outlet_load_alarms(ip, results)
    return True


_OUTLET_FAST_POLL_INTERVAL = float(os.getenv("OUTLET_FAST_POLL_INTERVAL", "1.5"))
_OUTLET_FAST_POLL_ENABLED = os.getenv("OUTLET_FAST_POLL_ENABLED", "1").strip().lower() not in (
    "0", "false", "no", "off",
)
_OUTLET_FAST_THREAD: Optional[Thread] = None
_OUTLET_FAST_STOP = False
_outlet_fast_last_poll: Dict[str, float] = {}


def patch_snmp_outlet_cache(ip: str, outlet_nums: Optional[List[int]] = None) -> bool:
    """Fast SNMP refresh of outlet status/current for cable-unplug detection."""
    pdu = PDURepo.get_by_ip(ip)
    if not pdu or pdu.get("web_admin_port"):
        return False

    port = int(pdu.get("snmp_port") or 161)
    sv = pdu.get("snmp_version", "2c") or "2c"

    with MULTI_PDU_LOCK:
        cached = MULTI_PDU_RESULTS.get(ip) or {}

    if outlet_nums is None:
        try:
            from polling.outlet_load_monitor import outlets_for_fast_snmp_poll
            outlet_nums = outlets_for_fast_snmp_poll(ip, cached)
        except Exception:
            outlet_nums = []
    if not outlet_nums:
        return False

    patch: Dict[str, Any] = {}
    errors: Dict[str, Any] = {}
    for outlet in outlet_nums:
        status_oid = f"{OUTPUT_PREFIXES['Status']}.{outlet}.0"
        current_oid = f"{OUTPUT_PREFIXES['Current']}.{outlet}.0"
        mapping = snmp_get_batch(
            ip, port, [status_oid, current_oid],
            retries=1, timeout=2, snmp_version=sv,
        )
        for metric, oid in [
            (f"Output{outlet}Status", status_oid),
            (f"Output{outlet}Current", current_oid),
        ]:
            value = mapping.get(oid)
            if value is not None and not str(value).startswith("Error:"):
                patch[metric] = {"name": metric, "oid": oid, "value": str(value)}
            else:
                errors[metric] = {"name": metric, "oid": oid, "error": "No response"}

    if not patch:
        return False

    with MULTI_PDU_LOCK:
        results = MULTI_PDU_RESULTS.setdefault(ip, {})
        results.update(patch)
        if errors:
            err_bucket = MULTI_PDU_ERRORS.setdefault(ip, {})
            err_bucket.update(errors)
        _apply_outlet_load_alarms(ip, results)
    return True


def _fast_patch_outlet_cache(ip: str) -> bool:
    """Outlet-only refresh for web-admin or SNMP PDUs."""
    pdu = PDURepo.get_by_ip(ip)
    if not pdu:
        return False
    if pdu.get("web_admin_port"):
        return patch_outlet_cache(ip)
    return patch_snmp_outlet_cache(ip)


def outlet_fast_poller():
    """High-priority loop: refresh loaded outlets every ~1.5s for near-real-time unplug alarms."""
    global _outlet_fast_last_poll
    print(
        f"[outlet_fast_poller] Started (interval={_OUTLET_FAST_POLL_INTERVAL}s, "
        f"enabled={_OUTLET_FAST_POLL_ENABLED})"
    )
    while not _OUTLET_FAST_STOP:
        try:
            if not _OUTLET_FAST_POLL_ENABLED or _poller_is_paused():
                time.sleep(1)
                continue

            with MULTI_PDU_LOCK:
                cache_snapshot = {ip: dict(res) for ip, res in MULTI_PDU_RESULTS.items()}

            try:
                from polling.outlet_load_monitor import ips_for_fast_outlet_poll
                watch_ips = ips_for_fast_outlet_poll(cache_snapshot)
            except Exception as exc:
                print(f"[outlet_fast_poller] watch list failed: {exc}")
                time.sleep(_OUTLET_FAST_POLL_INTERVAL)
                continue

            if not watch_ips:
                time.sleep(_OUTLET_FAST_POLL_INTERVAL)
                continue

            now = time.time()
            due = [
                ip for ip in watch_ips
                if now - _outlet_fast_last_poll.get(ip, 0) >= _OUTLET_FAST_POLL_INTERVAL
            ]
            if not due:
                time.sleep(0.25)
                continue

            cycle_start = now
            with ThreadPoolExecutor(max_workers=min(len(due), 6)) as executor:
                futures = {executor.submit(_fast_patch_outlet_cache, ip): ip for ip in due}
                for future in as_completed(futures, timeout=30):
                    ip = futures[future]
                    try:
                        if future.result(timeout=12):
                            _outlet_fast_last_poll[ip] = time.time()
                    except Exception as exc:
                        print(f"[outlet_fast_poller] {ip}: {exc}")

            elapsed = time.time() - cycle_start
            sleep_for = max(_OUTLET_FAST_POLL_INTERVAL - elapsed, 0.2)
            time.sleep(sleep_for)
        except Exception as exc:
            print(f"[outlet_fast_poller] Unexpected error: {exc}")
            time.sleep(2)


def ensure_outlet_fast_poller():
    """Ensure the high-priority outlet fast-poll thread is running."""
    global _OUTLET_FAST_THREAD, _OUTLET_FAST_STOP
    if not _OUTLET_FAST_POLL_ENABLED:
        return
    if _OUTLET_FAST_THREAD is None or not _OUTLET_FAST_THREAD.is_alive():
        _OUTLET_FAST_STOP = False
        _OUTLET_FAST_THREAD = Thread(target=outlet_fast_poller, daemon=True)
        _OUTLET_FAST_THREAD.start()


@app.route("/api/config", methods=["POST"])
def post_config():
    body: Dict[str, Any] = request.get_json(force=True)
    ip = body.get("ip")
    # Use port 1663 as default for this specific PDU
    port = int(body.get("port", 1663))
    mib_text = body.get("mib", "")

    if not ip or not mib_text:
        return jsonify({"error": "Missing required fields"}), 400

    # Parse MIB and save config
    print("\nParsing MIB file...")
    oids = parse_mib_text(mib_text)
    print("\nParsed OIDs:")
    for name, oid in oids:
        print(f"{name}: {oid}")
    
    # Save both the parsed OIDs and the original MIB text
    cfg = {
        "ip": ip,
        "port": port,
        "mib": mib_text,
        "oids": oids
    }
    save_config(cfg)

    return jsonify({"success": True, "oids": oids}), 201


@app.route("/api/data", methods=["GET"])
def get_pdu_data():
    try:
        global POLL_THREAD, POLL_STOP

        # Ensure background poller is running
        if POLL_THREAD is None or not POLL_THREAD.is_alive():
            POLL_STOP = False
            POLL_THREAD = Thread(target=poller, daemon=True)
            POLL_THREAD.start()

        # Return current snapshot immediately – frontend fills placeholders
        # and updates every 5s (as currently implemented).
        with POLL_LOCK:
            results_snapshot = list(POLL_RESULTS.values())
            errors_snapshot = list(POLL_ERRORS.values())

        # Persist to DB (legacy)
        try:
            cfg_cur = load_config()
            store_poll_results(cfg_cur.get("ip"), POLL_RESULTS)
        except Exception as e:
            print(f"[DB] store_poll_results error: {e}")
        
        # Persist to new persistence layer (full JSON payload)
        try:
            cfg_cur = load_config()
            if cfg_cur.get("ip"):
                store_poll_snapshot(cfg_cur.get("ip"), POLL_RESULTS)
        except Exception as e:
            print(f"[DB] store_poll_snapshot error: {e}")

        return jsonify({
            "ip": load_config().get("ip"),
            "results": results_snapshot,
            "errors": errors_snapshot,
            "status": "partial" if results_snapshot and errors_snapshot else "success" if results_snapshot else "error" if errors_snapshot else "unknown"
        })
    except Exception as e:
        print(f"Error in get_pdu_data: {str(e)}")
        return jsonify({"error": f"Server error: {str(e)}"}), 500


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/test", methods=["GET"])
def test_snmp():
    ip = "218.16.58.43"
    port = 1663
    oid = ".1.3.6.1.2.1.1.3"  # system uptime
    results = []

    # Test different SNMP versions and community strings
    versions = ["1", "2c"]
    communities = ["public", "private", "admin"]

    for version in versions:
        for community in communities:
            try:
                cmd = [
                    "snmpget",
                    f"-v{version}",
                    "-c", community,
                    "-t", "2",  # timeout in seconds
                    "-r", "3",   # number of retries
                    f"{ip}:{port}",
                    oid
                ]
                
                try:
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
                    
                    if result.returncode != 0:
                        result["error"] = f"Error: {process.stderr}"
                    else:
                        output = process.stdout.strip()
                        if "=" in output:
                            value = output.split("=")[1].split(":", 1)[1].strip().strip('"')
                            result["success"] = True
                            result["value"] = value

                    results.append(result)
                    
                except subprocess.TimeoutExpired:
                    results.append({
                        "version": f"v{version}",
                        "community": community,
                        "success": False,
                        "error": "Timeout: Command took too long to complete",
                        "value": None
                    })
                except Exception as e:
                    results.append({
                        "version": f"v{version}",
                        "community": community,
                        "success": False,
                        "error": f"Exception: {str(e)}",
                        "value": None
                    })

            except subprocess.TimeoutExpired:
                results.append({
                    "version": f"v{version}",
                    "community": community,
                    "success": False,
                    "error": "Timeout: Command took too long to complete",
                    "value": None
                })
            except Exception as e:
                results.append({
                    "version": f"v{version}",
                    "community": community,
                    "success": False,
                    "error": f"Exception: {str(e)}",
                    "value": None
                })

    return jsonify(results)


@app.route("/api/maintenance/ask", methods=["POST"])
def maintenance_ask():
    data = request.get_json(force=True)
    question = data.get("question", "") if isinstance(data, dict) else ""
    if not question:
        return jsonify({"error": "question required"}), 400
    try:
        response = pm_answer(question)
        return jsonify({"answer": response})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/maintenance/alerts", methods=["GET"])
def maintenance_alerts():
    try:
        with _connect() as conn:
            alerts = conn.execute(
                "SELECT id, outlet_id, ts_utc, type, severity, message FROM maintenance_alert ORDER BY ts_utc DESC LIMIT 100"
            ).fetchall()
        return jsonify([
            {
                "id": row[0],
                "outlet_id": row[1],
                "ts": row[2],
                "type": row[3],
                "severity": row[4],
                "message": row[5],
            }
            for row in alerts
        ])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
# HALL STATE PERSISTENCE API
# =============================================================================

@app.route("/api/halls", methods=["GET"])
def get_halls():
    """Get all data halls."""
    try:
        halls = HallRepo.get_all()
        return jsonify({"halls": halls})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls", methods=["POST"])
def create_hall():
    """Create a new data hall."""
    try:
        data = request.get_json(force=True)
        name = data.get("name", "New Hall")
        description = data.get("description")
        hall_id = HallRepo.create(name, description)
        return jsonify({"id": hall_id, "name": name}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/<int:hall_id>", methods=["PUT"])
def rename_hall(hall_id: int):
    """Rename a data hall."""
    try:
        data = request.get_json(force=True)
        name = data.get("name")
        if not name or not name.strip():
            return jsonify({"error": "Name is required"}), 400
        HallRepo.rename(hall_id, name.strip())
        return jsonify({"success": True, "id": hall_id, "name": name.strip()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/<int:hall_id>", methods=["DELETE"])
def delete_hall(hall_id: int):
    """Delete a data hall and all its configs, racks, PDUs."""
    try:
        hall = HallRepo.get(hall_id)
        if not hall:
            return jsonify({"error": "Hall not found"}), 404
        HallRepo.delete(hall_id)
        return jsonify({"success": True, "message": f"Hall '{hall['name']}' deleted"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/<int:hall_id>/state", methods=["GET"])
def get_hall_state(hall_id: int):
    """Get complete hall state including config, racks, and PDUs."""
    try:
        state = HallRepo.get_full_state(hall_id)
        if not state:
            return jsonify({"error": "Hall not found"}), 404
        if not is_coordinator_authenticated():
            state = sanitize_hall_state(state)
        return jsonify(state)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/racks/<int:rack_id>", methods=["PATCH"])
def patch_rack(rack_id: int):
    """Update rack metadata (currently: custom display label)."""
    try:
        data = request.get_json(force=True) or {}
        rack = RackRepo.get(rack_id)
        if not rack:
            return jsonify({"error": "Rack not found"}), 404
        if "label" not in data:
            return jsonify({"error": "No fields to update"}), 400
        raw = data.get("label")
        label = (str(raw).strip() or None) if raw is not None else None
        if not RackRepo.update_label(rack_id, label):
            return jsonify({"error": "Update failed"}), 500
        updated = RackRepo.get(rack_id)
        return jsonify({"success": True, "rack": updated})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/<int:hall_id>/state", methods=["POST"])
def save_hall_state_endpoint(hall_id: int):
    """Save complete hall state (config + racks + PDUs)."""
    try:
        data = request.get_json(force=True)
        config = data.get("config", {})
        racks = data.get("racks", [])
        pdus = data.get("pdus", [])
        
        # Ensure hall exists
        hall = HallRepo.get(hall_id)
        if not hall:
            return jsonify({"error": "Hall not found"}), 404
        
        save_hall_state(hall_id, config, racks, pdus)
        return jsonify({"success": True, "message": "Hall state saved"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/default", methods=["GET"])
def get_default_hall():
    """Get or create default hall and return its state."""
    try:
        hall_id = HallRepo.get_or_create_default()
        state = HallRepo.get_full_state(hall_id)
        if not is_coordinator_authenticated():
            state = sanitize_hall_state(state)
        return jsonify(state)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/reporting/hall-customer/pdf", methods=["POST"])
def hall_customer_report_pdf():
    """Server-side A4 PDF — same method as Hyperspace executive reports (PDFKit → ReportLab)."""
    try:
        from hall_report_pdf import hall_report_filename, render_hall_report_pdf

        data = request.get_json(silent=True) or {}
        pdf_bytes = render_hall_report_pdf(data)
        name = hall_report_filename(data.get("hallName") or "Data hall")
        resp = make_response(pdf_bytes)
        resp.headers["Content-Type"] = "application/pdf"
        resp.headers["Content-Disposition"] = f'attachment; filename="{name}"'
        resp.headers["Cache-Control"] = "no-store"
        return resp
    except Exception as e:
        print(f"[hall-customer-pdf] Failed to render PDF: {e}")
        return jsonify({"error": "Failed to render PDF", "message": str(e)}), 500


# =============================================================================
# TELEMETRY HISTORY API
# =============================================================================

@app.route("/api/pdus/<int:pdu_id>/telemetry/latest", methods=["GET"])
def get_pdu_telemetry_latest(pdu_id: int):
    """Get latest telemetry for a PDU."""
    try:
        telemetry = TelemetryRepo.get_latest(pdu_id)
        if not telemetry:
            return jsonify({"error": "No telemetry found"}), 404
        return jsonify(telemetry)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdus/<int:pdu_id>/telemetry", methods=["GET"])
def get_pdu_telemetry_history(pdu_id: int):
    """Get telemetry history for a PDU."""
    try:
        from_ts = request.args.get("from")
        to_ts = request.args.get("to")
        limit = int(request.args.get("limit", 1000))
        
        history = TelemetryRepo.get_history(pdu_id, from_ts, to_ts, limit)
        return jsonify({"telemetry": history, "count": len(history)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdus/by-ip/<path:ip_address>/telemetry/latest", methods=["GET"])
def get_pdu_telemetry_by_ip(ip_address: str):
    """Get latest telemetry for a PDU by IP address."""
    try:
        pdu = PDURepo.get_by_ip(ip_address)
        if not pdu:
            return jsonify({"error": "PDU not found"}), 404
        
        telemetry = TelemetryRepo.get_latest(pdu["id"])
        if not telemetry:
            return jsonify({"error": "No telemetry found"}), 404
        return jsonify(telemetry)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdus/by-ip/<path:ip_address>/telemetry/chart", methods=["GET"])
def get_pdu_telemetry_chart(ip_address: str):
    """Get historical telemetry data formatted for charts.
    
    Query params:
    - period: day, week, month (default: day)
    - limit: max data points (default: 500)
    """
    try:
        from datetime import datetime, timedelta
        import re as _re
        
        pdu = PDURepo.get_by_ip(ip_address)
        if not pdu:
            return jsonify({"error": "PDU not found"}), 404
        
        period = request.args.get("period", "day")
        limit = int(request.args.get("limit", 500))
        
        now = datetime.now()
        if period == "week":
            from_time = now - timedelta(days=7)
        elif period == "month":
            from_time = now - timedelta(days=30)
        else:
            from_time = now - timedelta(days=1)
        
        from_ts = from_time.isoformat()
        
        history = TelemetryRepo.get_history(pdu["id"], from_ts=from_ts, to_ts=None, limit=limit)
        
        def _parse_numeric(raw):
            """Extract leading number from strings like '224.6V', '0.000kW', '1.000'."""
            if raw is None:
                return 0.0
            if isinstance(raw, (int, float)):
                return float(raw)
            s = str(raw).replace('"', '').strip()
            m = _re.match(r'^-?[\d.]+', s)
            return float(m.group()) if m else 0.0

        chart_data = []
        for entry in reversed(history):
            payload = entry.get("payload", {})
            
            def _first(*keys):
                for k in keys:
                    if k in payload:
                        return _parse_numeric(payload[k])
                return 0.0
            
            power   = _first("MasterPowerP1", "total_active_power", "l1_active_power")
            voltage = _first("MasterVoltageP1", "l1_voltage")
            current = _first("MasterCurrentP1", "l1_current")
            energy  = _first("MasterEnergyP1", "total_active_energy")
            
            if power > 0 or voltage > 0:
                chart_data.append({
                    "ts": entry.get("ts_utc"),
                    "power": power,
                    "voltage": voltage,
                    "current": current,
                    "energy": energy
                })
        
        return jsonify({
            "period": period,
            "from": from_ts,
            "to": now.isoformat(),
            "count": len(chart_data),
            "data": chart_data
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdus/by-ip/<path:ip_address>/live", methods=["GET"])
def get_pdu_live_data_by_ip(ip_address: str):
    """Get live polling data for a PDU by IP address.
    Remote PDUs: reads from MULTI_PDU_RESULTS cache (populated every 30s by
    the background poller) to avoid stealing the PDU's single web session.
    Local PDUs: uses adaptive poller (SNMP-based)."""
    try:
        pdu = PDURepo.get_by_ip(ip_address)

        # --- Remote PDU: use background poller cache (no direct web calls) ---
        if pdu and pdu.get("web_admin_port"):
            ensure_multi_pdu_poller()
            with MULTI_PDU_LOCK:
                results = MULTI_PDU_RESULTS.get(ip_address, {})
                errors = MULTI_PDU_ERRORS.get(ip_address, {})
            if not results and not errors:
                return jsonify({
                    "ip": ip_address, "results": [], "errors": [],
                    "status": "pending",
                    "message": "Waiting for first remote poll cycle (~30s)",
                    "source": "web_admin",
                })
            return jsonify({
                "ip": ip_address,
                "results": list(results.values()),
                "errors": list(errors.values()),
                "status": "partial" if errors else "success",
                "source": "web_admin",
            })

        # --- Local PDU: use multi_pdu_poller (same scaling as remote) ---
        ensure_multi_pdu_poller()
        
        with MULTI_PDU_LOCK:
            results = MULTI_PDU_RESULTS.get(ip_address, {})
            errors = MULTI_PDU_ERRORS.get(ip_address, {})
        
        if not results and not errors:
            if not pdu:
                return jsonify({"error": "PDU not found in database", "ip": ip_address}), 404
            return jsonify({
                "ip": ip_address,
                "results": [],
                "errors": [],
                "status": "pending",
                "message": "Waiting for first poll cycle"
            })
        
        return jsonify({
            "ip": ip_address,
            "results": list(results.values()),
            "errors": list(errors.values()),
            "status": "partial" if errors else "success"
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
# EVENTS API
# =============================================================================

@app.route("/api/events", methods=["GET"])
def get_events():
    """Get events with optional filtering."""
    try:
        status = request.args.get("status")
        limit = int(request.args.get("limit", 100))
        offset = int(request.args.get("offset", 0))
        
        events = EventRepo.get_history(limit, offset, status)
        return jsonify({"events": events, "count": len(events)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/events/active", methods=["GET"])
def get_active_events():
    """Get all active events."""
    try:
        pdu_id = request.args.get("pdu_id", type=int)
        hall_id = request.args.get("hall_id", type=int)
        
        events = EventRepo.get_active(pdu_id, hall_id)
        return jsonify({"events": events, "count": len(events)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/events/<int:event_id>/clear", methods=["POST"])
def clear_event(event_id: int):
    """Clear an event."""
    try:
        EventRepo.clear(event_id)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/events/<int:event_id>/acknowledge", methods=["POST"])
def acknowledge_event(event_id: int):
    """Acknowledge an event."""
    try:
        data = request.get_json(force=True) if request.data else {}
        acknowledged_by = data.get("acknowledged_by")
        EventRepo.acknowledge(event_id, acknowledged_by)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
# SUPPORT DEBUG API
# =============================================================================

def _debug_app_version() -> str:
    ver = os.getenv("BUILD_VERSION", "").strip()
    if ver:
        return ver
    try:
        import subprocess
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        short = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=root, stderr=subprocess.DEVNULL, text=True
        ).strip()
        count = subprocess.check_output(
            ["git", "rev-list", "--count", "HEAD"], cwd=root, stderr=subprocess.DEVNULL, text=True
        ).strip()
        return f"git-b{count}.{short}"
    except Exception:
        return "unknown"


def _debug_tcp_reachable(host: str, port: int, timeout: float = 2.0) -> bool:
    import socket
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        ok = sock.connect_ex((host, int(port))) == 0
        sock.close()
        return ok
    except Exception:
        return False


def _build_support_debug_report() -> Dict[str, Any]:
    """Collect DB + poller sanity checks for remote customer support."""
    from datetime import datetime, timezone

    db_path = os.path.join(os.getenv("DATA_DIR", "data"), "pdumind.db")
    db_exists = os.path.isfile(db_path)
    db_size_mb = round(os.path.getsize(db_path) / (1024 * 1024), 2) if db_exists else 0

    halls = HallRepo.get_all()
    from db.persistence import _connect, _db_lock
    with _db_lock:
        conn = _connect()
        try:
            cur = conn.execute(
                """SELECT p.*, r.rack_code
                   FROM pdus p
                   LEFT JOIN racks r ON p.rack_id = r.id
                   ORDER BY p.hall_id, p.ip_address"""
            )
            all_pdus_db = [dict(row) for row in cur.fetchall()]
        finally:
            conn.close()

    issues: List[str] = []
    pdu_rows: List[Dict[str, Any]] = []

    for pdu in sorted(all_pdus_db, key=lambda p: (p.get("hall_id") or 0, p.get("ip_address") or "")):
        ip = pdu.get("ip_address") or ""
        host = pdu.get("remote_host") or ip
        web_port = pdu.get("web_admin_port")
        web_user = (pdu.get("web_admin_user") or "").strip()
        web_pass = (pdu.get("web_admin_pass") or "").strip()
        use_https = bool(pdu.get("web_admin_https"))
        is_active = bool(pdu.get("is_active", 1))
        commissioned = False
        meta_raw = pdu.get("metadata_json")
        if meta_raw:
            try:
                commissioned = bool(json.loads(meta_raw).get("commissioned"))
            except Exception:
                pass

        creds_ok = bool(web_port and web_user and web_pass)
        pass_state = "SET" if web_pass else "EMPTY"

        db_anomalies: List[str] = []
        if is_active and not web_port:
            db_anomalies.append("DB_MISSING_PORT")
        if is_active and not web_pass:
            db_anomalies.append("DB_MISSING_PASSWORD")
        if is_active and not web_user:
            db_anomalies.append("DB_MISSING_USER")
        if web_port and int(web_port) == 443 and not use_https:
            db_anomalies.append("DB_HTTPS_FLAG_WRONG")
        if web_port and int(web_port) == 80 and use_https:
            db_anomalies.append("DB_HTTP_FLAG_WRONG")

        tcp_443 = _debug_tcp_reachable(host, 443) if ip and is_active else None
        tcp_80 = _debug_tcp_reachable(host, 80) if ip and is_active else None
        network_reachable = bool(tcp_443 or tcp_80) if is_active else None

        with MULTI_PDU_LOCK:
            cached = MULTI_PDU_RESULTS.get(ip, {})
            cache_errors = MULTI_PDU_ERRORS.get(ip, {})
        cache_count = len(cached) if cached else 0

        row_issues: List[str] = []
        recommended_action = None
        if not is_active:
            recommended_action = "Inactive placeholder — ignore unless commissioning this rack"
        elif not network_reachable:
            recommended_action = "Connect PDU to network first, then run Repair"
            row_issues.append("network unreachable (443/80 closed)")
        elif db_anomalies and network_reachable:
            recommended_action = "Run Commissioning → Repair with password that works in Chrome"
            if "DB_MISSING_PASSWORD" in db_anomalies:
                row_issues.append("DB password wiped — Repair will restore after login")
            if "DB_MISSING_PORT" in db_anomalies:
                row_issues.append("DB web port missing — Repair will auto-detect HTTPS/HTTP")
        elif creds_ok and cache_count == 0:
            recommended_action = "Credentials OK — wait ~30s for telemetry or run Repair"
            row_issues.append("no cached telemetry yet")
        elif creds_ok:
            recommended_action = "Healthy"
        else:
            recommended_action = "Run Repair with correct web admin password"

        if is_active and not web_port:
            row_issues.append("missing web_admin_port")
        if is_active and web_port and not web_pass:
            row_issues.append("missing web_admin_pass")
        if is_active and web_port and not web_user:
            row_issues.append("missing web_admin_user")
        if is_active and not creds_ok and network_reachable:
            row_issues.append("PDU online but DB credentials incomplete")

        pdu_rows.append({
            "id": pdu.get("id"),
            "hall_id": pdu.get("hall_id"),
            "ip": ip,
            "label": pdu.get("label") or pdu.get("hostname") or "",
            "rack": pdu.get("rack_code") or pdu.get("location") or "",
            "is_active": is_active,
            "web_admin_port": web_port,
            "web_admin_https": use_https,
            "web_admin_user": web_user or "(empty)",
            "web_admin_pass": pass_state,
            "credentials_ok": creds_ok,
            "commissioned_metadata": commissioned,
            "db_anomalies": db_anomalies,
            "network_reachable": network_reachable,
            "tcp_443": tcp_443,
            "tcp_80": tcp_80,
            "telemetry_cache_fields": cache_count,
            "cache_errors": len(cache_errors),
            "issues": row_issues,
            "recommended_action": recommended_action,
        })

    active_pdus = [p for p in pdu_rows if p["is_active"]]
    inactive_count = len(pdu_rows) - len(active_pdus)
    creds_ok_count = sum(1 for p in active_pdus if p["credentials_ok"])
    missing_port = sum(1 for p in active_pdus if not p.get("web_admin_port"))
    missing_pass = sum(1 for p in active_pdus if p.get("web_admin_pass") == "EMPTY")
    network_down = sum(1 for p in active_pdus if p.get("network_reachable") is False)
    db_corrupt = sum(1 for p in active_pdus if p.get("db_anomalies"))

    with MULTI_PDU_LOCK:
        cache_ips = list(MULTI_PDU_RESULTS.keys())

    recommendations: List[str] = []
    if not active_pdus:
        recommendations.append("No active PDUs — commission PDUs in the Data Hall first")
    elif network_down == len(active_pdus):
        recommendations.append("No active PDU reachable on network — check power, cabling, and Docker LAN access")
    elif db_corrupt and network_down < len(active_pdus):
        recommendations.append(
            "Database credentials corrupted but PDUs are online — run Commissioning → Repair "
            "with the password that works in Chrome (batch may have changed it from admin/admin)"
        )
    elif creds_ok_count == len(active_pdus) and len(cache_ips) < creds_ok_count:
        recommendations.append("Credentials OK — wait 30s for telemetry cache or restart containers")

    if active_pdus and missing_port:
        issues.append(
            f"CRITICAL: {missing_port}/{len(active_pdus)} active PDUs missing web_admin_port "
            "— telemetry/polling uses SNMP fallback"
        )
    if active_pdus and missing_pass:
        issues.append(f"WARNING: {missing_pass} PDUs have web port but empty password — web login will fail")
    if active_pdus and creds_ok_count == 0:
        issues.append("CRITICAL: no active PDU has complete web credentials — run Commissioning → Repair")
    elif active_pdus and creds_ok_count < len(active_pdus):
        issues.append(f"WARNING: only {creds_ok_count}/{len(active_pdus)} PDUs have complete web credentials")

    if active_pdus and creds_ok_count and len(cache_ips) < creds_ok_count:
        issues.append(f"INFO: telemetry cache populated for {len(cache_ips)}/{creds_ok_count} web-ready PDUs")

    poller_running = MULTI_PDU_THREAD is not None and MULTI_PDU_THREAD.is_alive()
    if not poller_running:
        issues.append("CRITICAL: background PDU poller thread is not running")
    if _poller_is_paused():
        issues.append("INFO: PDU poller is paused (batch commission or settings session)")

    report = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "version": _debug_app_version(),
        "database": {
            "path": db_path,
            "exists": db_exists,
            "size_mb": db_size_mb,
        },
        "summary": {
            "halls": len(halls),
            "pdus_total": len(pdu_rows),
            "pdus_active": len(active_pdus),
            "pdus_inactive": inactive_count,
            "web_credentials_ok": creds_ok_count,
            "missing_web_port": missing_port,
            "missing_web_password": missing_pass,
            "network_unreachable": network_down,
            "db_anomaly_pdus": db_corrupt,
            "telemetry_cache_pdus": len(cache_ips),
            "poller_running": poller_running,
            "poller_paused": _poller_is_paused(),
            "issues_count": len(issues),
        },
        "recommendations": recommendations,
        "issues": issues,
        "halls": [{"id": h["id"], "name": h.get("name"), "description": h.get("description")} for h in halls],
        "active_pdus": active_pdus,
        "pdus": pdu_rows,
    }
    report["text"] = _format_support_debug_text(report)
    return report


def _format_support_debug_text(report: Dict[str, Any]) -> str:
    s = report["summary"]
    lines = [
        "=== PDUMind Support Debug Report ===",
        f"Generated: {report['generated_at']}",
        f"Version:   {report['version']}",
        "",
        "--- SUMMARY (active PDUs only) ---",
        f"Active PDUs:         {s['pdus_active']}",
        f"Inactive/placeholder:{s.get('pdus_inactive', 0)} (layout placeholders — ignore)",
        f"Web credentials OK:  {s['web_credentials_ok']} / {s['pdus_active']}",
        f"DB anomalies:        {s.get('db_anomaly_pdus', 0)} PDU(s)",
        f"Network unreachable:   {s.get('network_unreachable', 0)} PDU(s)",
        f"Missing web port:    {s.get('missing_web_port', 0)}",
        f"Missing password:    {s.get('missing_web_password', 0)}",
        f"Telemetry cache:     {s['telemetry_cache_pdus']} PDU(s)",
        f"Poller running:      {'yes' if s['poller_running'] else 'NO'}",
        f"Poller paused:       {'yes' if s['poller_paused'] else 'no'}",
        "",
        "--- RECOMMENDED ACTIONS ---",
    ]
    if report.get("recommendations"):
        for rec in report["recommendations"]:
            lines.append(f"  → {rec}")
    else:
        lines.append("  (none — system looks healthy for active PDUs)")

    lines.extend([
        "",
        f"--- ISSUES ({s['issues_count']}) ---",
    ])
    if report["issues"]:
        for issue in report["issues"]:
            lines.append(f"  • {issue}")
    else:
        lines.append("  (none detected)")

    lines.extend([
        "",
        "--- DATABASE ---",
        f"Path:   {report['database']['path']}",
        f"Exists: {'yes' if report['database']['exists'] else 'NO'}",
        f"Size:   {report['database']['size_mb']} MB",
        "",
        "--- ACTIVE PDUs (what matters) ---",
    ])

    active_by_hall: Dict[int, list] = {}
    for p in report.get("active_pdus") or []:
        active_by_hall.setdefault(p["hall_id"], []).append(p)

    if not active_by_hall:
        lines.append("  (no active PDUs)")
    for hall_id, pdus in sorted(active_by_hall.items()):
        hall_name = next((h["name"] for h in report["halls"] if h["id"] == hall_id), f"Hall {hall_id}")
        lines.append(f"")
        lines.append(f"[{hall_name} (id={hall_id})]")
        for p in pdus:
            https_tag = "HTTPS" if p["web_admin_https"] else "HTTP"
            port_disp = p["web_admin_port"] if p["web_admin_port"] else "MISSING"
            tcp = []
            if p["tcp_443"] is True:
                tcp.append("443:open")
            elif p["tcp_443"] is False:
                tcp.append("443:closed")
            if p["tcp_80"] is True:
                tcp.append("80:open")
            elif p["tcp_80"] is False:
                tcp.append("80:closed")
            tcp_str = ", ".join(tcp) if tcp else "n/a"
            anomaly_str = ",".join(p.get("db_anomalies") or []) or "none"
            lines.append(
                f"  {p['ip']} | port:{port_disp} ({https_tag}) | user:{p['web_admin_user']} | "
                f"pass:{p['web_admin_pass']} | network:{tcp_str} | cache:{p['telemetry_cache_fields']} | "
                f"DB issues:{anomaly_str}"
            )
            if p.get("recommended_action"):
                lines.append(f"    → {p['recommended_action']}")
            for ri in p.get("issues") or []:
                lines.append(f"    ! {ri}")

    inactive = [p for p in report["pdus"] if not p["is_active"]]
    if inactive:
        lines.extend([
            "",
            f"--- INACTIVE PLACEHOLDERS ({len(inactive)} total, truncated) ---",
            f"  {len(inactive)} layout IP placeholders — not real PDUs, safe to ignore.",
        ])
        if len(inactive) <= 5:
            for p in inactive:
                lines.append(f"  {p['ip']} (inactive)")

    lines.extend(["", "=== End of Report ==="])
    return "\n".join(lines)


@app.route("/api/debug/support-report", methods=["GET"])
@require_auth
def get_support_debug_report():
    """Generate a copy-paste support diagnostic report (no secrets exposed)."""
    try:
        report = _build_support_debug_report()
        return jsonify(report)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# =============================================================================
# ADAPTIVE POLLING API
# =============================================================================

# Use environment variable to switch between legacy and adaptive polling
USE_ADAPTIVE_POLLING = os.getenv("USE_ADAPTIVE_POLLING", "1") == "1"


def _get_adaptive_poller() -> AdaptivePoller:
    """Get or create the adaptive poller with telemetry storage callback."""
    def store_telemetry(ip: str, results: dict):
        try:
            store_poll_snapshot(ip, results)
        except Exception as e:
            print(f"[AdaptivePoller] Error storing telemetry for {ip}: {e}")
    
    config = AdaptivePollerConfig(
        db_path="data/pdumind.db",
        max_workers=int(os.getenv("MAX_POLL_WORKERS", "30")),
        snmp_community=os.getenv("SNMP_COMMUNITY", "private"),
    )
    return get_adaptive_poller(config, on_telemetry=store_telemetry)


def _ensure_adaptive_polling():
    """Initialize and start adaptive polling with local PDUs (SNMP).
    Remote PDUs (web_admin_port set) are handled by multi_pdu_poller instead."""
    poller = _get_adaptive_poller()
    pdus = PDURepo.get_all_active()
    local_pdus = [p for p in pdus if not p.get("web_admin_port")]
    remote_pdus = [p for p in pdus if p.get("web_admin_port")]
    poller.add_devices_from_db(local_pdus)
    if not poller._running:
        poller.start()
    if remote_pdus:
        ensure_multi_pdu_poller()
    return poller


@app.route("/api/polling/stats", methods=["GET"])
def get_polling_stats():
    """Get adaptive polling statistics."""
    try:
        if USE_ADAPTIVE_POLLING:
            poller = _get_adaptive_poller()
            return jsonify(poller.get_stats())
        else:
            return jsonify({"mode": "legacy", "message": "Adaptive polling disabled"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/polling/devices", methods=["GET"])
def get_polling_devices():
    """Get all devices with their polling states."""
    try:
        if USE_ADAPTIVE_POLLING:
            poller = _get_adaptive_poller()
            return jsonify(poller.get_devices_by_state())
        else:
            return jsonify({"mode": "legacy"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# --- Non-blocking reachability cache for remote (web-admin) PDUs -------------
# The reachability probe is a blocking TCP connect (seconds for an unreachable
# PDU). Running it inside the request made the fleet status sweep saturate the
# browser's per-origin connection pool and stall the critical hall-load calls.
# We serve last-known reachability from this cache and refresh it in a daemon
# thread, so the endpoint always returns in microseconds.
_REACH_CACHE: Dict[str, Dict[str, Any]] = {}
_REACH_INFLIGHT: set = set()
_REACH_LOCK = Lock()
_REACH_TTL = 15.0           # seconds a cached reachability value stays "fresh"
_REACH_PROBE_TIMEOUT = 2.0  # seconds for the background TCP connect


def _reach_probe(host: str, port: int) -> str:
    import socket as _socket
    sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
    sock.settimeout(_REACH_PROBE_TIMEOUT)
    try:
        sock.connect((host, int(port)))
        return "online"
    except Exception:
        return "offline"
    finally:
        try:
            sock.close()
        except Exception:
            pass


def _reach_refresh_async(ip: str, host: str, port) -> None:
    with _REACH_LOCK:
        if ip in _REACH_INFLIGHT:
            return
        _REACH_INFLIGHT.add(ip)

    def _run():
        try:
            state = _reach_probe(host, port)
            with _REACH_LOCK:
                _REACH_CACHE[ip] = {"state": state, "ts": time.time()}
        finally:
            with _REACH_LOCK:
                _REACH_INFLIGHT.discard(ip)

    Thread(target=_run, daemon=True).start()


@app.route("/api/polling/device/<path:ip_address>", methods=["GET"])
def get_polling_device_status(ip_address: str):
    """Get polling status for a specific device.
    For remote PDUs (web_admin_port set), returns cached reachability and
    refreshes it in the background — never blocks on a TCP probe."""
    try:
        pdu = PDURepo.get_by_ip(ip_address)
        if pdu and pdu.get("web_admin_port"):
            # Daisy chain: a slave is reachable only via its master, so its
            # live/offline state mirrors the master's reachability.
            src_ip, slave_index, role = _chain_source_for(pdu)
            if role == "slave":
                master_pdu = PDURepo.get_by_ip(src_ip)
                remote_host = (master_pdu.get("remote_host") if master_pdu else None) or src_ip
                web_port = (master_pdu or pdu).get("web_admin_port") or 80
            else:
                remote_host = request.args.get("remote_host") or pdu.get("remote_host") or ip_address
                web_port = pdu["web_admin_port"]

            with _REACH_LOCK:
                cached = _REACH_CACHE.get(ip_address)
            fresh = bool(cached) and (time.time() - cached["ts"] < _REACH_TTL)
            if not fresh:
                _reach_refresh_async(ip_address, remote_host, web_port)
            state = cached["state"] if cached else "offline"
            return jsonify({"state": state, "source": "web_admin", "chain_role": role, "cached": True})

        if USE_ADAPTIVE_POLLING:
            poller = _get_adaptive_poller()
            status = poller.get_device_status(ip_address)
            if status:
                return jsonify(status)
            return jsonify({"error": "Device not found"}), 404
        else:
            return jsonify({"mode": "legacy"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/polling/device/<path:ip_address>/trigger", methods=["POST"])
def trigger_device_poll(ip_address: str):
    """Trigger immediate poll for a device."""
    try:
        pdu = PDURepo.get_by_ip(ip_address)
        if pdu and pdu.get("web_admin_port"):
            ok = patch_outlet_cache(ip_address)
            return jsonify({"success": ok, "source": "web_admin",
                            "message": f"Outlet cache {'refreshed' if ok else 'skipped'} for {ip_address}"})
        if USE_ADAPTIVE_POLLING:
            poller = _get_adaptive_poller()
            poller.trigger_immediate_poll(ip_address)
            return jsonify({"success": True, "message": f"Poll triggered for {ip_address}"})
        else:
            return jsonify({"mode": "legacy", "message": "Use legacy polling"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
# MODEL UPLOAD API - Persistent storage for GLB/GLTF 3D models
# =============================================================================

MODELS_DIR = os.path.join(os.path.dirname(__file__), "data", "models")
os.makedirs(MODELS_DIR, exist_ok=True)

MIBS_DIR = os.path.join(os.path.dirname(__file__), "data", "mibs")
os.makedirs(MIBS_DIR, exist_ok=True)

@app.route("/api/models/upload", methods=["POST"])
def upload_model():
    """Upload a GLB/GLTF model file for persistent storage."""
    try:
        if 'file' not in request.files:
            return jsonify({"error": "No file provided"}), 400
        
        file = request.files['file']
        if not file.filename:
            return jsonify({"error": "No filename"}), 400
        
        # Sanitize filename
        import re
        safe_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', file.filename)
        
        # Add timestamp to avoid collisions
        import time
        timestamp = int(time.time())
        name_parts = safe_name.rsplit('.', 1)
        if len(name_parts) == 2:
            safe_name = f"{name_parts[0]}_{timestamp}.{name_parts[1]}"
        else:
            safe_name = f"{safe_name}_{timestamp}"
        
        filepath = os.path.join(MODELS_DIR, safe_name)
        file.save(filepath)
        
        # Return persistent URL
        url = f"/api/models/{safe_name}"
        return jsonify({
            "success": True,
            "url": url,
            "fileName": safe_name,
            "originalName": file.filename
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/models/<path:filename>", methods=["GET"])
def serve_model(filename: str):
    """Serve a stored model file."""
    try:
        filepath = os.path.join(MODELS_DIR, filename)
        if not os.path.exists(filepath):
            return jsonify({"error": "Model not found"}), 404
        
        from flask import send_file
        return send_file(filepath, mimetype='model/gltf-binary')
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
# MIB UPLOAD API - Upload and parse MIB files for OID mapping
# =============================================================================

@app.route("/api/mibs/upload", methods=["POST"])
def upload_mib():
    """Upload a MIB file, parse OID definitions, and persist to hall."""
    try:
        if 'file' not in request.files:
            return jsonify({"error": "No file provided"}), 400
        
        file = request.files['file']
        if not file.filename:
            return jsonify({"error": "No filename"}), 400
        
        hall_id = request.form.get("hall_id")
        
        import re
        safe_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', file.filename)
        filepath = os.path.join(MIBS_DIR, safe_name)
        file.save(filepath)
        
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            mib_content = f.read()
        
        oids = parse_mib_text(mib_content)
        oids_list = [{"name": name, "oid": oid} for name, oid in oids]
        
        mib_id = None
        if hall_id:
            mib_id = MibRepo.add(
                int(hall_id), safe_name, file.filename,
                len(oids_list), json.dumps(oids_list)
            )
        
        return jsonify({
            "success": True,
            "id": mib_id,
            "fileName": safe_name,
            "originalName": file.filename,
            "oids": oids_list,
            "oidCount": len(oids_list),
            "message": f"Parsed {len(oids_list)} OID definitions"
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/<int:hall_id>/mibs", methods=["GET"])
def get_hall_mibs(hall_id: int):
    """List MIB files associated with a hall."""
    try:
        mibs = MibRepo.get_by_hall(hall_id)
        return jsonify({"success": True, "mibs": mibs})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/mibs/<int:mib_id>", methods=["DELETE"])
def delete_mib(mib_id: int):
    """Delete a MIB file record and its file on disk."""
    try:
        mib = MibRepo.get(mib_id)
        if not mib:
            return jsonify({"error": "MIB not found"}), 404
        
        filepath = os.path.join(MIBS_DIR, mib["filename"])
        if os.path.exists(filepath):
            os.remove(filepath)
        
        MibRepo.delete(mib_id)
        return jsonify({"success": True, "message": f"MIB {mib['original_name']} deleted"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/mibs", methods=["GET"])
def list_mibs():
    """List all uploaded MIB files on disk."""
    try:
        files = os.listdir(MIBS_DIR) if os.path.exists(MIBS_DIR) else []
        return jsonify({"mibs": files})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =============================================================================
# PDU WEB ADMIN API - Remote PDU management via reverse-engineered CGI interface
# =============================================================================

from pdu_web_client import PDUWebClient
import npdu_client
from npdu_client import NPDUWebClient

# Cache of active PDU web clients (keyed by "host:port")
_pdu_clients: Dict[str, PDUWebClient] = {}
_pdu_clients_lock = Lock()

_DEFAULT_WEB_ADMIN_PORT = 80

# Per-endpoint firmware family cache: True = NPDU, False = IPDU/generic.
# Avoids re-probing on every poll. Cleared when clients are evicted.
_npdu_firmware_cache: Dict[str, bool] = {}
_npdu_firmware_lock = Lock()


def _is_npdu_endpoint(host: str, port: int, use_https: bool) -> bool:
    """Detect (and cache) whether host:port runs the NPDU firmware.

    NPDU is HTTP-only and lives on port 80/8080; we only probe those to avoid
    overhead on IPDU's 443/6662 endpoints. The probe is a single cheap GET /.
    """
    if use_https or int(port) not in (80, 8080):
        return False
    key = _pdu_client_key(host, port, use_https)
    with _npdu_firmware_lock:
        cached = _npdu_firmware_cache.get(key)
    if cached is not None:
        return cached
    result = npdu_client.is_npdu_host(host, int(port))
    with _npdu_firmware_lock:
        _npdu_firmware_cache[key] = result
    return result


def _make_pdu_client(host: str, port: int, username: str, password: str,
                     use_https: bool = False, timeout: int = 10):
    """Return the right web-admin client for the firmware at host:port."""
    if _is_npdu_endpoint(host, port, use_https):
        return NPDUWebClient(host, port, username, password, timeout=timeout)
    return PDUWebClient(host, port, username, password, use_https=use_https, timeout=timeout)


def _coalesce_credential(value: str | None, fallback: str = "admin") -> str:
    """Treat None and blank strings as missing — .get(key, fallback) misses empty strings."""
    if value is None:
        return fallback
    if isinstance(value, str) and not value.strip():
        return fallback
    return value.strip() if isinstance(value, str) else str(value)


def _parse_use_https(value: Any) -> bool:
    return str(value).lower() in ("1", "true", "yes", "on")


def _web_admin_creds_from_pdu(pdu: Dict[str, Any]) -> Tuple[str, int, str, str, bool]:
    host = pdu.get("remote_host") or pdu["ip_address"]
    use_https = _parse_use_https(pdu.get("web_admin_https") or 0)
    default_port = 443 if use_https else _DEFAULT_WEB_ADMIN_PORT
    port = int(pdu.get("web_admin_port") or default_port)
    user = _coalesce_credential(pdu.get("web_admin_user"))
    password = _coalesce_credential(pdu.get("web_admin_pass"))
    return host, port, user, password, use_https


def _web_admin_creds_from_request(default_port: int | None = None) -> Tuple[int, str, str, bool]:
    use_https = _parse_use_https(request.args.get("use_https", "0"))
    port = int(request.args.get("port") or (443 if use_https else (default_port or _DEFAULT_WEB_ADMIN_PORT)))
    username = _coalesce_credential(request.args.get("username"))
    password = _coalesce_credential(request.args.get("password"))
    return port, username, password, use_https


def _web_admin_creds_from_json(data: Dict[str, Any]) -> Tuple[int, str, str, bool]:
    use_https = _parse_use_https(data.get("use_https", data.get("web_admin_https", 0)))
    port = int(
        data.get("web_port")
        or data.get("web_admin_port")
        or (443 if use_https else _DEFAULT_WEB_ADMIN_PORT)
    )
    username = _coalesce_credential(data.get("username", data.get("web_admin_user")))
    password = _coalesce_credential(data.get("password", data.get("web_admin_pass")))
    return port, username, password, use_https


def _evict_pdu_client(host: str, port: int, use_https: bool = False) -> None:
    key = _pdu_client_key(host, port, use_https)
    with _pdu_clients_lock:
        client = _pdu_clients.pop(key, None)
    if client:
        try:
            client.logout()
        except Exception:
            pass


def _evict_all_pdu_clients_for_host(host: str) -> None:
    """Logout and drop every cached web-admin client for *host* (all ports/schemes)."""
    with _pdu_clients_lock:
        keys = [k for k in list(_pdu_clients.keys()) if f":{host}:" in k]
        clients = [_pdu_clients.pop(k) for k in keys]
    for client in clients:
        try:
            client.logout()
        except Exception:
            pass


_BATCH_POLLER_PAUSE = 0
_BATCH_POLLER_PAUSE_LOCK = Lock()


def _pause_pdu_poller() -> None:
    global _BATCH_POLLER_PAUSE
    with _BATCH_POLLER_PAUSE_LOCK:
        _BATCH_POLLER_PAUSE += 1
    print("[batch] Background PDU poller paused")


def _resume_pdu_poller() -> None:
    global _BATCH_POLLER_PAUSE
    with _BATCH_POLLER_PAUSE_LOCK:
        _BATCH_POLLER_PAUSE = max(0, _BATCH_POLLER_PAUSE - 1)
    print("[batch] Background PDU poller resumed")


def _poller_is_paused() -> bool:
    with _BATCH_POLLER_PAUSE_LOCK:
        return _BATCH_POLLER_PAUSE > 0


_pdu_admin_holds: Dict[str, int] = {}
_pdu_admin_holds_lock = Lock()


def _pdu_client_key(host: str, port: int, use_https: bool = False) -> str:
    scheme = "https" if use_https else "http"
    return f"{scheme}:{host}:{port}"


def hold_pdu_admin(host: str, port: int, use_https: bool = False) -> None:
    """Pause background telemetry polling while the operator uses PDU Settings."""
    key = _pdu_client_key(host, port, use_https)
    with _pdu_admin_holds_lock:
        _pdu_admin_holds[key] = _pdu_admin_holds.get(key, 0) + 1


def release_pdu_admin(host: str, port: int, use_https: bool = False) -> None:
    key = _pdu_client_key(host, port, use_https)
    with _pdu_admin_holds_lock:
        count = _pdu_admin_holds.get(key, 0)
        if count <= 1:
            _pdu_admin_holds.pop(key, None)
        else:
            _pdu_admin_holds[key] = count - 1


def is_pdu_admin_held(host: str, port: int, use_https: bool = False) -> bool:
    key = _pdu_client_key(host, port, use_https)
    with _pdu_admin_holds_lock:
        return _pdu_admin_holds.get(key, 0) > 0


def _resolve_web_access_target(web_access: Dict[str, Any], fallback_port: int) -> Tuple[int, bool]:
    """Return the post-reboot web-admin port and HTTPS flag from a template."""
    if not web_access:
        return int(fallback_port or _DEFAULT_WEB_ADMIN_PORT), False
    use_https = str(web_access.get("https_http", "0")) == "1"
    if use_https:
        port = int(web_access.get("https_port") or 443)
    else:
        port = int(web_access.get("http_port") or fallback_port or _DEFAULT_WEB_ADMIN_PORT)
    return port, use_https


def _get_pdu_client(host: str, port: int = 6662,
                     username: str = "admin", password: str = "admin",
                     use_https: bool = False) -> PDUWebClient:
    connect_host, _, role, master_hn = _web_connect_target(host)
    if role == "slave" and connect_host and connect_host != host:
        # Inventory IPs on the daisy bus do not answer HTTP. CGI is on the master.
        print(f"[pdu-admin] {host} is daisy slave — web CGI via {connect_host} ({master_hn or 'master'})")
        host = connect_host
        if use_https or int(port) not in (80, 8080):
            use_https = False
            port = 80
    key = _pdu_client_key(host, port, use_https)
    with _pdu_clients_lock:
        client = _pdu_clients.get(key)
        if client is None:
            client = _make_pdu_client(host, port, username, password, use_https=use_https)
            _pdu_clients[key] = client
        elif client.username != username or client.password != password or client.use_https != use_https:
            try:
                client.logout()
            except Exception:
                pass
            client = _make_pdu_client(host, port, username, password, use_https=use_https)
            _pdu_clients[key] = client
        return client


def _batch_credential_candidates(ip: str, template: dict) -> list[tuple[str, str, str]]:
    """Ordered login attempts for batch deploy — template first, DB as fallback."""
    tpl_user = _coalesce_credential(template.get("current_credentials", {}).get("username"))
    tpl_pass_raw = template.get("current_credentials", {}).get("password")
    tpl_pass = (
        tpl_pass_raw.strip()
        if isinstance(tpl_pass_raw, str) and tpl_pass_raw.strip()
        else _coalesce_credential(tpl_pass_raw)
    )
    candidates: list[tuple[str, str, str]] = [(tpl_user, tpl_pass, "template")]
    existing = PDURepo.get_by_ip(ip)
    if existing:
        db_pass = (existing.get("web_admin_pass") or "").strip()
        if db_pass:
            db_user = _coalesce_credential(existing.get("web_admin_user"), tpl_user)
            if (db_user, db_pass) != (tpl_user, tpl_pass):
                candidates.append((db_user, db_pass, "db"))
    return candidates


def _batch_hold_pdu_sessions(ip: str, web_port: int = 80) -> None:
    """Hold both HTTP and HTTPS session keys — poller may use either after prior batch."""
    hold_pdu_admin(ip, int(web_port or _DEFAULT_WEB_ADMIN_PORT), False)
    hold_pdu_admin(ip, 443, True)
    existing = PDURepo.get_by_ip(ip)
    if existing and _parse_use_https(existing.get("web_admin_https")):
        hp = int(existing.get("web_admin_port") or 443)
        if hp not in (int(web_port or _DEFAULT_WEB_ADMIN_PORT), 443):
            hold_pdu_admin(ip, hp, True)


def _batch_release_pdu_sessions(ip: str, web_port: int = 80) -> None:
    release_pdu_admin(ip, int(web_port or _DEFAULT_WEB_ADMIN_PORT), False)
    release_pdu_admin(ip, 443, True)
    existing = PDURepo.get_by_ip(ip)
    if existing and _parse_use_https(existing.get("web_admin_https")):
        hp = int(existing.get("web_admin_port") or 443)
        if hp not in (int(web_port or _DEFAULT_WEB_ADMIN_PORT), 443):
            release_pdu_admin(ip, hp, True)


def _is_pdu_session_held(host: str) -> bool:
    """True if batch/settings holds any HTTP/HTTPS session key for this host."""
    if is_pdu_admin_held(host, 80, False) or is_pdu_admin_held(host, 443, True):
        return True
    existing = PDURepo.get_by_ip(host)
    if existing:
        hp = int(existing.get("web_admin_port") or _DEFAULT_WEB_ADMIN_PORT)
        hh = _parse_use_https(existing.get("web_admin_https"))
        if is_pdu_admin_held(host, hp, hh):
            return True
    return False


def _probe_pdu_login(
    host: str,
    port: int,
    username: str,
    password: str,
    use_https: bool,
    *,
    retries: int = 5,
) -> PDUWebClient | None:
    """Try login with retries; returns a logged-in client or None."""
    _evict_pdu_client(host, port, use_https)
    client = _make_pdu_client(host, port, username, password, use_https=use_https)
    with _pdu_clients_lock:
        _pdu_clients[_pdu_client_key(host, port, use_https)] = client
    last_err = "Login failed"
    for attempt in range(retries):
        if client.login():
            return client
        last_err = client.last_login_error or last_err
        time.sleep(1.0 * (attempt + 1))
    try:
        client.logout()
    except Exception:
        pass
    client.last_login_error = last_err
    return None


def _diagnose_pdu_login(
    host: str,
    username: str,
    password: str,
    *,
    verify_telemetry: bool = True,
    pdu: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Try web-admin endpoints and return a per-attempt diagnostic report."""
    _evict_all_pdu_clients_for_host(host)
    user = (username or "").strip() or "admin"
    pwd = password if password is not None and str(password).strip() else "admin"
    attempts: list[Dict[str, Any]] = []

    # NPDU firmware fast path — HTTP-only, plain /login CGI on port 80.
    if _is_npdu_endpoint(host, 80, False):
        probe = npdu_client.detect(host, port=80, username=user, password=pwd)
        url = f"http://{host}:80"
        attempts.append({
            "url": url, "port": 80, "use_https": False, "tcp_reachable": probe.get("found", False),
            "success": bool(probe.get("login_ok")),
            "error": None if probe.get("login_ok") else (probe.get("error") or "Login failed"),
            "firmware": "NPDU",
        })
        if probe.get("login_ok"):
            return {"success": True, "host": host, "username": user, "port": 80,
                    "use_https": False, "url": url, "firmware": "NPDU", "attempts": attempts}
        return {"success": False, "host": host, "username": user, "firmware": "NPDU",
                "attempts": attempts, "error": probe.get("error") or "NPDU login failed"}

    port_plans: list[tuple[int, bool]] = []
    if pdu and pdu.get("web_admin_port"):
        port_plans.append((int(pdu["web_admin_port"]), _parse_use_https(pdu.get("web_admin_https"))))
    for try_port, use_https in [(443, True), (80, False), (6662, False), (8080, False)]:
        if (try_port, use_https) not in port_plans:
            port_plans.append((try_port, use_https))

    for try_port, use_https in port_plans:
        scheme = "https" if use_https else "http"
        url = f"{scheme}://{host}:{try_port}"
        client = PDUWebClient(host, try_port, user, pwd, use_https=use_https, timeout=8)
        ok = False
        err: str | None = None
        tcp_ok = _debug_tcp_reachable(host, try_port, timeout=3.0)
        try:
            if not tcp_ok:
                err = "Connection timed out — PDU not reachable on this port"
            else:
                ok = client.login()
                err = client.last_login_error
                if ok and verify_telemetry:
                    try:
                        client.get_live_telemetry()
                    except Exception as exc:
                        ok = False
                        err = f"Login OK but telemetry read failed: {exc}"
        except Exception as exc:
            err = _friendly_connect_error(str(exc))
        finally:
            try:
                client.logout()
            except Exception:
                pass

        attempts.append({
            "url": url,
            "port": try_port,
            "use_https": use_https,
            "tcp_reachable": tcp_ok,
            "success": ok,
            "error": None if ok else (err or "Login failed"),
        })
        if ok:
            return {
                "success": True,
                "host": host,
                "username": user,
                "port": try_port,
                "use_https": use_https,
                "url": url,
                "attempts": attempts,
            }

    return {
        "success": False,
        "host": host,
        "username": user,
        "attempts": attempts,
        "error": _summarize_login_failures(attempts),
    }


def _friendly_connect_error(raw: str) -> str:
    """Short customer-safe error from requests/urllib exceptions."""
    if "ConnectTimeoutError" in raw or "timed out" in raw.lower():
        return "Connection timed out — PDU not reachable"
    if "Connection refused" in raw:
        return "Connection refused — port closed"
    if "UNSAFE_LEGACY_RENEGOTIATION" in raw:
        return "HTTPS SSL handshake failed (legacy renegotiation)"
    if len(raw) > 160:
        return raw[:160] + "…"
    return raw


def _summarize_login_failures(attempts: list[Dict[str, Any]]) -> str:
    """Build a short repair failure summary (not a full Python stack trace)."""
    if not attempts:
        return "No login attempts made"
    if all(not a.get("tcp_reachable") for a in attempts):
        ports = ", ".join(str(a["port"]) for a in attempts[:4])
        return f"Network unreachable on ports {ports} — check PDU power, cable, and subnet"
    auth_fails = [a for a in attempts if a.get("tcp_reachable") and not a.get("success")]
    if auth_fails:
        ports_open = ", ".join(str(a["port"]) for a in auth_fails)
        last = auth_fails[-1].get("error") or "Login failed"
        if "Login failed" in last or "login" in last.lower():
            return (
                f"PDU responds on port(s) {ports_open} but login failed — "
                "enter the password that works in Chrome (batch may have changed it)"
            )
        return f"PDU responds on port(s) {ports_open} — {last}"
    return attempts[-1].get("error") or "All login attempts failed"


def _analyze_pdu_db_credentials(pdu: Dict[str, Any]) -> Dict[str, Any]:
    """Detect common DB corruption patterns from partial upserts / batch runs."""
    web_port = pdu.get("web_admin_port")
    web_pass = (pdu.get("web_admin_pass") or "").strip()
    web_user = (pdu.get("web_admin_user") or "").strip()
    use_https = bool(pdu.get("web_admin_https"))
    anomalies: List[str] = []
    if not web_port:
        anomalies.append("DB_MISSING_PORT")
    if not web_pass:
        anomalies.append("DB_MISSING_PASSWORD")
    if not web_user:
        anomalies.append("DB_MISSING_USER")
    if web_port and int(web_port) == 443 and not use_https:
        anomalies.append("DB_HTTPS_FLAG_WRONG")
    if web_port and int(web_port) == 80 and use_https:
        anomalies.append("DB_HTTP_FLAG_WRONG")
    commissioned = False
    if pdu.get("metadata_json"):
        try:
            commissioned = bool(json.loads(pdu["metadata_json"]).get("commissioned"))
        except Exception:
            pass
    return {
        "web_admin_port": web_port,
        "web_admin_https": use_https,
        "web_admin_user": web_user or None,
        "password_set": bool(web_pass),
        "credentials_complete": bool(web_port and web_user and web_pass),
        "commissioned_metadata": commissioned,
        "anomalies": anomalies,
    }


def _probe_pdu_tcp_ports(host: str, pdu: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """Quick TCP scan of likely web-admin ports."""
    ports_to_try: list[int] = []
    if pdu and pdu.get("web_admin_port"):
        ports_to_try.append(int(pdu["web_admin_port"]))
    for p in (443, 80, 6662, 8080):
        if p not in ports_to_try:
            ports_to_try.append(p)
    results = {}
    for port in ports_to_try:
        results[str(port)] = _debug_tcp_reachable(host, port, timeout=3.0)
    open_ports = [int(p) for p, ok in results.items() if ok]
    return {
        "host": host,
        "ports": results,
        "open_ports": open_ports,
        "any_open": bool(open_ports),
    }


def _repair_credential_candidates(
    pdu: Dict[str, Any],
    username: str | None,
    password: str | None,
) -> list[tuple[str, str, str]]:
    """Ordered login attempts: form → database → factory default."""
    candidates: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str]] = set()

    def _add(user: str, pwd: str, source: str) -> None:
        key = (user, pwd)
        if key in seen:
            return
        seen.add(key)
        candidates.append((user, pwd, source))

    form_user = (username or "").strip() or "admin"
    form_pass = password if password is not None and str(password).strip() else "admin"
    _add(form_user, form_pass, "repair_form")

    db_pass = (pdu.get("web_admin_pass") or "").strip()
    if db_pass:
        db_user = _coalesce_credential(pdu.get("web_admin_user"), form_user)
        _add(db_user, db_pass, "database_stored")

    _add("admin", "admin", "factory_default")
    return candidates


def _smart_repair_pdu(
    pdu: Dict[str, Any],
    *,
    username: str | None = None,
    password: str | None = None,
) -> Dict[str, Any]:
    """Iterative auto-repair: diagnose DB → TCP probe → try credential sets → update DB."""
    ip = pdu["ip_address"]
    hall_id = pdu["hall_id"]
    host = pdu.get("remote_host") or ip
    steps: List[Dict[str, Any]] = []

    db_analysis = _analyze_pdu_db_credentials(pdu)
    steps.append({"phase": "1_db_analysis", "label": "Analyze database record", **db_analysis})

    if _is_pdu_session_held(host):
        msg = (
            "PDU web session busy — close PDU Settings panel and any open PDU tabs in Chrome, then retry"
        )
        steps.append({"phase": "blocked", "label": "Session busy", "code": "SESSION_BUSY"})
        return {
            "success": False,
            "code": "SESSION_BUSY",
            "ip": ip,
            "message": msg,
            "error": msg,
            "steps": steps,
        }

    _evict_all_pdu_clients_for_host(host)
    tcp = _probe_pdu_tcp_ports(host, pdu)
    steps.append({"phase": "2_network_probe", "label": "TCP reachability", **tcp})

    if not tcp["any_open"]:
        msg = (
            f"Cannot reach {ip} on the network (ports 443/80 closed). "
            "Check PDU is powered on, cabled, and on the same subnet as PDUMind."
        )
        steps.append({"phase": "failed", "label": "Network unreachable", "code": "NETWORK_UNREACHABLE"})
        return {
            "success": False,
            "code": "NETWORK_UNREACHABLE",
            "ip": ip,
            "message": msg,
            "error": msg,
            "steps": steps,
            "recommendation": "Fix network connectivity first — Repair cannot update the database until the PDU responds.",
        }

    candidates = _repair_credential_candidates(pdu, username, password)
    steps.append({
        "phase": "3_credential_plan",
        "label": "Credential attempts planned",
        "sources": [c[2] for c in candidates],
        "count": len(candidates),
    })

    last_error = ""
    for cred_user, cred_pass, cred_source in candidates:
        steps.append({
            "phase": "4_try_login",
            "label": f"Try login ({cred_source})",
            "source": cred_source,
            "username": cred_user,
        })
        diag = _diagnose_pdu_login(
            host, cred_user, cred_pass, verify_telemetry=True, pdu=pdu
        )
        steps.append({
            "phase": "4_login_result",
            "source": cred_source,
            "success": diag.get("success", False),
            "attempts": [
                {
                    "url": a.get("url"),
                    "tcp_reachable": a.get("tcp_reachable"),
                    "success": a.get("success"),
                    "error": a.get("error"),
                }
                for a in diag.get("attempts", [])
            ],
        })
        if diag.get("success"):
            port = int(diag["port"])
            use_https = bool(diag["use_https"])
            PDURepo.upsert(
                hall_id,
                ip,
                {
                    "web_admin_port": port,
                    "web_admin_https": use_https,
                    "web_admin_user": cred_user,
                    "web_admin_pass": cred_pass,
                },
            )
            _evict_all_pdu_clients_for_host(host)
            scheme = "https" if use_https else "http"
            fixed_db = []
            if "DB_MISSING_PORT" in db_analysis["anomalies"]:
                fixed_db.append("restored web_admin_port")
            if "DB_MISSING_PASSWORD" in db_analysis["anomalies"]:
                fixed_db.append("restored password")
            if "DB_HTTPS_FLAG_WRONG" in db_analysis["anomalies"] or "DB_HTTP_FLAG_WRONG" in db_analysis["anomalies"]:
                fixed_db.append("corrected HTTP/HTTPS flag")
            msg = f"Connected via {scheme}://{host}:{port} as {cred_user} (via {cred_source})"
            if fixed_db:
                msg += f" — DB fixed: {', '.join(fixed_db)}"
            steps.append({
                "phase": "5_success",
                "label": "Database updated",
                "port": port,
                "use_https": use_https,
                "credential_source": cred_source,
                "db_fixes": fixed_db,
            })
            print(f"[pdu-repair] {ip} -> {msg}")
            return {
                "success": True,
                "code": "SUCCESS",
                "ip": ip,
                "message": msg,
                "credential_source": cred_source,
                "before": db_analysis,
                "after": {
                    "web_admin_port": port,
                    "web_admin_https": use_https,
                    "web_admin_user": cred_user,
                },
                "steps": steps,
            }
        last_error = diag.get("error") or last_error

    msg = last_error or "All repair attempts failed"
    code = "AUTH_FAILED" if tcp["any_open"] else "NETWORK_UNREACHABLE"
    recommendation = (
        "PDU is online but login failed. Enter the password that works when you open the PDU in Chrome. "
        "If batch commissioning changed the password, use that password — not admin/admin."
        if code == "AUTH_FAILED"
        else "Check network connectivity before retrying Repair."
    )
    steps.append({"phase": "failed", "label": "Repair failed", "code": code, "error": msg})
    print(f"[pdu-repair] {ip} failed ({code}): {msg}")
    return {
        "success": False,
        "code": code,
        "ip": ip,
        "message": msg,
        "error": msg,
        "recommendation": recommendation,
        "steps": steps,
    }


def _repair_pdu_web_credentials(
    pdu: Dict[str, Any],
    *,
    username: str | None = None,
    password: str | None = None,
) -> tuple[bool, str]:
    """Re-probe a PDU and rewrite DB web-admin port/protocol/credentials."""
    result = _smart_repair_pdu(pdu, username=username, password=password)
    return result["success"], result.get("message") or result.get("error", "Repair failed")


def _connect_pdu_admin_probe(
    host: str,
    username: str,
    password: str,
    *,
    port: int = 80,
    prefer_https: bool | None = None,
) -> Tuple[PDUWebClient, int, bool]:
    """Connect to PDU web admin, probing HTTP and HTTPS as needed."""
    http_port = int(port or _DEFAULT_WEB_ADMIN_PORT) if not prefer_https else 80
    if prefer_https is True:
        attempts = [(443, True), (http_port, False)]
    elif prefer_https is False:
        attempts = [(http_port, False), (443, True)]
    else:
        # Default: HTTPS first — common after batch commissioning / factory HTTPS.
        attempts = [(443, True), (http_port, False)]

    seen: set[tuple[int, bool]] = set()
    errors: list[str] = []
    for try_port, use_https in attempts:
        key = (try_port, use_https)
        if key in seen:
            continue
        seen.add(key)
        client = _probe_pdu_login(host, try_port, username, password, use_https, retries=3)
        if client:
            scheme = "https" if use_https else "http"
            print(f"[pdu-admin] Connected to {scheme}://{host}:{try_port} as {username}")
            return client, try_port, use_https
        probe_client = _pdu_clients.get(_pdu_client_key(host, try_port, use_https))
        err = (probe_client.last_login_error if probe_client else None) or "Login failed"
        errors.append(f"{'https' if use_https else 'http'}://{host}:{try_port} — {err}")

    tried = ", ".join(f"{'https' if h else 'http'}://{host}:{p}" for p, h in seen)
    detail = errors[-1] if errors else tried
    raise ConnectionError(f"PDU login failed for {username} — tried {tried}. Last: {detail}")


def _wait_for_pdu_after_reboot(
    host: str,
    username: str,
    password: str,
    *,
    timeout: int = 120,
    prefer_https: bool = True,
    https_port: int = 443,
    http_port: int = 80,
) -> Tuple[PDUWebClient | None, int, bool]:
    """Wait for a rebooted PDU and return whichever protocol answers first."""
    deadline = time.time() + timeout
    order = [(https_port, True), (http_port, False)] if prefer_https else [(http_port, False), (https_port, True)]
    while time.time() < deadline:
        for try_port, use_https in order:
            client = _probe_pdu_login(host, try_port, username, password, use_https, retries=2)
            if client:
                scheme = "https" if use_https else "http"
                print(f"[batch] Verified {scheme}://{host}:{try_port} after reboot")
                return client, try_port, use_https
        time.sleep(5)
    return None, http_port, False


def _connect_batch_pdu_client(
    ip: str,
    port: int,
    template: dict,
    *,
    web_https_hint: bool = False,
) -> Tuple[PDUWebClient, int, bool, str, str]:
    """Connect for batch commissioning — one clean path, poller paused, HTTP first.

    Returns (client, port, use_https, username, password) for the credentials that
    actually logged in — important when the DB fallback succeeds but the template
    password field is stale.
    """
    _evict_all_pdu_clients_for_host(ip)
    time.sleep(1.5)  # let any in-flight poll finish and release the PDU session slot

    scan_port = int(port or _DEFAULT_WEB_ADMIN_PORT)
    endpoints: list[tuple[int, bool]] = []
    if web_https_hint or scan_port == 443:
        endpoints.append((443, True))
    endpoints.append((80, False))
    if scan_port not in (80, 443):
        endpoints.append((scan_port, web_https_hint))
    elif not any(h for _, h in endpoints):
        endpoints.append((443, True))
    # dedupe preserving order
    seen: set[tuple[int, bool]] = set()
    unique_endpoints: list[tuple[int, bool]] = []
    for ep in endpoints:
        if ep not in seen:
            seen.add(ep)
            unique_endpoints.append(ep)

    last_err: ConnectionError | None = None
    for user, password, source in _batch_credential_candidates(ip, template):
        for try_port, use_https in unique_endpoints:
            client = _probe_pdu_login(ip, try_port, user, password, use_https, retries=5)
            if client:
                scheme = "https" if use_https else "http"
                print(f"[batch] {ip} connected via {scheme}://{ip}:{try_port} ({source} creds)")
                return client, try_port, use_https, user, password
        last_err = ConnectionError(
            f"PDU login failed for {user} — tried "
            + ", ".join(f"{'https' if h else 'http'}://{ip}:{p}" for p, h in unique_endpoints)
        )
        print(f"[batch] {ip} all endpoints failed with {source} credentials")

    raise ConnectionError(
        f"{last_err} — verify Current PDU Password (must match Remote PDU login)"
    ) from last_err


@app.route("/api/pdu-admin/probe-login", methods=["POST"])
def pdu_admin_probe_login():
    """Test PDU web login without changing the database — returns per-port diagnostics."""
    try:
        data = request.get_json(force=True) if request.data else {}
        host = (data.get("host") or data.get("ip") or "").strip()
        username = data.get("web_admin_user") or data.get("username")
        password = data.get("web_admin_pass") or data.get("password")
        if not host:
            return jsonify({"error": "host is required"}), 400
        _pause_pdu_poller()
        try:
            report = _diagnose_pdu_login(host, username or "admin", password or "admin")
        finally:
            _resume_pdu_poller()
        status = 200 if report.get("success") else 401
        return jsonify(report), status
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/connect", methods=["POST"])
def pdu_admin_connect():
    """Login to a PDU web admin panel and return device info + all settings."""
    try:
        data = request.get_json(force=True)
        host = data.get("host", "").strip()
        port = int(data.get("port") or _DEFAULT_WEB_ADMIN_PORT)
        username = _coalesce_credential(data.get("username"))
        password = _coalesce_credential(data.get("password"))
        use_https = _parse_use_https(data.get("use_https", 0))

        if not host:
            return jsonify({"error": "host is required"}), 400

        prefer_https = True if use_https else (False if data.get("use_https") is not None else None)
        client, port, use_https = _connect_pdu_admin_probe(
            host, username, password, port=port, prefer_https=prefer_https
        )
        try:
            settings = client.get_all_settings()
        except ConnectionError:
            return jsonify({"error": "Login failed — check credentials"}), 401

        settings = _overlay_commissioning_display(host, settings)
        return jsonify({"success": True, "web_port": port, "use_https": use_https, **settings})
    except ConnectionError as e:
        return jsonify({"error": str(e)}), 401
    except _requests_lib.exceptions.ConnectionError:
        return jsonify({"error": f"Cannot reach PDU at {host}:{port}"}), 502
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/session/hold", methods=["POST"])
def pdu_admin_session_hold(host: str):
    """Pause background telemetry polling for this PDU while settings are open."""
    try:
        port, _, _, use_https = _web_admin_creds_from_request()
        connect_host, _, role, _ = _web_connect_target(host)
        if role == "slave":
            host = connect_host
            use_https = False
            port = 80
        hold_pdu_admin(host, port, use_https)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/session/release", methods=["POST"])
def pdu_admin_session_release(host: str):
    """Resume background telemetry polling after PDU Settings closes."""
    try:
        port, _, _, use_https = _web_admin_creds_from_request()
        connect_host, _, role, _ = _web_connect_target(host)
        if role == "slave":
            host = connect_host
            use_https = False
            port = 80
        release_pdu_admin(host, port, use_https)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _find_pdu_record(host: str) -> Optional[Dict[str, Any]]:
    """Look up a PDU row by IP, remote_host, or hostname (read-only)."""
    pdu = PDURepo.get_by_ip(host)
    if pdu:
        return pdu
    from db.persistence import _connect, _db_lock
    with _db_lock:
        conn = _connect()
        try:
            cur = conn.execute(
                "SELECT * FROM pdus WHERE remote_host = ? OR hostname = ? LIMIT 1",
                (host, host),
            )
            row = cur.fetchone()
            return dict(row) if row else None
        finally:
            conn.close()


def _load_pdu_metadata(host: str) -> Dict[str, Any]:
    pdu = _find_pdu_record(host)
    if not pdu or not pdu.get("metadata_json"):
        return {}
    try:
        return json.loads(pdu["metadata_json"])
    except (json.JSONDecodeError, TypeError):
        return {}


def _merge_pdu_metadata(host: str, patch: Dict[str, Any]) -> None:
    """Merge display-only commissioning fields into metadata_json (credentials untouched)."""
    pdu = _find_pdu_record(host)
    if not pdu:
        return
    meta = _load_pdu_metadata(host)
    meta.update(patch)
    PDURepo.upsert(pdu["hall_id"], pdu["ip_address"], {"metadata": meta})


def _overlay_commissioning_display(host: str, settings: Dict[str, Any]) -> Dict[str, Any]:
    """Inject batch-commissioned display fields not stored on the PDU hardware."""
    meta = _load_pdu_metadata(host)
    if not meta:
        return settings

    sntp2 = (meta.get("sntp_server2") or "").strip()
    if sntp2:
        time_cfg = dict(settings.get("time") or {})
        if not (time_cfg.get("sntp_server2") or "").strip():
            time_cfg["sntp_server2"] = sntp2
            settings["time"] = time_cfg

    return settings


@app.route("/api/pdu-admin/<host>/settings", methods=["GET"])
def pdu_admin_get_settings(host: str):
    """Read all settings from a PDU.  Retries once on timeout since the
    background poller may have just released the session."""
    try:
        port, username, password, use_https = _web_admin_creds_from_request()
        client = _get_pdu_client(host, port, username, password, use_https=use_https)
        last_err = None
        for attempt in range(2):
            acquired = client._lock.acquire(timeout=45)
            if not acquired:
                return jsonify({"error": "PDU is busy — try again in a few seconds"}), 503
            try:
                # Clear any stale poller session before the bulk settings read.
                client.logout()
                time.sleep(0.5)
                settings = client.get_all_settings()
                break
            except (_requests_lib.exceptions.ReadTimeout, ConnectionError) as e:
                last_err = e
                if attempt == 0:
                    print(f"[pdu-admin/settings] {host} failed, retrying… ({e})")
                    time.sleep(2)
            finally:
                client._lock.release()
        else:
            raise last_err
        settings = _overlay_commissioning_display(host, settings)
        connect_host, slave_index, role, master_hn = _web_connect_target(host)
        if role == "slave":
            settings["chain"] = {
                "role": "slave",
                "via": connect_host,
                "slave_index": slave_index,
                "master_hostname": master_hn,
            }
        return jsonify({"success": True, **settings})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


def _trigger_pdu_reboot(client: PDUWebClient, host: str = "") -> bool:
    """Reboot a PDU — same code path as Apply & Reboot in PDU Settings / Remote PDU."""
    label = host or client.host
    ok = client.reboot()
    print(f"[pdu] Apply & Reboot triggered for {label} -> {'OK' if ok else 'FAILED'}")
    return ok


def _reboot_pdu_via_web(pdu: Dict[str, Any], *, wait: bool = False) -> Dict[str, Any]:
    """Log in to a PDU web admin and trigger reboot.cgi (no config changes)."""
    ip = pdu["ip_address"]
    host = pdu.get("remote_host") or ip
    label = pdu.get("label") or pdu.get("hostname") or ip

    db_analysis = _analyze_pdu_db_credentials(pdu)
    if not db_analysis["credentials_complete"]:
        return {
            "success": False,
            "skipped": True,
            "id": pdu.get("id"),
            "ip": ip,
            "label": label,
            "code": "MISSING_CREDENTIALS",
            "error": "Missing web credentials in database — run Commissioning → Repair first",
        }

    if _is_pdu_session_held(host):
        return {
            "success": False,
            "id": pdu.get("id"),
            "ip": ip,
            "label": label,
            "code": "SESSION_BUSY",
            "error": "PDU web session busy — close PDU Settings and any PDU browser tabs",
        }

    _evict_all_pdu_clients_for_host(host)

    try:
        whost, port, username, password, use_https = _web_admin_creds_from_pdu(pdu)
        client = _get_pdu_client(whost, port, username, password, use_https=use_https)
        if not _trigger_pdu_reboot(client, whost):
            return {
                "success": False,
                "id": pdu.get("id"),
                "ip": ip,
                "label": label,
                "code": "REBOOT_FAILED",
                "error": "reboot.cgi did not respond — check web login credentials",
            }

        online = None
        if wait:
            online = client.wait_online(timeout=90)

        try:
            client.logout()
        except Exception:
            pass
        _evict_pdu_client(whost, port, use_https)

        msg = "Reboot triggered (~60 s offline)"
        if wait:
            msg = "PDU is back online" if online else "Reboot sent but PDU not yet reachable after 90 s"

        print(f"[pdu-reboot] {ip} -> {msg}")
        return {
            "success": True,
            "id": pdu.get("id"),
            "ip": ip,
            "label": label,
            "online": online,
            "message": msg,
        }
    except Exception as exc:
        return {
            "success": False,
            "id": pdu.get("id"),
            "ip": ip,
            "label": label,
            "code": "ERROR",
            "error": str(exc),
        }


@app.route("/api/pdu-admin/<host>/settings/network", methods=["POST"])
def pdu_admin_set_network(host: str):
    """Change IPv4 settings on a PDU.  Optionally reboots the device so the
    new settings take effect on the network interface."""
    try:
        data = request.get_json(force=True)
        port, username, password, use_https = _web_admin_creds_from_json(data)
        client = _get_pdu_client(host, port, username, password, use_https=use_https)

        # If DHCP mode change requested, apply it first
        dhcp_mode = data.get("dhcp")
        if dhcp_mode is not None:
            dhcp_ok = client.set_dhcp(dhcp_mode == "ON" or dhcp_mode is True)
            if not dhcp_ok:
                return jsonify({"error": "Failed to change DHCP mode"}), 500

        ok = client.set_ipv4(
            ip=data["ip"],
            mask=data.get("mask", "255.255.255.0"),
            gateway=data.get("gateway", ""),
            dns1=data.get("dns1", ""),
            dns2=data.get("dns2", ""),
        )
        if not ok:
            return jsonify({"error": "Failed to apply network settings"}), 500

        need_reboot = data.get("reboot", False)
        if need_reboot:
            if not _trigger_pdu_reboot(client, host):
                return jsonify({"error": "Settings saved but reboot failed"}), 500
            return jsonify({
                "success": True,
                "rebooting": True,
                "message": "Network settings saved. PDU is rebooting (~60 s).",
            })

        return jsonify({
            "success": True,
            "rebooting": False,
            "message": "Network settings saved (pending). A reboot is required for changes to take effect.",
        })
    except KeyError as e:
        return jsonify({"error": f"Missing field: {e}"}), 400
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/reboot", methods=["POST"])
def pdu_admin_reboot(host: str):
    """Reboot a PDU.  Optionally wait for it to come back online."""
    try:
        data = request.get_json(force=True) if request.data else {}
        port, username, password, use_https = _web_admin_creds_from_json(data)
        wait = data.get("wait", False)

        client = _get_pdu_client(host, port, username, password, use_https=use_https)
        if not _trigger_pdu_reboot(client, host):
            return jsonify({"error": "Reboot failed"}), 500

        if wait:
            online = client.wait_online(timeout=90)
            return jsonify({
                "success": True,
                "online": online,
                "message": "PDU is back online." if online else "PDU rebooted but not yet reachable.",
            })

        return jsonify({"success": True, "message": "Reboot triggered. PDU will be offline for ~60 s."})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/ping", methods=["GET"])
def pdu_admin_ping(host: str):
    """Quick check if PDU web panel is reachable (used to poll after reboot).
    Uses a lightweight TCP probe so we don't steal the PDU's single session."""
    try:
        port, _, _, use_https = _web_admin_creds_from_request()
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect((host, port))
        sock.close()
        return jsonify({"online": True})
    except Exception:
        return jsonify({"online": False})


@app.route("/api/pdu-admin/<host>/settings/snmp", methods=["POST"])
def pdu_admin_set_snmp(host: str):
    """Change SNMP settings on a PDU."""
    try:
        data = request.get_json(force=True)
        port, username, password, use_https = _web_admin_creds_from_json(data)
        client = _get_pdu_client(host, port, username, password, use_https=use_https)

        ok = client.set_snmp(**PDUWebClient.prepare_snmp_kwargs(data))
        if ok:
            return jsonify({"success": True, "message": "SNMP settings applied"})
        return jsonify({"error": "Failed to apply SNMP settings — values on PDU did not match request"}), 500
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/settings/time", methods=["POST"])
def pdu_admin_set_time(host: str):
    """Change time/SNTP settings on a PDU."""
    try:
        data = request.get_json(force=True)
        port, username, password, use_https = _web_admin_creds_from_json(data)
        client = _get_pdu_client(host, port, username, password, use_https=use_https)

        ok = client.set_time(**PDUWebClient.prepare_time_kwargs(data))
        if ok:
            if "sntp_server2" in data:
                _merge_pdu_metadata(host, {
                    "sntp_server2": (data.get("sntp_server2") or "").strip(),
                })
            return jsonify({"success": True, "message": "Time settings applied"})
        return jsonify({"error": "Failed to apply time settings"}), 500
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/settings/system", methods=["GET"])
def pdu_admin_get_system(host: str):
    """Get system/device settings (hostname, LCD, logout) from a PDU."""
    try:
        port, username, password, use_https = _web_admin_creds_from_request()
        client = _get_pdu_client(host, port, username, password, use_https=use_https)
        cfg = client.get_system_config()
        users = client.get_users()
        return jsonify({"success": True, "system": cfg, "users": users})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/settings/system", methods=["POST"])
def pdu_admin_set_system(host: str):
    """Set system/device settings on a PDU."""
    try:
        data = request.get_json(force=True)
        port, username, password, use_https = _web_admin_creds_from_json(data)
        client = _get_pdu_client(host, port, username, password, use_https=use_https)

        ok = client.set_system_config(
            device_name=data.get("device_name"),
            lcd_title=data.get("lcd_title"),
            display_direction=data.get("display_direction"),
            lcd_backlight_mode=data.get("lcd_backlight_mode"),
            lcd_backlight_time=data.get("lcd_backlight_time"),
            lcd_rest_brightness=data.get("lcd_rest_brightness"),
            logout_enabled=data.get("logout_enabled"),
            logout_time=data.get("logout_time"),
            web_title_enabled=data.get("web_title_enabled"),
            router_hostname=data.get("router_hostname"),
        )
        if ok:
            # Sync label/hostname back to DB — Router Hostname is the PDU label
            new_name = data.get("router_hostname") or data.get("device_name")
            new_hostname = data.get("router_hostname")
            if new_name or new_hostname:
                try:
                    import sqlite3
                    db_path = os.path.join(os.path.dirname(__file__), "data", "pdumind.db")
                    conn = sqlite3.connect(db_path)
                    updates, params = [], []
                    if new_name:
                        updates.append("label = ?")
                        params.append(new_name)
                    if new_hostname:
                        updates.append("hostname = ?")
                        params.append(new_hostname)
                    if updates:
                        params.append(host)
                        conn.execute(f"UPDATE pdus SET {', '.join(updates)} WHERE ip_address = ?", params)
                        conn.commit()
                    conn.close()
                except Exception as db_err:
                    print(f"[set_system] DB update warning: {db_err}")
            return jsonify({"success": True, "message": "System settings applied"})
        return jsonify({"error": "Failed to apply system settings"}), 500
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/settings/users", methods=["POST"])
def pdu_admin_set_users(host: str):
    """Set user credentials on a PDU.
    After applying, updates the DB and flushes the cached client so the
    poller reconnects with the new credentials automatically."""
    try:
        data = request.get_json(force=True)
        port, username, password, use_https = _web_admin_creds_from_json(data)
        client = _get_pdu_client(host, port, username, password, use_https=use_https)

        new_admin_user = data.get("admin_username")
        new_admin_pass = data.get("admin_password")

        ok = client.set_users(
            admin_username=new_admin_user,
            admin_password=new_admin_pass,
            user1_username=data.get("user1_username"),
            user1_password=data.get("user1_password"),
            user2_username=data.get("user2_username"),
            user2_password=data.get("user2_password"),
        )
        if ok:
            # Persist new admin credentials to DB so the poller uses them
            if new_admin_user or new_admin_pass:
                try:
                    pdu = _find_pdu_record(host)
                    if pdu:
                        updates: Dict[str, Any] = {}
                        if new_admin_user:
                            updates["web_admin_user"] = new_admin_user
                        if new_admin_pass:
                            updates["web_admin_pass"] = new_admin_pass
                        if updates:
                            PDURepo.upsert(pdu["hall_id"], pdu["ip_address"], updates)
                except Exception as db_err:
                    print(f"[set_users] DB update warning: {db_err}")

                _evict_pdu_client(host, port, use_https)

            return jsonify({"success": True, "message": "User credentials applied"})
        return jsonify({"error": "Failed to apply user settings"}), 500
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/settings/web-access", methods=["POST"])
def pdu_admin_set_web_access(host: str):
    """Switch PDU web admin between HTTP and HTTPS. Requires reboot."""
    try:
        data = request.get_json(force=True)
        port, username, password, use_https = _web_admin_creds_from_json(data)
        client = _get_pdu_client(host, port, username, password, use_https=use_https)

        ok = client.set_web_access(
            https_http=str(data.get("https_http", "0")),
            http_port=str(data.get("http_port", "80")),
            https_port=str(data.get("https_port", "443")),
        )
        if not ok:
            return jsonify({"error": "Failed to apply web access settings"}), 500

        target_port, target_https = _resolve_web_access_target(data, port)
        need_reboot = data.get("reboot", True)
        if need_reboot:
            if not _trigger_pdu_reboot(client, host):
                return jsonify({"error": "Settings saved but reboot failed"}), 500
            return jsonify({
                "success": True,
                "rebooting": True,
                "web_admin_port": target_port,
                "web_admin_https": target_https,
                "message": "Web access settings saved. PDU is rebooting (~60 s).",
            })

        return jsonify({
            "success": True,
            "rebooting": False,
            "web_admin_port": target_port,
            "web_admin_https": target_https,
            "message": "Web access settings saved. Reboot required for changes to take effect.",
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ======================================================================
# Batch Commissioning
# ======================================================================

_BATCH_JOBS: Dict[str, Dict[str, Any]] = {}  # job_id -> job state
_batch_lock = Lock()
# IPs currently being batch-commissioned — poller must not login to these PDUs.
_BATCH_ACTIVE_IPS: set[str] = set()
_BATCH_ACTIVE_IPS_LOCK = Lock()


def _batch_hold_ip(ip: str) -> None:
    with _BATCH_ACTIVE_IPS_LOCK:
        _BATCH_ACTIVE_IPS.add(ip)


def _batch_release_ip(ip: str) -> None:
    with _BATCH_ACTIVE_IPS_LOCK:
        _BATCH_ACTIVE_IPS.discard(ip)


def _is_batch_commission_active(ip: str) -> bool:
    with _BATCH_ACTIVE_IPS_LOCK:
        return ip in _BATCH_ACTIVE_IPS


def _resolve_hostname_pattern(pattern: str, idx: int, ip: str, mac: str) -> str:
    """Resolve hostname/device-name placeholders for a specific PDU index.

    Supported placeholders:
      {seq}    legacy 3-digit zero-padded sequence, starts at 1: 001, 002, ...
      {idx}    zero-based index: 0, 1, 2, ...
      {ip}     full IP address
      {mac}    last 6 chars of MAC (no separators)
      {N}      start at N, padded to width(N): {10} -> 10, 11, 12, ...
      {N-M}    start at N, padded to max(width(N), width(M)): {10-17} -> 10..17.
               M is informational; actual end is determined by selected count.
               Leading zeros in N or M are preserved as padding width.
    """
    import re as _re

    if not pattern:
        return ""

    def _numeric_repl(match: "_re.Match[str]") -> str:
        start_token = match.group(1)
        end_token = match.group(2)
        start = int(start_token)
        if end_token is not None:
            width = max(len(start_token), len(end_token))
        else:
            width = len(start_token)
        return str(start + idx).zfill(width)

    result = _re.sub(r"\{(\d+)(?:-(\d+))?\}", _numeric_repl, pattern)
    result = result.replace("{seq}", str(idx + 1).zfill(3))
    result = result.replace("{idx}", str(idx))
    result = result.replace("{ip}", ip or "")
    mac_clean = (mac or "").replace(":", "").replace("-", "").replace(".", "")
    result = result.replace("{mac}", mac_clean[-6:] if mac_clean else "")
    return result


def _sort_pdus_by_ip(pdu_list: list) -> list:
    """Stable sort a list of PDU dicts by IP address (numeric octet comparison).
    Entries without a valid IPv4 address are moved to the end, preserving relative order.
    """
    import ipaddress

    def _key(p):
        try:
            return (0, int(ipaddress.IPv4Address(str(p.get("ip", "")).strip())))
        except Exception:
            return (1, 0)

    return sorted(pdu_list, key=_key)


@app.route("/api/batch/commission", methods=["POST"])
def batch_commission():
    """Start a batch commissioning job. Accepts a template and a list of PDUs."""
    import uuid
    try:
        data = request.get_json(force=True)
        template = data.get("template", {})
        pdu_list = data.get("pdus", [])
        hall_id = data.get("hall_id")

        if not pdu_list:
            return jsonify({"error": "No PDUs selected"}), 400
        if not hall_id:
            return jsonify({"error": "Data hall ID required"}), 400

        job_id = str(uuid.uuid4())[:8]
        job = {
            "id": job_id,
            "status": "running",
            "template": template,
            "hall_id": hall_id,
            "total": len(pdu_list),
            "completed": 0,
            "results": {},
            "started_at": time.time(),
        }
        with _batch_lock:
            _BATCH_JOBS[job_id] = job

        # Run in background thread
        t = Thread(
            target=_run_batch_commission,
            args=(job_id, template, pdu_list, hall_id),
            daemon=True,
        )
        t.start()

        return jsonify({"success": True, "job_id": job_id, "total": len(pdu_list)})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/batch/commission/<job_id>", methods=["GET"])
def batch_commission_status(job_id: str):
    """Get the status/progress of a batch commissioning job."""
    with _batch_lock:
        job = _BATCH_JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job)


# ---------------------------------------------------------------------------
# Guided inventory commissioning — upload an inventory spreadsheet, then walk
# each PDU one-by-one from factory default to its assigned production IP.
# ---------------------------------------------------------------------------

def _cidr_to_mask(bits: int) -> str:
    bits = max(0, min(32, int(bits)))
    mask = (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF if bits else 0
    return ".".join(str((mask >> (8 * i)) & 0xFF) for i in (3, 2, 1, 0))


def _col_to_index(ref: str) -> int:
    """'B7' -> 1 (zero-based column index)."""
    letters = "".join(c for c in ref if c.isalpha())
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch.upper()) - ord("A") + 1)
    return idx - 1


def _parse_xlsx_grid(content: bytes) -> List[List[str]]:
    """Minimal dependency-free .xlsx reader → list of row value lists."""
    import io
    import zipfile
    import re as _re
    from xml.sax.saxutils import unescape

    z = zipfile.ZipFile(io.BytesIO(content))
    shared: List[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        ss_xml = z.read("xl/sharedStrings.xml").decode("utf-8", "ignore")
        for si in _re.findall(r"<si>(.*?)</si>", ss_xml, _re.S):
            texts = _re.findall(r"<t[^>]*>(.*?)</t>", si, _re.S)
            shared.append(unescape("".join(texts)))

    sheet_name = next((n for n in z.namelist() if n.startswith("xl/worksheets/sheet")), None)
    if not sheet_name:
        return []
    sheet_xml = z.read(sheet_name).decode("utf-8", "ignore")

    grid: List[List[str]] = []
    for row_xml in _re.findall(r"<row[^>]*>(.*?)</row>", sheet_xml, _re.S):
        cells: Dict[int, str] = {}
        for cell in _re.findall(r"<c\b([^>]*)>(.*?)</c>", row_xml, _re.S):
            attrs, body = cell
            ref_m = _re.search(r'r="([A-Z]+\d+)"', attrs)
            col = _col_to_index(ref_m.group(1)) if ref_m else len(cells)
            t_m = _re.search(r't="([^"]+)"', attrs)
            ctype = t_m.group(1) if t_m else "n"
            val = ""
            if ctype == "s":
                v_m = _re.search(r"<v>(.*?)</v>", body, _re.S)
                if v_m:
                    try:
                        val = shared[int(v_m.group(1))]
                    except (ValueError, IndexError):
                        val = ""
            elif ctype == "inlineStr":
                ts = _re.findall(r"<t[^>]*>(.*?)</t>", body, _re.S)
                val = unescape("".join(ts))
            else:
                v_m = _re.search(r"<v>(.*?)</v>", body, _re.S)
                val = unescape(v_m.group(1)) if v_m else ""
            cells[col] = val.strip()
        if cells:
            width = max(cells) + 1
            grid.append([cells.get(i, "") for i in range(width)])
        else:
            grid.append([])
    return grid


def _parse_pdu_inventory(content: bytes) -> List[Dict[str, Any]]:
    """Extract commissioning targets from an inventory spreadsheet.

    Maps columns by header name so column order does not matter.
    """
    grid = _parse_xlsx_grid(content)
    # Find header row (first row that mentions an IP-address column)
    header_idx = -1
    for i, row in enumerate(grid[:10]):
        joined = " ".join(c.lower() for c in row)
        if "ip" in joined and ("host" in joined or "rack" in joined or "gateway" in joined):
            header_idx = i
            break
    if header_idx < 0:
        return []

    headers = [h.lower() for h in grid[header_idx]]

    def find_col(*needles: str) -> int:
        for ci, h in enumerate(headers):
            if all(n in h for n in needles):
                return ci
        return -1

    c_host = find_col("host")
    c_ip = find_col("ip")
    c_site = find_col("site")
    c_rack = find_col("rack")
    c_gw = find_col("gateway")
    c_sr = find_col("sr")

    import re as _re
    targets: List[Dict[str, Any]] = []
    seen_ips: set = set()
    for row in grid[header_idx + 1:]:
        if not row:
            continue

        def cell(ci: int) -> str:
            return row[ci].strip() if 0 <= ci < len(row) else ""

        raw_ip = cell(c_ip)
        m = _re.search(r"(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\s*/\s*(\d{1,2}))?", raw_ip)
        if not m:
            continue
        ip = m.group(1)
        if ip in seen_ips:
            continue
        seen_ips.add(ip)
        cidr = int(m.group(2)) if m.group(2) else 24
        mask = _cidr_to_mask(cidr)
        gateway = cell(c_gw)
        gw_m = _re.search(r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}", gateway)
        gateway = gw_m.group(0) if gw_m else ".".join(ip.split(".")[:3] + ["1"])
        targets.append({
            "sr_no": cell(c_sr),
            "hostname": cell(c_host),
            "ip": ip,
            "cidr": cidr,
            "mask": mask,
            "gateway": gateway,
            "site": cell(c_site),
            "rack": cell(c_rack),
            "status": "pending",
        })
    return targets


@app.route("/api/commission/inventory/parse", methods=["POST"])
def commission_inventory_parse():
    """Parse an uploaded PDU inventory spreadsheet into commissioning targets."""
    import base64
    try:
        data = request.get_json(force=True) if request.data else {}
        b64 = data.get("content_b64") or ""
        if "," in b64 and b64.strip().startswith("data:"):
            b64 = b64.split(",", 1)[1]
        if not b64:
            return jsonify({"error": "No file content provided"}), 400
        content = base64.b64decode(b64)
        targets = _parse_pdu_inventory(content)
        if not targets:
            return jsonify({
                "success": False,
                "error": "No PDU rows found — expected columns like Hostname, MGMT IP address, Default Gateway",
            }), 422
        sites = sorted({t["site"] for t in targets if t["site"]})
        return jsonify({
            "success": True,
            "count": len(targets),
            "sites": sites,
            "targets": targets,
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": f"Failed to parse spreadsheet: {e}"}), 500


@app.route("/api/commission/guided-detect", methods=["POST"])
def commission_guided_detect():
    """Detect/identify the PDU on the factory IP and verify the web-admin login.

    Tries the NPDU firmware first (the family on these units), then falls back to
    the HMAC web-admin diagnostic for other firmwares. Used by the guided wizard's
    'Detect' and 'Test login' buttons so the user sees MAC + current IP + which
    credential/port actually works before applying changes.
    """
    try:
        data = request.get_json(force=True) if request.data else {}
        factory_ip = (data.get("factory_ip") or "192.168.0.163").strip()
        creds = data.get("current_credentials") or {}
        cur_user = (creds.get("username") or "admin").strip() or "admin"
        cur_pass = creds.get("password")
        cur_pass = cur_pass.strip() if isinstance(cur_pass, str) and cur_pass.strip() else "admin"

        try:
            from demo.context import is_demo_session
            if is_demo_session():
                return jsonify({
                    "success": True, "demo": True, "firmware": "NPDU",
                    "factory_ip": factory_ip, "mac": "00-14-97-DE-M0-01",
                    "current_ip": factory_ip, "login_ok": True,
                    "message": "(Demo) NPDU detected, admin login OK",
                })
        except Exception:
            pass

        try:
            import npdu_client
            probe = npdu_client.detect(factory_ip, port=80, username=cur_user, password=cur_pass)
        except Exception as np_e:
            probe = {"is_npdu": False, "error": f"npdu probe failed: {np_e}"}

        if probe.get("is_npdu"):
            return jsonify({
                "success": bool(probe.get("login_ok")),
                "firmware": "NPDU",
                "factory_ip": factory_ip,
                "login_ok": probe.get("login_ok"),
                "login_role": probe.get("login_role"),
                "mac": probe.get("mac"),
                "current_ip": probe.get("current_ip"),
                "mask": probe.get("mask"),
                "gateway": probe.get("gateway"),
                "http_port": probe.get("http_port"),
                "error": probe.get("error"),
                "message": (
                    f"NPDU detected at {factory_ip} (MAC {probe.get('mac') or '?'}) — "
                    f"admin login {'OK' if probe.get('login_ok') else 'FAILED'}"
                ),
            })

        # Not NPDU — fall back to the multi-port HMAC web-admin diagnostic.
        diag = _diagnose_pdu_login(factory_ip, cur_user, cur_pass, verify_telemetry=False)
        attempts = diag.get("attempts") or []
        return jsonify({
            "success": bool(diag.get("success")),
            "firmware": "generic",
            "factory_ip": factory_ip,
            "login_ok": bool(diag.get("success")),
            "port": diag.get("port"),
            "use_https": diag.get("use_https"),
            "url": diag.get("url"),
            "attempts": attempts,
            "error": None if diag.get("success") else (
                "; ".join(
                    f"{a['url']} ({'reachable' if a.get('tcp_reachable') else 'no TCP'}: {a.get('error')})"
                    for a in attempts
                ) or probe.get("error")
            ),
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/commission/guided-apply", methods=["POST"])
def commission_guided_apply():
    """Commission one PDU from its factory IP to a target inventory IP.

    Connects on the factory IP, pushes static network + hostname (+ optional
    SNMP/credentials), then reboots. Does NOT verify on the new IP — after the
    reboot the PDU moves to the customer subnet, which the laptop on the factory
    subnet cannot reach. Verification happens later with a batch scan once the
    laptop is back on the production subnet.
    """
    try:
        data = request.get_json(force=True) if request.data else {}
        factory_ip = (data.get("factory_ip") or "192.168.0.163").strip()
        target = data.get("target") or {}
        hall_id = data.get("hall_id")
        creds = data.get("current_credentials") or {}
        cur_user = (creds.get("username") or "admin").strip() or "admin"
        cur_pass = creds.get("password")
        cur_pass = cur_pass.strip() if isinstance(cur_pass, str) and cur_pass.strip() else "admin"

        new_ip = (target.get("ip") or "").strip()
        if not new_ip:
            return jsonify({"error": "Target IP required"}), 400
        mask = (target.get("mask") or "255.255.255.0").strip()
        gateway = (target.get("gateway") or "").strip()
        hostname = (target.get("hostname") or "").strip()
        dns1 = (target.get("dns1") or "").strip()
        dns2 = (target.get("dns2") or "").strip()

        # Demo mode: simulate a successful commission so the flow is testable.
        try:
            from demo.context import is_demo_session
            if is_demo_session():
                time.sleep(1.2)
                return jsonify({
                    "success": True,
                    "demo": True,
                    "factory_ip": factory_ip,
                    "new_ip": new_ip,
                    "hostname": hostname,
                    "rebooted": True,
                    "message": f"(Demo) {hostname or new_ip} configured and rebooting to {new_ip}",
                })
        except Exception:
            pass

        template = {"current_credentials": {"username": cur_user, "password": cur_pass}}
        pdu_template: Dict[str, Any] = {
            "network": {
                "dhcp": "OFF",
                "ip": new_ip,
                "mask": mask,
                "gateway": gateway,
                "dns1": dns1,
                "dns2": dns2,
            },
        }
        if hostname:
            pdu_template["system"] = {"router_hostname": hostname, "device_name": hostname}
        if data.get("snmp"):
            pdu_template["snmp"] = data["snmp"]

        _batch_hold_ip(factory_ip)
        _pause_pdu_poller()
        time.sleep(1)
        try:
            # --- NPDU firmware fast path (login page title "NPDU"/"PDUMIND") ---
            # This family uses a plain query-string CGI (GET /login, /setnet,
            # /setsys) with NO HMAC and NO login.cgi, so the HMAC client below
            # would 404. Detect it first and drive it natively.
            try:
                import npdu_client
                probe = npdu_client.detect(factory_ip, port=80, username=cur_user, password=cur_pass)
            except Exception as np_e:
                probe = {"is_npdu": False, "error": f"npdu probe failed: {np_e}"}

            if probe.get("is_npdu"):
                if not probe.get("login_ok"):
                    return jsonify({
                        "success": False,
                        "error": (
                            f"NPDU at {factory_ip} reachable but login rejected for "
                            f"{cur_user!r}: {probe.get('error') or 'bad credentials'}"
                        ),
                        "firmware": "NPDU",
                    }), 502

                res = npdu_client.commission(
                    factory_ip, new_ip=new_ip, mask=mask, gateway=gateway,
                    dns=dns1, hostname=hostname, username=cur_user, password=cur_pass,
                    port=80, do_reboot=True,
                )
                if not res.get("success"):
                    return jsonify({"success": False, "firmware": "NPDU", **res}), 502

                if hall_id:
                    try:
                        PDURepo.upsert(int(hall_id), new_ip, {
                            "hostname": hostname,
                            "label": hostname or f"PDU-{new_ip}",
                            "mac": res.get("mac") or "",
                            "web_admin_port": 80,
                            "web_admin_https": 0,
                            "web_admin_user": cur_user,
                            "web_admin_pass": cur_pass,
                            "snmp_port": 161,
                            "snmp_version": "2c",
                            "is_active": True,
                        })
                    except Exception as db_e:
                        print(f"[guided][npdu] DB upsert warning for {new_ip}: {db_e}")

                _evict_all_pdu_clients_for_host(factory_ip)
                return jsonify({
                    "success": True,
                    "firmware": "NPDU",
                    "factory_ip": factory_ip,
                    "new_ip": new_ip,
                    "hostname": hostname,
                    "mac": res.get("mac"),
                    "previous_ip": res.get("previous_ip"),
                    "rebooted": res.get("rebooted", True),
                    "message": (
                        f"{hostname or new_ip} configured (MAC {res.get('mac') or '?'}) — "
                        f"rebooting to {new_ip}. Move your laptop to the production subnet to verify."
                    ),
                })

            # Find the working web-admin endpoint first — probes 443/80/6662/8080
            # and reports per-port so a wrong port or real bad-credential is clear.
            diag = _diagnose_pdu_login(factory_ip, cur_user, cur_pass, verify_telemetry=False)
            if not diag.get("success"):
                attempts = diag.get("attempts") or []
                tried = ", ".join(
                    f"{a['url']} ({'reachable' if a.get('tcp_reachable') else 'no TCP'}: {a.get('error')})"
                    for a in attempts
                )
                return jsonify({
                    "success": False,
                    "error": f"Web-admin login to {factory_ip} failed as {cur_user!r}. Tried {tried}",
                    "attempts": attempts,
                }), 502

            conn_port = int(diag.get("port") or 80)
            conn_https = bool(diag.get("use_https"))
            conn_user, conn_pass = cur_user, cur_pass
            client = _probe_pdu_login(factory_ip, conn_port, conn_user, conn_pass, conn_https, retries=5)
            if not client:
                return jsonify({
                    "success": False,
                    "error": f"Login verified on {diag.get('url')} but session could not be opened — retry",
                    "attempts": diag.get("attempts"),
                }), 502
            report = client.apply_batch_template(pdu_template, reboot_after=False)
            net_ok = (report.get("network") or {}).get("success", False)
            if not net_ok:
                return jsonify({
                    "success": False,
                    "error": (report.get("network") or {}).get("error")
                    or "PDU did not accept the new network settings",
                    "sections": report,
                }), 502

            rebooted = _trigger_pdu_reboot(client, factory_ip)

            # Record the assigned PDU in the hall DB (pending verification on new IP).
            if hall_id:
                try:
                    PDURepo.upsert(int(hall_id), new_ip, {
                        "hostname": hostname,
                        "label": hostname or f"PDU-{new_ip}",
                        "web_admin_port": int(conn_port),
                        "web_admin_https": 1 if conn_https else 0,
                        "web_admin_user": conn_user,
                        "web_admin_pass": conn_pass,
                        "snmp_port": 161,
                        "snmp_version": "2c",
                        "is_active": True,
                    })
                except Exception as db_e:
                    print(f"[guided] DB upsert warning for {new_ip}: {db_e}")

            _evict_all_pdu_clients_for_host(factory_ip)
            return jsonify({
                "success": True,
                "factory_ip": factory_ip,
                "new_ip": new_ip,
                "hostname": hostname,
                "rebooted": rebooted,
                "sections": report,
                "message": (
                    f"{hostname or new_ip} configured — rebooting to {new_ip}. "
                    "Move your laptop to the production subnet to verify."
                ),
            })
        finally:
            _batch_release_ip(factory_ip)
            _resume_pdu_poller()
    except ConnectionError as ce:
        return jsonify({"success": False, "error": str(ce)}), 502
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


def _run_batch_commission(job_id: str, template: dict, pdu_list: list, hall_id: int):
    """Execute batch commissioning in background thread."""
    import socket

    # Decide whether to sort by IP before assigning sequence numbers.
    # Frontend can opt out with template["ordering"] == "manual" to keep its
    # explicit order (e.g. user drag-reordered in the preview screen).
    ordering = (template.get("ordering") or "ip").lower()
    if ordering == "ip":
        pdu_list = _sort_pdus_by_ip(pdu_list)

    # Configuration flags from the template
    sys_template = template.get("system") or {}
    sync_device_name = bool(sys_template.get("sync_device_name", True))

    # Network reconfiguration is only triggered when the user explicitly fills
    # the Starting IP. Otherwise we keep whatever the network admin assigned
    # (no IP/mask/gateway/DNS push, and crucially no reboot).
    net_template = template.get("network") or {}
    ip_start = (net_template.get("ip_start") or "").strip()
    ip_parts = ip_start.split(".") if ip_start else []
    network_change_requested = len(ip_parts) == 4

    all_batch_ips = [str(p.get("ip", "")).strip() for p in pdu_list if p.get("ip")]
    for ip in all_batch_ips:
        _batch_hold_ip(ip)

    _pause_pdu_poller()
    time.sleep(2)  # let any in-flight poll cycle finish

    master_apply_cache: Dict[str, Dict[str, Any]] = {}
    net_idx = 0

    try:
        for idx, pdu_info in enumerate(pdu_list):
            current_ip = pdu_info.get("ip", "")
            mac = pdu_info.get("mac", "")
            web_port = int(pdu_info.get("web_admin_port") or 80)
            web_https_hint = _parse_use_https(pdu_info.get("web_admin_https"))
            pdu_key = mac or current_ip
            chain_role = (pdu_info.get("chain_role") or "standalone").lower()
            is_slave = chain_role == "slave"
            master_ip = (pdu_info.get("master_ip") or current_ip).strip()
            try:
                slave_index = int(pdu_info.get("slave_index") or 0)
            except (TypeError, ValueError):
                slave_index = 0

            # Per-PDU status
            status = {
                "ip": current_ip,
                "mac": mac,
                "step": "connecting",
                "success": False,
                "sections": {},
                "new_ip": "",
                "error": None,
                "chain_role": chain_role,
                "master_ip": master_ip if is_slave else current_ip,
            }
            with _batch_lock:
                _BATCH_JOBS[job_id]["results"][pdu_key] = status

            try:
                # Calculate the target IP for this PDU (only changes if explicitly requested).
                # Daisy slaves have no NIC — keep their inventory IP and do not consume the sequence.
                if network_change_requested and not is_slave:
                    new_ip = f"{ip_parts[0]}.{ip_parts[1]}.{ip_parts[2]}.{int(ip_parts[3]) + net_idx}"
                    net_idx += 1
                else:
                    new_ip = current_ip
                status["new_ip"] = new_ip

                # Build per-PDU template with resolved IP
                pdu_template = {}
                if network_change_requested:
                    pdu_template["network"] = {
                        **net_template,
                        "ip": new_ip,
                        "dhcp": "OFF",
                    }
                if sys_template:
                    sys_cfg = {k: v for k, v in sys_template.items() if k != "sync_device_name"}
                    hostname_pattern = sys_cfg.get("router_hostname", "")
                    resolved_hostname = _resolve_hostname_pattern(hostname_pattern, idx, new_ip, mac)
                    if hostname_pattern:
                        sys_cfg["router_hostname"] = resolved_hostname
                    if sync_device_name and hostname_pattern:
                        sys_cfg["device_name"] = resolved_hostname
                    else:
                        name_pattern = sys_cfg.get("device_name", "")
                        if name_pattern:
                            sys_cfg["device_name"] = _resolve_hostname_pattern(
                                name_pattern, idx, new_ip, mac
                            )
                    pdu_template["system"] = sys_cfg
                users_cfg = template.get("users") or {}
                cur_cred_user = _coalesce_credential(template.get("current_credentials", {}).get("username"))
                new_admin_user = (users_cfg.get("admin_username") or "").strip()
                new_admin_pass = (users_cfg.get("admin_password") or "").strip()
                user_wants_rename = bool(new_admin_user and new_admin_user != cur_cred_user)
                extra_users = any(
                    (users_cfg.get(k) or "").strip()
                    for k in ("user1_username", "user1_password", "user2_username", "user2_password")
                )
                if new_admin_pass or user_wants_rename or extra_users:
                    user_patch = {}
                    if user_wants_rename:
                        user_patch["admin_username"] = new_admin_user
                    if new_admin_pass:
                        user_patch["admin_password"] = new_admin_pass
                    for k in ("user1_username", "user1_password", "user2_username", "user2_password"):
                        v = (users_cfg.get(k) or "").strip()
                        if v:
                            user_patch[k] = v
                    pdu_template["users"] = user_patch
                if template.get("snmp"):
                    pdu_template["snmp"] = template["snmp"]
                if template.get("ntp"):
                    pdu_template["ntp"] = template["ntp"]
                web_access_template = template.get("web_access") or {}
                web_access_enabled = str(web_access_template.get("https_http", "0")) == "1"
                if web_access_enabled:
                    pdu_template["web_access"] = web_access_template

                post_web_port, post_use_https = _resolve_web_access_target(
                    web_access_template if web_access_enabled else {}, web_port
                )
                if web_access_enabled:
                    print(f"[batch] {current_ip} will enable HTTPS on port {post_web_port} after apply")

                status["step"] = "configuring"
                with _batch_lock:
                    _BATCH_JOBS[job_id]["results"][pdu_key] = status

                tpl_user = _coalesce_credential(template.get("current_credentials", {}).get("username"))
                tpl_pass_raw = template.get("current_credentials", {}).get("password")
                admin_user = tpl_user
                admin_pass = (
                    tpl_pass_raw.strip()
                    if isinstance(tpl_pass_raw, str) and tpl_pass_raw.strip()
                    else _coalesce_credential(tpl_pass_raw)
                )
                effective_user = (new_admin_user if user_wants_rename else admin_user)
                effective_pass = new_admin_pass or admin_pass
                needs_reboot = bool(pdu_template.get("network")) or web_access_enabled

                if is_slave:
                    status["step"] = "configuring"
                    with _batch_lock:
                        _BATCH_JOBS[job_id]["results"][pdu_key] = status
                    slave_hostname = (
                        (pdu_info.get("hostname") or "").strip()
                        or (pdu_template.get("system") or {}).get("router_hostname")
                        or f"PDU-{current_ip}"
                    )
                    via_template: Dict[str, Any] = {}
                    if template.get("snmp"):
                        via_template["snmp"] = template["snmp"]
                    if pdu_template.get("users"):
                        via_template["users"] = pdu_template["users"]
                    if pdu_template.get("ntp"):
                        via_template["ntp"] = pdu_template["ntp"]
                    cached = master_apply_cache.get(master_ip)
                    _batch_hold_pdu_sessions(master_ip, web_port)
                    try:
                        if cached is None:
                            client, cport, chttps, cuser, cpass = _connect_batch_pdu_client(
                                master_ip, web_port, template, web_https_hint=web_https_hint
                            )
                            report = (
                                client.apply_batch_template(via_template, reboot_after=False)
                                if via_template else {"snmp": {"success": True, "via": master_ip}}
                            )
                            snmp_result = report.get("snmp") or {}
                            if via_template.get("snmp") and not snmp_result.get("success", True):
                                status["step"] = "snmp_failed"
                                status["error"] = (
                                    snmp_result.get("error")
                                    or f"SNMP was not applied on chain master {master_ip}"
                                )
                                with _batch_lock:
                                    _BATCH_JOBS[job_id]["results"][pdu_key] = status
                                    _BATCH_JOBS[job_id]["completed"] += 1
                                continue
                            cached = {
                                "sections": report,
                                "port": cport,
                                "https": chttps,
                                "user": cuser,
                                "pass": cpass,
                            }
                            master_apply_cache[master_ip] = cached
                        status["sections"] = dict(cached.get("sections") or {})
                        status["sections"]["snmp"] = {
                            **(status["sections"].get("snmp") or {"success": True}),
                            "via": master_ip,
                            "slave_index": slave_index,
                        }
                        snmp_cfg = template.get("snmp") or {}
                        community = snmp_cfg.get("read_community") or snmp_cfg.get("community_read") or "public"
                        version = "3" if snmp_cfg.get("snmpv3") else (pdu_info.get("snmp_version") or "2c")
                        pdu_id = PDURepo.upsert(hall_id, new_ip, {
                            "label": slave_hostname,
                            "hostname": slave_hostname,
                            "snmp_port": 161,
                            "snmp_community_ref": community,
                            "snmp_version": version,
                            "is_active": True,
                            "mac_address": mac or "",
                            "web_admin_port": int(cached.get("port") or web_port or 80),
                            "web_admin_https": 1 if cached.get("https") else 0,
                            "web_admin_user": cached.get("user") or admin_user,
                            "web_admin_pass": cached.get("pass") or admin_pass,
                        })
                        _merge_pdu_metadata(new_ip, {
                            "commissioned": True,
                            "chain_role": "slave",
                            "master_ip": master_ip,
                            "slave_index": slave_index,
                            "snmp_via": master_ip,
                        })
                        status["step"] = "done"
                        status["success"] = True
                        status["pdu_id"] = pdu_id
                        status["rebooted"] = False
                    finally:
                        _batch_release_pdu_sessions(master_ip, web_port)
                    with _batch_lock:
                        _BATCH_JOBS[job_id]["results"][pdu_key] = status
                        _BATCH_JOBS[job_id]["completed"] += 1
                    continue

                connect_port, connect_https = web_port, False
                connect_user, connect_pass = admin_user, admin_pass
                _batch_hold_pdu_sessions(current_ip, web_port)

                try:
                    client, connect_port, connect_https, connect_user, connect_pass = _connect_batch_pdu_client(
                        current_ip, web_port, template, web_https_hint=web_https_hint
                    )
                    # Persist working credentials immediately so a later SNMP/reboot
                    # failure cannot leave the DB with stale or blank web-admin fields.
                    PDURepo.upsert(
                        hall_id,
                        current_ip,
                        {
                            "web_admin_port": int(connect_port),
                            "web_admin_https": 1 if connect_https else 0,
                            "web_admin_user": connect_user,
                            "web_admin_pass": connect_pass,
                        },
                    )

                    if web_access_enabled and not connect_https:
                        try:
                            wa_cfg = client.get_web_access_config()
                            if str(wa_cfg.get("https_http", "0")) == "1":
                                # HTTPS already written to device config but still
                                # answering on HTTP — reboot never happened or failed.
                                print(
                                    f"[batch] {current_ip} HTTPS configured but still on HTTP "
                                    "— reboot required (skipping web_access re-apply)"
                                )
                                pdu_template.pop("web_access", None)
                                web_access_enabled = True  # keep for post-reboot verify
                                post_web_port = int(wa_cfg.get("https_port") or 443)
                                post_use_https = True
                                needs_reboot = True
                        except Exception:
                            pass

                    if web_access_enabled and connect_https:
                        print(f"[batch] {current_ip} already on HTTPS — skipping web_access apply")
                        web_access_enabled = False
                        pdu_template.pop("web_access", None)
                        post_web_port, post_use_https = connect_port, True
                        needs_reboot = bool(pdu_template.get("network"))

                    report = client.apply_batch_template(pdu_template, reboot_after=False)
                    status["sections"] = report
                    master_apply_cache[current_ip] = {
                        "sections": report,
                        "port": connect_port,
                        "https": connect_https,
                        "user": connect_user,
                        "pass": connect_pass,
                    }
                    snmp_result = report.get("snmp") or {}
                    if pdu_template.get("snmp") and not snmp_result.get("success", True):
                        status["step"] = "snmp_failed"
                        status["error"] = (
                            snmp_result.get("error")
                            or "SNMP settings were not applied on the PDU — check version flags and community strings"
                        )
                        with _batch_lock:
                            _BATCH_JOBS[job_id]["results"][pdu_key] = status
                            _BATCH_JOBS[job_id]["completed"] += 1
                        continue
                    users_result = report.get("users") or {}
                    if pdu_template.get("users") and not users_result.get("success", True):
                        status["step"] = "users_failed"
                        status["error"] = (
                            users_result.get("error")
                            or "PDU web login username/password could not be applied — "
                            "check for unsupported characters or try changing password too"
                        )
                        with _batch_lock:
                            _BATCH_JOBS[job_id]["results"][pdu_key] = status
                            _BATCH_JOBS[job_id]["completed"] += 1
                        continue
                    reboot_ok = False
                    if needs_reboot:
                        reboot_ok = _trigger_pdu_reboot(client, current_ip)
                        status["rebooted"] = reboot_ok
                    else:
                        print(f"[batch] {current_ip} config applied — no reboot needed")
                        status["rebooted"] = False

                    if needs_reboot and not reboot_ok:
                        status["step"] = "reboot_failed"
                        status["error"] = (
                            f"Settings applied but reboot.cgi failed at {current_ip} — "
                            "reboot manually from PDU web UI or power-cycle"
                        )
                        with _batch_lock:
                            _BATCH_JOBS[job_id]["results"][pdu_key] = status
                            _BATCH_JOBS[job_id]["completed"] += 1
                        continue

                    if needs_reboot:
                        status["step"] = "verifying"
                        with _batch_lock:
                            _BATCH_JOBS[job_id]["results"][pdu_key] = status

                        if web_access_enabled:
                            verify_user = new_admin_user if user_wants_rename else connect_user
                            verify_pass = new_admin_pass if new_admin_pass else connect_pass
                            verify_client, verify_port, verified_https = _wait_for_pdu_after_reboot(
                                new_ip,
                                verify_user,
                                verify_pass,
                                timeout=120,
                                prefer_https=True,
                                https_port=post_web_port,
                                http_port=int(web_port or 80),
                            )
                            if not verify_client:
                                status["step"] = "verify_https_failed"
                                status["error"] = (
                                    f"PDU did not respond after reboot at {new_ip} "
                                    f"(waited 120s for HTTPS on port {post_web_port})"
                                )
                                with _batch_lock:
                                    _BATCH_JOBS[job_id]["results"][pdu_key] = status
                                    _BATCH_JOBS[job_id]["completed"] += 1
                                continue
                            if not verified_https:
                                status["step"] = "verify_https_failed"
                                status["error"] = (
                                    f"PDU rebooted but HTTPS is not active at {new_ip} — "
                                    "still answering on HTTP; check PDU web access settings"
                                )
                                with _batch_lock:
                                    _BATCH_JOBS[job_id]["results"][pdu_key] = status
                                    _BATCH_JOBS[job_id]["completed"] += 1
                                continue
                            connect_port, connect_https = verify_port, verified_https
                            post_web_port, post_use_https = verify_port, verified_https
                            try:
                                verify_client.logout()
                            except Exception:
                                pass
                        else:
                            verify_port = connect_port
                            online = False
                            deadline = time.time() + 90
                            while time.time() < deadline:
                                time.sleep(5)
                                try:
                                    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                                    sock.settimeout(3)
                                    if sock.connect_ex((new_ip, verify_port)) == 0:
                                        online = True
                                        sock.close()
                                        break
                                    sock.close()
                                except Exception:
                                    pass

                            if not online:
                                status["step"] = "reboot_timeout"
                                status["error"] = f"PDU did not come back at {new_ip}:{verify_port} within 90s"
                                with _batch_lock:
                                    _BATCH_JOBS[job_id]["results"][pdu_key] = status
                                    _BATCH_JOBS[job_id]["completed"] += 1
                                continue
                finally:
                    _batch_release_pdu_sessions(current_ip, web_port)

                status["step"] = "commissioning"
                with _batch_lock:
                    _BATCH_JOBS[job_id]["results"][pdu_key] = status

                stored_web_port = int(post_web_port if web_access_enabled else connect_port)
                stored_use_https = post_use_https if web_access_enabled else connect_https
                stored_user = new_admin_user if user_wants_rename else connect_user
                stored_pass = new_admin_pass if new_admin_pass else connect_pass

                # After a credential change, confirm the PDU accepts the new login
                # before rewriting the database (avoids storing a username the device rejects).
                if user_wants_rename or new_admin_pass:
                    try:
                        client.logout()
                    except Exception:
                        pass
                    verify_client = _probe_pdu_login(
                        new_ip,
                        stored_web_port,
                        stored_user,
                        stored_pass,
                        stored_use_https,
                        retries=5,
                    )
                    if not verify_client:
                        status["step"] = "credentials_verify_failed"
                        status["error"] = (
                            f"PDU rejected login as {stored_user!r} after username/password change — "
                            "run Commissioning → Repair with the credentials that work in Chrome"
                        )
                        with _batch_lock:
                            _BATCH_JOBS[job_id]["results"][pdu_key] = status
                            _BATCH_JOBS[job_id]["completed"] += 1
                        continue
                    try:
                        verify_client.logout()
                    except Exception:
                        pass

                resolved_hn = (
                    (pdu_template.get("system") or {}).get("router_hostname")
                    or (pdu_info.get("hostname") or "").strip()
                    or template.get("system", {}).get("device_name")
                    or f"PDU-{new_ip}"
                )
                pdu_data = {
                    "label": resolved_hn,
                    "snmp_port": 161,
                    "snmp_community_ref": template.get("snmp", {}).get("read_community", "public"),
                    "snmp_version": pdu_info.get("snmp_version", "2c"),
                    "is_active": True,
                    "mac_address": mac,
                    "hostname": resolved_hn,
                    "web_admin_port": stored_web_port,
                    "web_admin_https": stored_use_https,
                    "web_admin_user": stored_user,
                    "web_admin_pass": stored_pass,
                }
                pdu_id = PDURepo.upsert(hall_id, new_ip, pdu_data)

                if template.get("snmp"):
                    try:
                        _sync_chain_slave_snmp(
                            hall_id, new_ip, template.get("snmp") or {},
                            web_port=stored_web_port,
                            web_https=stored_use_https,
                            web_user=stored_user,
                            web_pass=stored_pass,
                        )
                    except Exception as sync_e:
                        print(f"[batch] {new_ip} chain SNMP sync: {sync_e}")

                ntp_cfg = template.get("ntp") or {}
                sntp2 = (ntp_cfg.get("sntp_server2") or "").strip()
                if sntp2:
                    _merge_pdu_metadata(new_ip, {
                        "commissioned": True,
                        "sntp_server2": sntp2,
                    })
                elif pdu_info.get("chain_role") == "master" or (pdu_info.get("chain_size") or 0) > 1:
                    _merge_pdu_metadata(new_ip, {
                        "commissioned": True,
                        "chain_role": "master",
                    })

                _evict_pdu_client(current_ip, connect_port, connect_https)
                _evict_pdu_client(current_ip, web_port, False)
                if new_ip != current_ip or stored_use_https:
                    _evict_pdu_client(new_ip, stored_web_port, stored_use_https)

                status["step"] = "done"
                status["success"] = True
                status["pdu_id"] = pdu_id

            except Exception as e:
                status["step"] = "error"
                status["error"] = str(e)
                import traceback; traceback.print_exc()

            with _batch_lock:
                _BATCH_JOBS[job_id]["results"][pdu_key] = status
                _BATCH_JOBS[job_id]["completed"] += 1

    finally:
        for ip in all_batch_ips:
            _batch_release_ip(ip)
        _resume_pdu_poller()

    # Mark job complete
    with _batch_lock:
        _BATCH_JOBS[job_id]["status"] = "completed"
        _BATCH_JOBS[job_id]["finished_at"] = time.time()
        results = _BATCH_JOBS[job_id]["results"]
        ok = sum(1 for r in results.values() if r.get("success"))
        fail = len(results) - ok
    print(f"[batch] Job {job_id} completed: {ok} succeeded, {fail} failed of {_BATCH_JOBS[job_id]['total']}")


@app.route("/api/pdu-admin/<host>/telemetry", methods=["GET"])
def pdu_admin_telemetry(host: str):
    """Get live telemetry from a PDU via its web admin CGI."""
    try:
        port, username, password, use_https = _web_admin_creds_from_request()
        client = _get_pdu_client(host, port, username, password, use_https=use_https)
        _, slave_index, role, _ = _web_connect_target(host)
        if role == "slave" and isinstance(client, NPDUWebClient):
            telemetry = client.get_live_telemetry(slave_index)
        else:
            telemetry = client.get_live_telemetry()
        return jsonify({"success": True, "telemetry": telemetry})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/logs", methods=["GET"])
def pdu_admin_logs(host: str):
    """Get event logs from a PDU."""
    try:
        port, username, password, use_https = _web_admin_creds_from_request()
        client = _get_pdu_client(host, port, username, password, use_https=use_https)
        logs = client.get_logs()
        return jsonify({"success": True, "logs": logs})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/alarm-thresholds", methods=["GET"])
def pdu_admin_get_alarm_thresholds(host: str):
    """Read alarm threshold settings from a PDU."""
    try:
        port, username, password, use_https = _web_admin_creds_from_request()
        client = _get_pdu_client(host, port, username, password, use_https=use_https)
        thresholds = client.get_alarm_thresholds()
        return jsonify({"success": True, "thresholds": thresholds})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/alarm-thresholds", methods=["POST"])
def pdu_admin_set_alarm_thresholds(host: str):
    """Write alarm threshold settings to a PDU."""
    try:
        port, username, password = _web_admin_creds_from_request()
        data = request.get_json(force=True) if request.data else {}
        client = _get_pdu_client(host, port, username, password)
        ok = client.set_alarm_thresholds(**data)
        return jsonify({"success": ok})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# =============================================================================
# NETWORK SCAN API - Discover PDUs on the network
# =============================================================================

def _snmpget_float(ip: str, community: str, oid: str, timeout: float = 1.5) -> Optional[float]:
    """One-shot snmpget -Oqv; returns None if the OID is missing or not numeric."""
    import re as _re
    import subprocess
    try:
        r = subprocess.run(
            ["snmpget", "-v2c", "-c", community, "-t", str(timeout), "-r", "0",
             "-Oqv", f"{ip}:161", oid],
            capture_output=True, text=True, timeout=timeout + 1.5,
        )
        if r.returncode != 0:
            return None
        raw = (r.stdout or "").strip().strip('"')
        m = _re.search(r"-?[\d.]+", raw)
        return float(m.group(0)) if m else None
    except Exception:
        return None


def _probe_npdu_chain_units(master_ip: str, *, community: str = "public",
                            username: str = "admin", password: str = "admin",
                            web_port: int = 80) -> List[Dict[str, Any]]:
    """Return up to 4 chain slots (master + 3 slaves) for an NPDU master."""
    units: List[Dict[str, Any]] = []
    try:
        import npdu_client
        if npdu_client.is_npdu_host(master_ip, port=int(web_port or 80), timeout=3):
            client = npdu_client.NPDUWebClient(
                master_ip, port=int(web_port or 80),
                username=username or "admin", password=password or "admin",
            )
            if client.login():
                try:
                    units = client.list_chain_units()
                finally:
                    try:
                        client.logout()
                    except Exception:
                        pass
    except Exception as e:
        print(f"[chain-scan] HTTP probe {master_ip}: {e}")

    if not units:
        from npdu_chain import electrically_live, snmp_current_oid, snmp_voltage_oid
        for unit_index in range(1, 5):
            vol = _snmpget_float(master_ip, community, snmp_voltage_oid(unit_index))
            cur = _snmpget_float(master_ip, community, snmp_current_oid(unit_index))
            if unit_index > 1 and vol is None and cur is None:
                break
            units.append({
                "slave_index": unit_index - 1,
                "unit_index": unit_index,
                "live": electrically_live(vol, cur),
                "voltage": vol or 0.0,
                "current": cur or 0.0,
            })
        if len(units) == 1 and not units[0].get("live"):
            units[0]["live"] = True  # the master answered the LAN scan
    if units and not any(u.get("slave_index") == 0 for u in units):
        units.insert(0, {
            "slave_index": 0, "unit_index": 1, "live": True, "voltage": 0.0, "current": 0.0,
        })
    return units or [{
        "slave_index": 0, "unit_index": 1, "live": True, "voltage": 0.0, "current": 0.0,
    }]


def _expand_discovered_npdu_chains(
    discovered: List[Dict[str, Any]],
    *,
    community: str = "public",
    username: str = "admin",
    password: str = "admin",
    hall_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Turn LAN-visible masters into master + daisy-slave rows for batch UI."""
    from npdu_chain import (
        electrically_live, fallback_stem, hostname_for_unit, infer_unit_ip, stem_from_name,
    )

    existing_by_ip: Dict[str, Dict[str, Any]] = {}
    existing_by_stem: Dict[str, Dict[int, Dict[str, Any]]] = {}
    if hall_id:
        try:
            for p in PDURepo.get_by_hall(int(hall_id)):
                ip = p.get("ip_address")
                if ip:
                    existing_by_ip[ip] = p
                hn = p.get("hostname") or p.get("label") or ""
                stem = stem_from_name(hn)
                parsed = npdu_chain.parse_suffix(hn)
                if stem and parsed:
                    existing_by_stem.setdefault(stem, {})[parsed[1]] = p
        except Exception as e:
            print(f"[chain-scan] hall lookup failed: {e}")

    out: List[Dict[str, Any]] = []
    seen: set = set()
    discovered_ips = {d.get("ip") for d in discovered if d.get("ip")}

    for d in discovered:
        master_ip = d.get("ip")
        if not master_ip or master_ip in seen:
            continue
        web_port = int(d.get("web_admin_port") or 80)
        units = _probe_npdu_chain_units(
            master_ip, community=community or "public",
            username=username or "admin", password=password or "admin",
            web_port=web_port,
        )
        db_master = existing_by_ip.get(master_ip) or {}
        stem = (
            stem_from_name(db_master.get("hostname") or db_master.get("label"))
            or stem_from_name(d.get("hostname") or d.get("name"))
        )
        slave_units = [u for u in units if u.get("slave_index", 0) > 0]
        has_chain = any(u.get("live") for u in slave_units) or bool(
            stem and any(i > 1 for i in (existing_by_stem.get(stem) or {}))
        )
        if has_chain and not stem:
            stem = fallback_stem(master_ip)

        for u in units:
            unit_index = int(u.get("unit_index") or 1)
            slave_index = int(u.get("slave_index") or 0)
            unit_ip = infer_unit_ip(master_ip, unit_index) or master_ip
            db_row = existing_by_ip.get(unit_ip)
            if stem and not db_row:
                db_row = (existing_by_stem.get(stem) or {}).get(unit_index)
                if db_row and db_row.get("ip_address"):
                    unit_ip = db_row["ip_address"]
            live = bool(u.get("live")) or electrically_live(u.get("voltage"), u.get("current"))
            if slave_index > 0 and not live and not db_row:
                continue
            if unit_ip in seen:
                continue
            # A later master in the LAN scan already claimed this IP — skip.
            if slave_index > 0 and unit_ip in discovered_ips:
                continue
            seen.add(unit_ip)
            role = "master" if slave_index == 0 else "slave"
            hn = hostname_for_unit(stem, unit_index)
            if db_row:
                hn = db_row.get("hostname") or db_row.get("label") or hn
            entry = dict(d)
            entry.update({
                "ip": unit_ip,
                "master_ip": master_ip,
                "chain_role": role,
                "slave_index": slave_index,
                "unit_index": unit_index,
                "chain_live": live,
                "hostname": hn or d.get("name") or "",
                "name": hn or d.get("name") or master_ip,
            })
            if role == "slave":
                entry["description"] = (
                    f"Daisy slave -{unit_index} via {master_ip}"
                    + (f" · {u.get('voltage', 0):.1f} V" if live else " · bus 0 V")
                )
                entry["web_admin_port"] = web_port
                entry["mac"] = ""
            else:
                n_slaves = sum(
                    1 for x in units
                    if x.get("slave_index", 0) > 0 and (
                        x.get("live") or (stem and (existing_by_stem.get(stem) or {}).get(x.get("unit_index")))
                    )
                )
                entry["chain_size"] = 1 + n_slaves
                if n_slaves:
                    entry["description"] = (
                        (d.get("description") or "NPDU") + f" · chain master ({1 + n_slaves} units)"
                    )
            out.append(entry)
    return out or discovered


def _sync_chain_slave_snmp(hall_id: int, master_ip: str, snmp: Dict[str, Any],
                           *, web_port: int, web_https: bool, web_user: str, web_pass: str) -> None:
    """Copy SNMP + web-admin creds onto hall rows that are slaves of this master."""
    if not snmp:
        return
    try:
        pdus = PDURepo.get_by_hall(int(hall_id))
    except Exception:
        return
    by_hn = {(p.get("hostname") or p.get("label") or ""): p for p in pdus}
    master = next((p for p in pdus if p.get("ip_address") == master_ip), None)
    stem = npdu_chain.stem_from_name((master or {}).get("hostname") or (master or {}).get("label"))
    community = snmp.get("read_community") or snmp.get("community_read") or "public"
    version = "3" if snmp.get("snmpv3") or snmp.get("snmpv3_enabled") else (
        "2c" if snmp.get("snmpv2", snmp.get("snmpv2_enabled", True)) else "1"
    )
    for p in pdus:
        hn = p.get("hostname") or p.get("label") or ""
        parsed = npdu_chain.parse_suffix(hn)
        if not parsed or parsed[1] <= 1:
            continue
        p_stem, _idx = parsed
        if stem and p_stem != stem:
            continue
        if not stem:
            expected_master = by_hn.get(npdu_chain.master_hostname_for(hn) or "")
            if not expected_master or expected_master.get("ip_address") != master_ip:
                continue
        ip = p.get("ip_address")
        if not ip or ip == master_ip:
            continue
        try:
            PDURepo.upsert(int(hall_id), ip, {
                "snmp_community_ref": community,
                "snmp_version": version,
                "web_admin_port": int(web_port or 80),
                "web_admin_https": 1 if web_https else 0,
                "web_admin_user": web_user,
                "web_admin_pass": web_pass,
            })
            _merge_pdu_metadata(ip, {
                "chain_role": "slave",
                "master_ip": master_ip,
                "snmp_via": master_ip,
            })
        except Exception as e:
            print(f"[batch] chain slave SNMP sync {ip}: {e}")


@app.route("/api/network/scan", methods=["POST"])
def scan_network():
    """Scan a network range to discover PDUs via SNMP."""
    import subprocess
    import ipaddress
    from concurrent.futures import ThreadPoolExecutor, as_completed
    
    try:
        data = request.get_json(force=True) if request.data else {}
        subnet = data.get("subnet", "192.168.1.0/24")
        community = data.get("community", "public")
        timeout = data.get("timeout", 1)
        
        # Parse subnet — supports CIDR (192.168.0.0/24), range (192.168.0.160-170),
        # or dash-separated full IPs (192.168.0.160-192.168.0.170)
        ip_list = []
        try:
            if "-" in subnet and "/" not in subnet:
                parts = subnet.split("-")
                base = parts[0].strip()
                end_part = parts[1].strip()
                base_octets = base.split(".")
                if "." in end_part:
                    end_octets = end_part.split(".")
                    start_ip = ipaddress.IPv4Address(base)
                    end_ip = ipaddress.IPv4Address(end_part)
                else:
                    start_ip = ipaddress.IPv4Address(base)
                    end_octets = base_octets[:3] + [end_part]
                    end_ip = ipaddress.IPv4Address(".".join(end_octets))
                if int(end_ip) < int(start_ip):
                    return jsonify({"error": "End IP must be >= start IP"}), 400
                count = int(end_ip) - int(start_ip) + 1
                if count > 1024:
                    return jsonify({"error": "Range too large. Max 1024 addresses"}), 400
                ip_list = [str(ipaddress.IPv4Address(int(start_ip) + i)) for i in range(count)]
            else:
                network = ipaddress.ip_network(subnet, strict=False)
                if network.num_addresses > 1024:
                    return jsonify({"error": "Subnet too large. Max /22 (1024 addresses)"}), 400
                ip_list = [str(ip) for ip in network.hosts()]
        except ValueError as e:
            return jsonify({"error": f"Invalid subnet/range: {e}"}), 400
        
        if not ip_list:
            return jsonify({"error": "No addresses to scan"}), 400
        
        discovered = []
        
        def check_snmp(ip_str):
            """Check if IP responds to SNMP. Tries v2c first, then v1."""
            for version in ["2c", "1"]:
                try:
                    result = subprocess.run(
                        ["snmpget", f"-v{version}", "-c", community, "-t", str(timeout), "-r", "0",
                         "-Oqv", f"{ip_str}:161", ".1.3.6.1.2.1.1.1.0"],
                        capture_output=True, text=True, timeout=timeout + 1
                    )
                    if result.returncode == 0 and result.stdout.strip():
                        name_result = subprocess.run(
                            ["snmpget", f"-v{version}", "-c", community, "-t", str(timeout), "-r", "0",
                             "-Oqv", f"{ip_str}:161", ".1.3.6.1.2.1.1.5.0"],
                            capture_output=True, text=True, timeout=timeout + 1
                        )
                        device_name = name_result.stdout.strip() if name_result.returncode == 0 else "Unknown"
                        return {
                            "ip": ip_str,
                            "description": result.stdout.strip()[:100],
                            "name": device_name,
                            "snmp_version": version,
                            "community": community
                        }
                except:
                    pass
            return None
        
        # Scan in parallel
        with ThreadPoolExecutor(max_workers=50) as executor:
            futures = {executor.submit(check_snmp, ip): ip 
                      for ip in ip_list}
            
            for future in as_completed(futures, timeout=60):
                result = future.result()
                if result:
                    discovered.append(result)
        
        expand = data.get("expand_chains", True)
        if expand and discovered:
            creds = data.get("current_credentials") or {}
            discovered = _expand_discovered_npdu_chains(
                discovered,
                community=community or "public",
                username=creds.get("username") or data.get("username") or "admin",
                password=creds.get("password") or data.get("password") or "admin",
                hall_id=data.get("hall_id"),
            )
        masters = sum(1 for d in discovered if d.get("chain_role") != "slave")
        slaves = sum(1 for d in discovered if d.get("chain_role") == "slave")
        return jsonify({
            "success": True,
            "subnet": subnet,
            "discovered": discovered,
            "count": len(discovered),
            "chain_masters": masters,
            "chain_slaves": slaves,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


def _detect_web_admin(ip: str) -> int | None:
    """Probe common web admin ports to see if the PDU has a CGI interface.
    Returns the port number if found, None otherwise."""
    import socket
    for port in [80, 6662, 8080, 443]:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(2)
            if sock.connect_ex((ip, port)) == 0:
                sock.close()
                # Verify it's actually a PDU web admin (check for login.cgi)
                try:
                    resp = _requests_lib.get(f"http://{ip}:{port}/", timeout=3)
                    if "login.cgi" in resp.text or "PDU" in resp.text:
                        print(f"[web-detect] {ip}:{port} — PDU web admin found")
                        return port
                except Exception:
                    pass
            else:
                sock.close()
        except Exception:
            pass
    return None


def _http_scan_entry(ip: str, port: int, *, use_https: bool = False, name: str = "PDU") -> dict:
    return {
        "ip": ip,
        "description": f"{'HTTPS' if use_https else 'HTTP'}/{port} web admin",
        "name": name,
        "snmp_version": "1",
        "community": "public",
        "web_admin_port": port,
        "web_admin_https": 1 if use_https else 0,
        "discovery_method": "http",
    }


def _http_probe_pdu(ip: str, ports: list[int] = None, connect_timeout: float = 1.5,
                    http_timeout: float = 3.0) -> dict | None:
    """Probe an IP for a PDU web admin interface over HTTP/HTTPS.

    Designed for use over VPN/firewalled networks where SNMP UDP/161 is blocked
    but TCP to the web admin port is allowed.  After batch HTTPS commissioning
    some PDUs only answer on 443 — treat an open TCP port as a positive hit even
    when the TLS/HTTP probe is imperfect.
    """
    import socket
    if ports is None:
        ports = [80, 6662, 8080, 443]

    for port in ports:
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(connect_timeout)
            rc = sock.connect_ex((ip, port))
        except Exception:
            rc = 1
        finally:
            try:
                if sock is not None:
                    sock.close()
            except Exception:
                pass
        if rc != 0:
            continue

        use_https = port == 443
        scheme = "https" if use_https else "http"
        body = ""
        try:
            from pdu_web_client import configure_pdu_session
            session = configure_pdu_session(_requests_lib.Session(), use_https=use_https)
            resp = session.get(
                f"{scheme}://{ip}:{port}/",
                timeout=http_timeout,
                verify=False,
                allow_redirects=True,
            )
            body = (resp.text or "")[:4096]
        except _requests_lib.exceptions.SSLError as ssl_err:
            # Retry once with explicit legacy context (should not happen after adapter fix).
            print(f"[http-probe] {ip}:{port} SSL retry after {ssl_err}")
            if port in (443, 80, 6662, 8080):
                return _http_scan_entry(ip, port, use_https=use_https)
            continue
        except Exception:
            # TCP open on a known PDU web port — report it; login probe comes later.
            if port in (80, 443, 6662, 8080):
                return _http_scan_entry(ip, port, use_https=use_https)
            continue

        lower = body.lower()
        looks_like_pdu = (
            "login.cgi" in lower
            or "pdu" in lower
            or "power distribution" in lower
            or "rack monitor" in lower
            or "home0.html" in lower
        )
        if not looks_like_pdu:
            continue

        name = "PDU"
        try:
            import re
            m = re.search(r"<title>(.*?)</title>", body, re.IGNORECASE | re.DOTALL)
            if m:
                name = m.group(1).strip()[:80] or "PDU"
        except Exception:
            pass

        return _http_scan_entry(ip, port, use_https=use_https, name=name)

    return None


@app.route("/api/network/scan/http", methods=["POST"])
def scan_network_http():
    """Scan a network range to discover PDUs via HTTP web-admin probes.

    Use this when SNMP UDP/161 is blocked by a corporate firewall or VPN.
    Accepts the same subnet syntax as /api/network/scan (CIDR, range, or single IP).
    Returns the same response shape so the frontend can use the same enrichment flow.
    """
    import ipaddress
    from concurrent.futures import ThreadPoolExecutor, as_completed

    try:
        data = request.get_json(force=True) if request.data else {}
        subnet = data.get("subnet", "192.168.1.0/24")
        ports = data.get("ports") or [80, 6662, 8080, 443]
        connect_timeout = float(data.get("connect_timeout", 1.5))
        http_timeout = float(data.get("http_timeout", 3.0))

        # Parse subnet — supports CIDR (192.168.0.0/24), range (192.168.0.160-170),
        # or dash-separated full IPs (192.168.0.160-192.168.0.170).
        ip_list: list[str] = []
        try:
            if "-" in subnet and "/" not in subnet:
                parts = subnet.split("-")
                base = parts[0].strip()
                end_part = parts[1].strip()
                base_octets = base.split(".")
                if "." in end_part:
                    start_ip = ipaddress.IPv4Address(base)
                    end_ip = ipaddress.IPv4Address(end_part)
                else:
                    start_ip = ipaddress.IPv4Address(base)
                    end_octets = base_octets[:3] + [end_part]
                    end_ip = ipaddress.IPv4Address(".".join(end_octets))
                if int(end_ip) < int(start_ip):
                    return jsonify({"error": "End IP must be >= start IP"}), 400
                count = int(end_ip) - int(start_ip) + 1
                if count > 1024:
                    return jsonify({"error": "Range too large. Max 1024 addresses"}), 400
                ip_list = [str(ipaddress.IPv4Address(int(start_ip) + i)) for i in range(count)]
            elif "/" in subnet:
                network = ipaddress.ip_network(subnet, strict=False)
                if network.num_addresses > 1024:
                    return jsonify({"error": "Subnet too large. Max /22 (1024 addresses)"}), 400
                ip_list = [str(ip) for ip in network.hosts()]
            else:
                ip_list = [str(ipaddress.IPv4Address(subnet.strip()))]
        except ValueError as e:
            return jsonify({"error": f"Invalid subnet/range: {e}"}), 400

        if not ip_list:
            return jsonify({"error": "No addresses to scan"}), 400

        print(f"[http-scan] Scanning {len(ip_list)} IPs on ports {ports} (connect_t={connect_timeout}s, http_t={http_timeout}s)")
        discovered: list[dict] = []

        with ThreadPoolExecutor(max_workers=50) as executor:
            futures = {
                executor.submit(_http_probe_pdu, ip, ports, connect_timeout, http_timeout): ip
                for ip in ip_list
            }
            scan_deadline = max(180.0, len(ip_list) * 2.0)
            try:
                completed = as_completed(futures, timeout=scan_deadline)
                for future in completed:
                    try:
                        result = future.result()
                    except Exception as e:
                        print(f"[http-scan] probe error for {futures[future]}: {e}")
                        continue
                    if result:
                        discovered.append(result)
                        print(f"[http-scan] FOUND {result['ip']} on port {result.get('web_admin_port')}")
            except TimeoutError:
                        print(f"[http-scan] scan timed out after {scan_deadline:.0f}s — returning {len(discovered)} partial hits")

        expand = data.get("expand_chains", True)
        if expand and discovered:
            creds = data.get("current_credentials") or {}
            discovered = _expand_discovered_npdu_chains(
                discovered,
                community=data.get("community") or "public",
                username=creds.get("username") or data.get("username") or "admin",
                password=creds.get("password") or data.get("password") or "admin",
                hall_id=data.get("hall_id"),
            )
        masters = sum(1 for d in discovered if d.get("chain_role") != "slave")
        slaves = sum(1 for d in discovered if d.get("chain_role") == "slave")
        return jsonify({
            "success": True,
            "subnet": subnet,
            "discovered": discovered,
            "count": len(discovered),
            "chain_masters": masters,
            "chain_slaves": slaves,
            "method": "http",
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/network/scan/ip", methods=["POST"])
def scan_single_ip():
    """Scan a single IP address for SNMP PDU. Tries v2c first, then v1."""
    import subprocess
    
    try:
        data = request.get_json(force=True) if request.data else {}
        ip = data.get("ip")
        community = data.get("community", "public")
        
        if not ip:
            return jsonify({"error": "IP address required"}), 400
        
        last_err = ""
        for version in ["2c", "1"]:
            try:
                result = subprocess.run(
                    ["snmpget", f"-v{version}", "-c", community, "-t", "2", "-r", "0",
                     "-Oqv", f"{ip}:161", ".1.3.6.1.2.1.1.1.0"],
                    capture_output=True, text=True, timeout=5
                )
                if result.returncode == 0 and result.stdout.strip():
                    name_result = subprocess.run(
                        ["snmpget", f"-v{version}", "-c", community, "-t", "2", "-r", "0",
                         "-Oqv", f"{ip}:161", ".1.3.6.1.2.1.1.5.0"],
                        capture_output=True, text=True, timeout=5
                    )
                    resp = {
                        "success": True,
                        "ip": ip,
                        "description": result.stdout.strip()[:100],
                        "name": name_result.stdout.strip() if name_result.returncode == 0 else "Unknown",
                        "snmp_version": version
                    }
                    # Auto-detect web admin interface
                    web_port = _detect_web_admin(ip)
                    if web_port:
                        resp["web_admin_port"] = web_port
                    return jsonify(resp)
                else:
                    last_err = result.stderr.strip()
            except subprocess.TimeoutExpired:
                last_err = f"v{version} timed out"
            except Exception as e:
                last_err = str(e)
        
        return jsonify({
            "success": False,
            "ip": ip,
            "error": "No SNMP response (tried v2c and v1)",
            "details": last_err
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdus/<int:pdu_id>", methods=["PUT"])
def update_pdu(pdu_id: int):
    """Rename or update a PDU."""
    try:
        data = request.get_json(force=True)
        label = data.get("label")
        if label and label.strip():
            PDURepo.rename(pdu_id, label.strip())
        return jsonify({"success": True, "id": pdu_id, "label": label})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdus/<int:pdu_id>/web-credentials", methods=["PUT"])
def update_pdu_web_credentials(pdu_id: int):
    """Verify and persist web-admin credentials for an already-commissioned PDU."""
    try:
        data = request.get_json(force=True)
        pdu = PDURepo.get(pdu_id)
        if not pdu:
            return jsonify({"error": "PDU not found"}), 404

        host = pdu.get("remote_host") or pdu["ip_address"]
        use_https = _parse_use_https(
            data.get("web_admin_https", pdu.get("web_admin_https", 0))
        )
        default_port = 443 if use_https else _DEFAULT_WEB_ADMIN_PORT
        port = int(data.get("web_admin_port") or pdu.get("web_admin_port") or default_port)
        username = _coalesce_credential(data.get("web_admin_user", pdu.get("web_admin_user")))
        password = _coalesce_credential(data.get("web_admin_pass", pdu.get("web_admin_pass")))

        prefer_https = True if use_https else (False if "web_admin_https" in data else None)
        client, port, use_https = _connect_pdu_admin_probe(
            host, username, password, port=port, prefer_https=prefer_https
        )
        try:
            client.logout()
        except Exception:
            pass

        PDURepo.upsert(
            pdu["hall_id"],
            pdu["ip_address"],
            {
                "web_admin_port": port,
                "web_admin_https": use_https,
                "web_admin_user": username,
                "web_admin_pass": password,
            },
        )
        _evict_pdu_client(host, port, use_https)
        return jsonify({"success": True, "ip_address": pdu["ip_address"]})
    except ConnectionError as e:
        return jsonify({"error": str(e)}), 401
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/<int:hall_id>/pdus/bulk-reboot", methods=["POST"])
def bulk_reboot_pdus(hall_id: int):
    """Reboot selected PDUs via web admin reboot.cgi (same path as PDU Settings Apply & Reboot).

    Body:
      pdu_ids — list of PDU database ids (required, non-empty)
      wait — if true, wait up to 90 s per PDU for it to come back online (default false)
    """
    try:
        hall = HallRepo.get(hall_id)
        if not hall:
            return jsonify({"error": "Hall not found"}), 404

        data = request.get_json(force=True) if request.data else {}
        pdu_ids_raw = data.get("pdu_ids")
        if not pdu_ids_raw:
            return jsonify({"error": "pdu_ids is required"}), 400
        pdu_ids = {int(x) for x in pdu_ids_raw}
        wait = bool(data.get("wait", False))

        pdus = PDURepo.get_by_hall(hall_id)
        targets = [p for p in pdus if p["id"] in pdu_ids]
        if not targets:
            return jsonify({"error": "No matching PDUs in this hall"}), 400

        results: List[Dict[str, Any]] = []
        _pause_pdu_poller()
        try:
            for idx, pdu in enumerate(targets):
                if idx > 0:
                    time.sleep(2)
                results.append(_reboot_pdu_via_web(pdu, wait=wait))
        finally:
            _resume_pdu_poller()

        attempted = [r for r in results if not r.get("skipped")]
        ok = sum(1 for r in attempted if r.get("success"))
        skipped = sum(1 for r in results if r.get("skipped"))
        failed = len(attempted) - ok

        return jsonify({
            "success": ok > 0 and failed == 0,
            "hall_id": hall_id,
            "hall_name": hall.get("name"),
            "total": len(results),
            "rebooted": ok,
            "failed": failed,
            "skipped": skipped,
            "results": results,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/<int:hall_id>/pdus/repair-web-access", methods=["POST"])
def repair_hall_web_access(hall_id: int):
    """Re-probe commissioned PDUs in a hall and fix stored web-admin credentials.

    Body (optional):
      web_admin_user, web_admin_pass — credentials to try on each PDU (default admin/admin)
      pdu_ids — list of PDU database ids; omit to repair all web-enabled PDUs in the hall
    """
    try:
        hall = HallRepo.get(hall_id)
        if not hall:
            return jsonify({"error": "Hall not found"}), 404

        data = request.get_json(force=True) if request.data else {}
        user = data.get("web_admin_user") or data.get("username")
        password = data.get("web_admin_pass") or data.get("password")
        pdu_ids = data.get("pdu_ids")
        if pdu_ids is not None:
            pdu_ids = {int(x) for x in pdu_ids}

        pdus = PDURepo.get_by_hall(hall_id)
        results = []
        _pause_pdu_poller()
        try:
            for pdu in pdus:
                if pdu_ids is not None and pdu["id"] not in pdu_ids:
                    continue
                _evict_all_pdu_clients_for_host(pdu.get("remote_host") or pdu["ip_address"])
                before = _analyze_pdu_db_credentials(pdu)
                repair_result = _smart_repair_pdu(pdu, username=user, password=password)
                ok = repair_result.get("success", False)
                after = repair_result.get("after")
                if ok and not after:
                    refreshed = PDURepo.get(pdu["id"]) or pdu
                    after = {
                        "web_admin_port": refreshed.get("web_admin_port"),
                        "web_admin_https": bool(refreshed.get("web_admin_https")),
                        "web_admin_user": refreshed.get("web_admin_user"),
                    }
                results.append({
                    "id": pdu["id"],
                    "ip": pdu["ip_address"],
                    "label": pdu.get("label") or pdu.get("hostname"),
                    "success": ok,
                    "code": repair_result.get("code"),
                    "message": repair_result.get("message"),
                    "error": None if ok else repair_result.get("error"),
                    "recommendation": repair_result.get("recommendation"),
                    "credential_source": repair_result.get("credential_source"),
                    "before": before,
                    "after": after,
                    "steps": repair_result.get("steps", []),
                })
                time.sleep(1.5)
        finally:
            _resume_pdu_poller()
        attempted = [r for r in results if not r.get("skipped")]
        repaired = sum(1 for r in attempted if r["success"])
        return jsonify({
            "success": True,
            "hall_id": hall_id,
            "hall_name": hall.get("name"),
            "repaired": repaired,
            "total": len(attempted),
            "results": results,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdus/<int:pdu_id>", methods=["DELETE"])
def delete_pdu(pdu_id: int):
    """Delete a PDU (permanent removal)."""
    try:
        pdu = PDURepo.get(pdu_id)
        if not pdu:
            return jsonify({"error": "PDU not found"}), 404
        
        # Remove from adaptive poller if running
        if USE_ADAPTIVE_POLLING:
            try:
                poller = _get_adaptive_poller()
                poller.remove_device(pdu["ip_address"])
            except:
                pass
        
        PDURepo.hard_delete(pdu_id)
        return jsonify({"success": True, "message": f"PDU {pdu.get('label', pdu_id)} deleted"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/<int:hall_id>/pdus/add", methods=["POST"])
def add_pdu_to_hall(hall_id: int):
    """Add a discovered PDU to a data hall."""
    try:
        data = request.get_json(force=True)
        ip_address = data.get("ip_address")
        label = data.get("label", f"PDU-{ip_address}")
        rack_code = data.get("rack_code")
        mount_position = data.get("mount_position", "A")
        snmp_port = data.get("snmp_port", 161)
        snmp_community = data.get("snmp_community", "public")
        
        if not ip_address:
            return jsonify({"error": "IP address required"}), 400
        
        # Resolve rack_id from rack_code if provided
        rack_id = None
        if rack_code:
            racks = RackRepo.get_by_hall(hall_id)
            for r in racks:
                if r.get("rack_code") == rack_code:
                    rack_id = r["id"]
                    break
        
        pdu_data = {
            "label": label,
            "rack_id": rack_id,
            "mount_position": mount_position,
            "snmp_port": snmp_port,
            "snmp_community_ref": snmp_community,
            "snmp_version": data.get("snmp_version", "2c"),
            "is_active": True,
            "mac_address": data.get("mac_address"),
            "hostname": data.get("hostname"),
            "remote_host": data.get("remote_host"),
            "web_admin_port": data.get("web_admin_port"),
            "web_admin_https": 1 if _parse_use_https(data.get("web_admin_https", 0)) else 0,
            "web_admin_user": data.get("web_admin_user") or "admin",
            "web_admin_pass": data.get("web_admin_pass") or "admin",
        }
        pdu_id = PDURepo.upsert(hall_id, ip_address, pdu_data)
        
        # Add to adaptive poller
        if USE_ADAPTIVE_POLLING:
            poller = _get_adaptive_poller()
            poller.add_device(ip_address, snmp_port)
        
        return jsonify({
            "success": True,
            "pdu_id": pdu_id,
            "ip_address": ip_address,
            "rack_code": rack_code,
            "mount_position": mount_position,
            "message": f"PDU {ip_address} added to hall {hall_id}"
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/network/scan/factory-default", methods=["POST"])
def scan_factory_default():
    """Scan factory default IP(s) for a new PDU. Tries 192.168.0.163 first,
    then optionally scans the 192.168.0.0/24 subnet."""
    import subprocess
    
    try:
        data = request.get_json(force=True) if request.data else {}
        community = data.get("community", "public")
        scan_subnet = data.get("scan_subnet", False)
        factory_ip = data.get("factory_ip", "192.168.0.163")
        
        # Try the factory default IP first (v2c then v1)
        last_err = ""
        for version in ["2c", "1"]:
            try:
                result = subprocess.run(
                    ["snmpget", f"-v{version}", "-c", community, "-t", "2", "-r", "0",
                     "-Oqv", f"{factory_ip}:161", ".1.3.6.1.2.1.1.1.0"],
                    capture_output=True, text=True, timeout=5
                )
                if result.returncode == 0 and result.stdout.strip():
                    name_result = subprocess.run(
                        ["snmpget", f"-v{version}", "-c", community, "-t", "2", "-r", "0",
                         "-Oqv", f"{factory_ip}:161", ".1.3.6.1.2.1.1.5.0"],
                        capture_output=True, text=True, timeout=5
                    )
                    resp = {
                        "success": True,
                        "found": True,
                        "device": {
                            "ip": factory_ip,
                            "description": result.stdout.strip()[:200],
                            "name": name_result.stdout.strip() if name_result.returncode == 0 else "Unknown",
                            "snmp_version": version,
                            "community": community
                        }
                    }
                    web_port = _detect_web_admin(factory_ip)
                    if web_port:
                        resp["device"]["web_admin_port"] = web_port
                    return jsonify(resp)
                else:
                    last_err = result.stderr.strip()
            except subprocess.TimeoutExpired:
                last_err = f"v{version} timed out"
            except Exception as e:
                last_err = str(e)
        
        if not scan_subnet:
            return jsonify({
                "success": True,
                "found": False,
                "message": f"No PDU found at {factory_ip}"
            })
        
        # Fallback: scan 192.168.0.0/24
        import ipaddress
        from concurrent.futures import ThreadPoolExecutor, as_completed as cf_as_completed
        
        network = ipaddress.ip_network("192.168.0.0/24", strict=False)
        discovered = []
        
        def probe(ip_str):
            for ver in ["2c", "1"]:
                try:
                    r = subprocess.run(
                        ["snmpget", f"-v{ver}", "-c", community, "-t", "1", "-r", "0",
                         "-Oqv", f"{ip_str}:161", ".1.3.6.1.2.1.1.1.0"],
                        capture_output=True, text=True, timeout=3
                    )
                    if r.returncode == 0 and r.stdout.strip():
                        return {"ip": ip_str, "description": r.stdout.strip()[:200], "name": "Unknown", "snmp_version": ver, "community": community}
                except:
                    pass
            return None
        
        with ThreadPoolExecutor(max_workers=50) as executor:
            futures = {executor.submit(probe, str(ip)): str(ip) for ip in network.hosts()}
            for future in cf_as_completed(futures, timeout=30):
                r = future.result()
                if r:
                    discovered.append(r)
        
        return jsonify({
            "success": True,
            "found": len(discovered) > 0,
            "devices": discovered,
            "message": f"Found {len(discovered)} device(s) on 192.168.0.0/24"
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/<int:hall_id>/pdus/next-ip", methods=["GET"])
def get_next_ip(hall_id: int):
    """Return the next available sequential IP for a hall based on its config
    and already-commissioned PDUs."""
    try:
        state = HallRepo.get_full_state(hall_id)
        if not state:
            return jsonify({"error": "Hall not found"}), 404
        
        config = state.get("config") or {}
        ip_planning = config.get("ipPlanning", {})
        subnet = ip_planning.get("subnet", "10.20.0.0/24")
        
        # Parse base IP and starting host
        base, mask = subnet.split("/")
        parts = base.split(".")
        start_host = int(parts[3]) if int(parts[3]) > 0 else 1
        
        # Collect all IPs already assigned in this hall
        existing_pdus = state.get("pdus") or []
        used_ips = {p.get("ip_address") for p in existing_pdus if p.get("ip_address")}
        
        # Find next available IP sequentially
        for i in range(0, 1024):
            host = start_host + i
            if host > 254:
                break
            candidate = f"{parts[0]}.{parts[1]}.{parts[2]}.{host}"
            if candidate not in used_ips:
                return jsonify({
                    "success": True,
                    "next_ip": candidate,
                    "subnet": subnet,
                    "commissioned_count": len(used_ips),
                    "used_ips": sorted(list(used_ips))
                })
        
        return jsonify({"success": False, "error": "No available IPs in subnet"})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/<int:hall_id>/racks/available", methods=["GET"])
def get_available_racks(hall_id: int):
    """Return racks with their open PDU slots for commissioning."""
    try:
        state = HallRepo.get_full_state(hall_id)
        if not state:
            return jsonify({"error": "Hall not found"}), 404
        
        config = state.get("config") or {}
        pdus_per_rack = config.get("pdu", {}).get("pdusPerRack", 2)
        mounting = config.get("pdu", {}).get("mounting", "A/B")
        
        existing_pdus = state.get("pdus") or []
        # Build map: rack_code -> list of occupied mount positions
        occupied = {}
        for p in existing_pdus:
            rc = p.get("rack_code")
            if rc:
                occupied.setdefault(rc, []).append(p.get("mount_position", "A"))
        
        # Generate rack list from layout config
        from db.persistence import RackRepo as RR
        racks = RR.get_by_hall(hall_id)
        
        available = []
        for rack in racks:
            rc = rack.get("rack_code", "")
            occ = occupied.get(rc, [])
            slots = []
            for idx in range(pdus_per_rack):
                pos = ("A" if idx == 0 else "B") if mounting == "A/B" else ("Left" if idx == 0 else "Right")
                if pos not in occ:
                    slots.append(pos)
            if slots:
                available.append({
                    "rack_code": rc,
                    "rack_id": rack.get("id"),
                    "row_index": rack.get("row_index"),
                    "position_index": rack.get("position_index"),
                    "open_slots": slots,
                    "total_slots": pdus_per_rack,
                    "occupied": len(occ)
                })
        
        return jsonify({
            "success": True,
            "racks": available,
            "total_racks": len(racks),
            "racks_with_space": len(available)
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/<int:hall_id>/pdus/bulk-rack-assign", methods=["POST"])
def bulk_rack_assign(hall_id: int):
    """Assign multiple PDUs to racks in one call.
    Expects { assignments: [{ pdu_ip, rack_id, mount_position }] }"""
    try:
        data = request.get_json(force=True)
        assignments = data.get("assignments", [])
        if not assignments:
            return jsonify({"error": "No assignments provided"}), 400

        results = []
        for a in assignments:
            pdu_ip = a.get("pdu_ip")
            rack_id = a.get("rack_id")
            mount_pos = a.get("mount_position", "A")
            try:
                pdu = PDURepo.get_by_ip(pdu_ip)
                if not pdu or pdu.get("hall_id") != hall_id:
                    results.append({"ip": pdu_ip, "success": False, "error": "PDU not found in hall"})
                    continue
                PDURepo.upsert(
                    hall_id,
                    pdu_ip,
                    {"rack_id": rack_id, "mount_position": mount_pos},
                )
                results.append({"ip": pdu_ip, "success": True})
            except Exception as e:
                results.append({"ip": pdu_ip, "success": False, "error": str(e)})

        ok_count = sum(1 for r in results if r["success"])
        return jsonify({
            "success": True,
            "assigned": ok_count,
            "total": len(assignments),
            "results": results,
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/halls/<int:hall_id>/snapshot", methods=["POST"])
def create_hall_snapshot(hall_id: int):
    """Record a hall's layout + last-24h telemetry into a replayable snapshot file.

    Runs against whichever db is active for the request. Intended for real halls
    (admin session), so the recording can later be replayed in a customer demo.
    """
    try:
        from demo.replay import build_snapshot, save_snapshot
        body = request.get_json(force=True, silent=True) or {}
        window_hours = int(body.get("window_hours", 24))
        bundle = build_snapshot(hall_id, window_hours=window_hours)
        meta = save_snapshot(bundle)
        if meta.get("frame_count", 0) == 0:
            meta["warning"] = "No recorded telemetry found in the window — layout captured, but replay will be static."
        return jsonify({"success": True, **meta})
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    # For local dev only (in Docker this will be managed via CMD)
    port = int(os.getenv("PORT", 5000))
    
    # Start polling system based on configuration
    if USE_ADAPTIVE_POLLING:
        print("[Startup] Using ADAPTIVE polling system")
        _ensure_adaptive_polling()
    else:
        print("[Startup] Using LEGACY multi-PDU poller")
        ensure_multi_pdu_poller()
    
    app.run(host="0.0.0.0", port=port, debug=True, use_reloader=False)
