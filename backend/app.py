import os
from flask import Flask, request, jsonify, make_response
from flask_cors import CORS
import json
import time
from typing import List, Tuple, Dict, Any
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

def snmp_walk(ip: str, port: int, base_oid: str, timeout: int = OUTLET_BASE_TIMEOUT) -> dict[str, str]:
    """Walk an OID tree and return {full_oid: value} mapping. Uses numeric OIDs and prints
    value only for easier parsing while keeping the OID on each line ("-On -Ov").
    """
    import subprocess
    try:
        cmd = [
            "snmpwalk",
            "-v2c",
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
def snmp_get_batch(ip: str, port: int, oids: list[str], retries: int | None = None, timeout: int | None = None) -> dict[str, str | None]:
    """Fetch a list of OIDs in a *single* snmpget process call to drastically
    reduce overhead. Returns a mapping of oid -> value (None on error).
    Optionally override timeout (seconds) and retries for this batch.
    """
    import subprocess, shlex

    # Fallback to sensible defaults if not specified
    retry_count = retries if retries is not None else 3
    base_timeout = timeout if timeout is not None else 2

    cmd = [
        "snmpget",
        "-v2c",
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


def snmp_get_outlets(ip: str, port: int, base_oid: str, timeout: int = 3) -> Dict[str, str]:
    """Run snmpget for all outlet OIDs of a given type.
    Returns a mapping of OID to value.
    """
    import subprocess
    try:
        # Build OIDs for all 24 outlets
        oids = [f"{base_oid}.{i}.0" for i in range(1, 25)]
        
        cmd = [
            "snmpget",
            "-v2c",
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

def set_outlet_status_via_http(ip: str, outlet: int, state: str) -> tuple[bool, str]:
    """Set outlet status using HTTP control interface.
    state must be 'on' or 'off'
    Returns (success, error_message)
    """
    try:
        print(f"[DEBUG] set_outlet_status_via_http called with ip={ip}, outlet={outlet}, state={state}")
        # PDU uses port 80 for control interface
        # b=2 for ON, b=1 for OFF
        value = "2" if state.lower() == "on" else "1"  # b=2 for ON, b=1 for OFF
        
        import requests
        url = f"http://{ip}:80/setcontrol?a={outlet}&b={value}"
        print(f"[DEBUG] Sending request to: {url}")
        response = requests.get(url, timeout=5)
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
            
        print(f"[DEBUG] Calling set_outlet_status_via_http with ip={ip}, outlet={outlet}, state={state}")
        success, error = set_outlet_status_via_http(
            ip,
            outlet,
            state
        )
        
        print(f"[DEBUG] Control result: success={success}, error={error}")
        if success:
            # Trigger priority polling for this outlet after successful control
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


def _poll_remote_pdu(pdu: Dict[str, Any]) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
    """Poll a remote PDU via its web admin CGI panel."""
    ip = pdu["ip_address"]
    host = pdu.get("remote_host") or ip
    web_port = pdu.get("web_admin_port", 6662)
    web_user = pdu.get("web_admin_user", "admin")
    web_pass = pdu.get("web_admin_pass", "admin")

    results = {}
    errors = {}

    try:
        client = _get_pdu_client(host, web_port, web_user, web_pass)
        tele = client.get_live_telemetry()

        # Store ALL raw web admin fields under their original CGI key names
        _skip = {"csrf", "breakers", "datetime", "alarm_status", "alarm_color",
                 "l1_color", "l2_color", "l3_color", "name", "firmware"}
        for key, val in tele.items():
            if key in _skip or key.startswith("field_"):
                continue
            results[key] = {"name": key, "oid": f"web:{key}", "value": str(val)}

        # Also store SNMP-compatible aliases so the main dashboard can find them
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

    except Exception as e:
        errors["_remote"] = {"name": "_remote", "error": str(e)}

    return ip, results, errors


def poll_single_pdu(pdu: Dict[str, Any]) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
    """Poll a single PDU and return (ip, results, errors).
    Uses web admin CGI for remote PDUs, SNMP for local PDUs."""
    if pdu.get("web_admin_port"):
        return _poll_remote_pdu(pdu)

    ip = pdu["ip_address"]
    port = pdu.get("snmp_port", 161)
    
    results = {}
    errors = {}
    
    # Poll device-level OIDs
    device_oids = [
        ("TotalCurrent", ".1.3.6.1.4.1.23273.3.1.1.2.1.0"),
        ("TotalPower", ".1.3.6.1.4.1.23273.3.1.1.2.2.0"),
        ("TotalEnergy", ".1.3.6.1.4.1.23273.3.1.1.2.5.0"),
    ]
    
    mapping = snmp_get_batch(ip, port, [oid for _, oid in device_oids], retries=3, timeout=3)
    for name, oid in device_oids:
        value = mapping.get(oid)
        if value is not None and not str(value).startswith("Error:"):
            results[name] = {"name": name, "oid": oid, "value": value}
        else:
            errors[name] = {"name": name, "oid": oid, "error": "No response"}
    
    # Poll outlets (1-24)
    for outlet in range(1, 25):
        status_oid = f"{OUTPUT_PREFIXES['Status']}.{outlet}.0"
        current_oid = f"{OUTPUT_PREFIXES['Current']}.{outlet}.0"
        energy_oid = f"{OUTPUT_PREFIXES['Energy']}.{outlet}.0"
        name_oid = f"{OUTPUT_PREFIXES['Name']}.{outlet}.0"
        
        outlet_mapping = snmp_get_batch(ip, port, [status_oid, current_oid, energy_oid, name_oid], retries=2, timeout=2)
        
        for metric, oid in [
            (f"Output{outlet}Status", status_oid),
            (f"Output{outlet}Current", current_oid),
            (f"Output{outlet}Energy", energy_oid),
            (f"Output{outlet}Name", name_oid)
        ]:
            value = outlet_mapping.get(oid)
            if value is not None and not str(value).startswith("Error:"):
                results[metric] = {"name": metric, "oid": oid, "value": value}
            else:
                errors[metric] = {"name": metric, "oid": oid, "error": "No response"}
    
    return ip, results, errors


_REMOTE_PDU_POLL_INTERVAL = 30  # seconds between web admin polls (avoid session churn)
_remote_pdu_last_poll: Dict[str, float] = {}

def multi_pdu_poller():
    """Background polling thread that polls ALL active PDUs from database.
    Remote PDUs are polled at a slower cadence to avoid session exhaustion."""
    global MULTI_PDU_RESULTS, MULTI_PDU_ERRORS
    
    while not MULTI_PDU_STOP:
        try:
            all_pdus = PDURepo.get_all_active()

            # When adaptive polling is active, only handle remote PDUs here
            if USE_ADAPTIVE_POLLING:
                pdus = [p for p in all_pdus if p.get("web_admin_port")]
            else:
                pdus = all_pdus
            
            if not pdus:
                time.sleep(10)
                continue
            
            cycle_start = time.time()
            now = time.time()

            # Rate-limit remote PDUs to _REMOTE_PDU_POLL_INTERVAL
            pdus_to_poll = []
            for pdu in pdus:
                ip = pdu.get("ip_address", "")
                if pdu.get("web_admin_port"):
                    last = _remote_pdu_last_poll.get(ip, 0)
                    if now - last < _REMOTE_PDU_POLL_INTERVAL:
                        continue
                pdus_to_poll.append(pdu)

            if not pdus_to_poll:
                time.sleep(2)
                continue

            print(f"[multi_pdu_poller] Polling {len(pdus_to_poll)} PDUs (of {len(pdus)} total)...")
            
            with ThreadPoolExecutor(max_workers=min(len(pdus_to_poll), 8)) as executor:
                futures = {executor.submit(poll_single_pdu, pdu): pdu for pdu in pdus_to_poll}
                
                for future in as_completed(futures):
                    try:
                        ip, results, errors = future.result()
                        with MULTI_PDU_LOCK:
                            MULTI_PDU_RESULTS[ip] = results
                            MULTI_PDU_ERRORS[ip] = errors
                        
                        pdu_obj = futures[future]
                        if pdu_obj.get("web_admin_port"):
                            _remote_pdu_last_poll[ip] = time.time()

                        if results:
                            try:
                                store_poll_snapshot(ip, results)
                            except Exception as e:
                                print(f"[multi_pdu_poller] Error storing snapshot for {ip}: {e}")
                                
                    except Exception as e:
                        pdu_obj = futures[future]
                        print(f"[multi_pdu_poller] Error polling {pdu_obj.get('ip_address')}: {e}")
            
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
        return jsonify(state)
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
        return jsonify(state)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
        
        pdu = PDURepo.get_by_ip(ip_address)
        if not pdu:
            return jsonify({"error": "PDU not found"}), 404
        
        period = request.args.get("period", "day")
        limit = int(request.args.get("limit", 500))
        
        # Calculate time range
        now = datetime.now()
        if period == "week":
            from_time = now - timedelta(days=7)
        elif period == "month":
            from_time = now - timedelta(days=30)
        else:  # day
            from_time = now - timedelta(days=1)
        
        from_ts = from_time.isoformat()
        
        # Get history - use None for from_ts to get all available data
        history = TelemetryRepo.get_history(pdu["id"], from_ts=None, to_ts=None, limit=limit)
        
        # Extract power values for chart
        chart_data = []
        for entry in reversed(history):  # Oldest first for chart
            payload = entry.get("payload", {})
            
            # Payload is stored as flat key-value pairs, not in "results" array
            def get_val(key):
                val = payload.get(key, "0")
                if isinstance(val, str):
                    val = val.replace('"', '').strip()
                try:
                    return float(val) if val else 0
                except:
                    return 0
            
            power = get_val("MasterPowerP1")
            voltage = get_val("MasterVoltageP1")
            current = get_val("MasterCurrentP1")
            energy = get_val("MasterEnergyP1")
            
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

        # --- Local PDU: use adaptive poller (SNMP) ---
        if USE_ADAPTIVE_POLLING:
            poller = _get_adaptive_poller()
            if not poller._running:
                _ensure_adaptive_polling()
            return jsonify(poller.get_live_data(ip_address))
        
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


@app.route("/api/polling/device/<path:ip_address>", methods=["GET"])
def get_polling_device_status(ip_address: str):
    """Get polling status for a specific device.
    For remote PDUs (web_admin_port set), checks via lightweight TCP probe
    to avoid stealing the PDU's single session slot."""
    try:
        pdu = PDURepo.get_by_ip(ip_address)
        if pdu and pdu.get("web_admin_port"):
            remote_host = request.args.get("remote_host") or pdu.get("remote_host") or ip_address
            web_port = pdu["web_admin_port"]
            try:
                import socket
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(5)
                sock.connect((remote_host, int(web_port)))
                sock.close()
                return jsonify({"state": "online", "source": "web_admin"})
            except Exception:
                return jsonify({"state": "offline", "source": "web_admin"})

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

# Cache of active PDU web clients (keyed by "host:port")
_pdu_clients: Dict[str, PDUWebClient] = {}
_pdu_clients_lock = Lock()


def _get_pdu_client(host: str, port: int = 6662,
                     username: str = "admin", password: str = "admin") -> PDUWebClient:
    key = f"{host}:{port}"
    with _pdu_clients_lock:
        client = _pdu_clients.get(key)
        if client is None:
            client = PDUWebClient(host, port, username, password)
            _pdu_clients[key] = client
        return client


@app.route("/api/pdu-admin/connect", methods=["POST"])
def pdu_admin_connect():
    """Login to a PDU web admin panel and return device info + all settings."""
    try:
        data = request.get_json(force=True)
        host = data.get("host", "").strip()
        port = int(data.get("port", 6662))
        username = data.get("username", "admin")
        password = data.get("password", "admin")

        if not host:
            return jsonify({"error": "host is required"}), 400

        client = _get_pdu_client(host, port, username, password)
        if not client.login():
            return jsonify({"error": "Login failed — check credentials"}), 401

        settings = client.get_all_settings()
        return jsonify({"success": True, **settings})
    except requests.exceptions.ConnectionError:
        return jsonify({"error": f"Cannot reach PDU at {host}:{port}"}), 502
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/settings", methods=["GET"])
def pdu_admin_get_settings(host: str):
    """Read all settings from a PDU."""
    try:
        port = int(request.args.get("port", 6662))
        username = request.args.get("username", "admin")
        password = request.args.get("password", "admin")
        client = _get_pdu_client(host, port, username, password)
        settings = client.get_all_settings()
        return jsonify({"success": True, **settings})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/settings/network", methods=["POST"])
def pdu_admin_set_network(host: str):
    """Change IPv4 settings on a PDU.  Optionally reboots the device so the
    new settings take effect on the network interface."""
    try:
        data = request.get_json(force=True)
        port = int(data.get("web_port", 6662))
        username = data.get("username", "admin")
        password = data.get("password", "admin")
        client = _get_pdu_client(host, port, username, password)

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
            client.reboot()
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
        port = int(data.get("web_port", 6662))
        username = data.get("username", "admin")
        password = data.get("password", "admin")
        wait = data.get("wait", False)

        client = _get_pdu_client(host, port, username, password)
        client.reboot()

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
        port = int(request.args.get("port", 6662))
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
        port = int(data.get("web_port", 6662))
        username = data.get("username", "admin")
        password = data.get("password", "admin")
        client = _get_pdu_client(host, port, username, password)

        ok = client.set_snmp(
            read_community=data.get("community_read"),
            write_community=data.get("community_write"),
            snmpv1=data.get("snmpv1"),
            snmpv2=data.get("snmpv2"),
            snmpv3=data.get("snmpv3"),
            trap_ip=data.get("trap_ip"),
            snmpv3_username=data.get("snmpv3_username"),
            verify_protocol=data.get("verify_protocol"),
            auth_key=data.get("auth_key"),
            encrypt_protocol=data.get("encrypt_protocol"),
            priv_key=data.get("priv_key"),
        )
        if ok:
            return jsonify({"success": True, "message": "SNMP settings applied"})
        return jsonify({"error": "Failed to apply SNMP settings"}), 500
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/settings/time", methods=["POST"])
def pdu_admin_set_time(host: str):
    """Change time/SNTP settings on a PDU."""
    try:
        data = request.get_json(force=True)
        port = int(data.get("web_port", 6662))
        username = data.get("username", "admin")
        password = data.get("password", "admin")
        client = _get_pdu_client(host, port, username, password)

        ok = client.set_time(
            year=data.get("year"), month=data.get("month"), day=data.get("day"),
            hour=data.get("hour"), minute=data.get("minute"), second=data.get("second"),
            sntp_enabled=data.get("sntp_enabled"),
            sntp_server=data.get("sntp_server"),
            timezone=data.get("timezone"),
            update_interval=data.get("update_interval"),
            correction=data.get("correction"),
        )
        if ok:
            return jsonify({"success": True, "message": "Time settings applied"})
        return jsonify({"error": "Failed to apply time settings"}), 500
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/telemetry", methods=["GET"])
def pdu_admin_telemetry(host: str):
    """Get live telemetry from a PDU via its web admin CGI."""
    try:
        port = int(request.args.get("port", 6662))
        username = request.args.get("username", "admin")
        password = request.args.get("password", "admin")
        client = _get_pdu_client(host, port, username, password)
        telemetry = client.get_live_telemetry()
        return jsonify({"success": True, "telemetry": telemetry})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/logs", methods=["GET"])
def pdu_admin_logs(host: str):
    """Get event logs from a PDU."""
    try:
        port = int(request.args.get("port", 6662))
        username = request.args.get("username", "admin")
        password = request.args.get("password", "admin")
        client = _get_pdu_client(host, port, username, password)
        logs = client.get_logs()
        return jsonify({"success": True, "logs": logs})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/alarm-thresholds", methods=["GET"])
def pdu_admin_get_alarm_thresholds(host: str):
    """Read alarm threshold settings from a PDU."""
    try:
        port = int(request.args.get("port", 6662))
        username = request.args.get("username", "admin")
        password = request.args.get("password", "admin")
        client = _get_pdu_client(host, port, username, password)
        thresholds = client.get_alarm_thresholds()
        return jsonify({"success": True, "thresholds": thresholds})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdu-admin/<host>/alarm-thresholds", methods=["POST"])
def pdu_admin_set_alarm_thresholds(host: str):
    """Write alarm threshold settings to a PDU."""
    try:
        port = int(request.args.get("port", 6662))
        username = request.args.get("username", "admin")
        password = request.args.get("password", "admin")
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
        
        # Parse subnet
        try:
            network = ipaddress.ip_network(subnet, strict=False)
        except ValueError as e:
            return jsonify({"error": f"Invalid subnet: {e}"}), 400
        
        # Limit scan size
        if network.num_addresses > 1024:
            return jsonify({"error": "Subnet too large. Max /22 (1024 addresses)"}), 400
        
        discovered = []
        
        def check_snmp(ip_str):
            """Check if IP responds to SNMP."""
            try:
                result = subprocess.run(
                    ["snmpget", "-v2c", "-c", community, "-t", str(timeout), "-r", "0",
                     "-Oqv", f"{ip_str}:161", ".1.3.6.1.2.1.1.1.0"],
                    capture_output=True, text=True, timeout=timeout + 1
                )
                if result.returncode == 0 and result.stdout.strip():
                    # Get device name
                    name_result = subprocess.run(
                        ["snmpget", "-v2c", "-c", community, "-t", str(timeout), "-r", "0",
                         "-Oqv", f"{ip_str}:161", ".1.3.6.1.2.1.1.5.0"],
                        capture_output=True, text=True, timeout=timeout + 1
                    )
                    device_name = name_result.stdout.strip() if name_result.returncode == 0 else "Unknown"
                    return {
                        "ip": ip_str,
                        "description": result.stdout.strip()[:100],
                        "name": device_name,
                        "snmp_version": "2c",
                        "community": community
                    }
            except:
                pass
            return None
        
        # Scan in parallel
        with ThreadPoolExecutor(max_workers=50) as executor:
            futures = {executor.submit(check_snmp, str(ip)): str(ip) 
                      for ip in network.hosts()}
            
            for future in as_completed(futures, timeout=60):
                result = future.result()
                if result:
                    discovered.append(result)
        
        return jsonify({
            "success": True,
            "subnet": subnet,
            "discovered": discovered,
            "count": len(discovered)
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/network/scan/ip", methods=["POST"])
def scan_single_ip():
    """Scan a single IP address for SNMP PDU."""
    import subprocess
    
    try:
        data = request.get_json(force=True) if request.data else {}
        ip = data.get("ip")
        community = data.get("community", "public")
        
        if not ip:
            return jsonify({"error": "IP address required"}), 400
        
        # Test SNMP connectivity
        result = subprocess.run(
            ["snmpget", "-v2c", "-c", community, "-t", "2", "-r", "1",
             "-Oqv", f"{ip}:161", ".1.3.6.1.2.1.1.1.0"],
            capture_output=True, text=True, timeout=5
        )
        
        if result.returncode != 0:
            return jsonify({
                "success": False,
                "ip": ip,
                "error": "No SNMP response",
                "details": result.stderr.strip()
            })
        
        # Get device name
        name_result = subprocess.run(
            ["snmpget", "-v2c", "-c", community, "-t", "2", "-r", "1",
             "-Oqv", f"{ip}:161", ".1.3.6.1.2.1.1.5.0"],
            capture_output=True, text=True, timeout=5
        )
        
        return jsonify({
            "success": True,
            "ip": ip,
            "description": result.stdout.strip()[:100],
            "name": name_result.stdout.strip() if name_result.returncode == 0 else "Unknown",
            "snmp_version": "2c"
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
            "is_active": True,
            "mac_address": data.get("mac_address"),
            "hostname": data.get("hostname"),
            "remote_host": data.get("remote_host"),
            "web_admin_port": data.get("web_admin_port"),
            "web_admin_user": data.get("web_admin_user"),
            "web_admin_pass": data.get("web_admin_pass"),
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
        
        # Try the factory default IP first
        result = subprocess.run(
            ["snmpget", "-v2c", "-c", community, "-t", "2", "-r", "1",
             "-Oqv", f"{factory_ip}:161", ".1.3.6.1.2.1.1.1.0"],
            capture_output=True, text=True, timeout=5
        )
        
        if result.returncode == 0 and result.stdout.strip():
            name_result = subprocess.run(
                ["snmpget", "-v2c", "-c", community, "-t", "2", "-r", "1",
                 "-Oqv", f"{factory_ip}:161", ".1.3.6.1.2.1.1.5.0"],
                capture_output=True, text=True, timeout=5
            )
            return jsonify({
                "success": True,
                "found": True,
                "device": {
                    "ip": factory_ip,
                    "description": result.stdout.strip()[:200],
                    "name": name_result.stdout.strip() if name_result.returncode == 0 else "Unknown",
                    "snmp_version": "2c",
                    "community": community
                }
            })
        
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
            try:
                r = subprocess.run(
                    ["snmpget", "-v2c", "-c", community, "-t", "1", "-r", "0",
                     "-Oqv", f"{ip_str}:161", ".1.3.6.1.2.1.1.1.0"],
                    capture_output=True, text=True, timeout=3
                )
                if r.returncode == 0 and r.stdout.strip():
                    return {"ip": ip_str, "description": r.stdout.strip()[:200], "name": "Unknown", "snmp_version": "2c", "community": community}
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
    
    app.run(host="0.0.0.0", port=port, debug=True)
