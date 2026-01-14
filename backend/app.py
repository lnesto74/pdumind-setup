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
from pm_agent.agent import answer as pm_answer

# Import new persistence layer
from db import init_db as init_persistence_db, HallRepo, RackRepo, PDURepo, TelemetryRepo, EventRepo
from db.persistence import save_hall_state, store_poll_snapshot

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
        except Exception as e:
            print(f"[DEBUG] Error parsing JSON: {str(e)}")
            return jsonify({"error": "Invalid JSON body"}), 400
        
        if not state or state not in ["on", "off"]:
            print(f"[DEBUG] Invalid state: {state}")
            return jsonify({"error": "Invalid state, must be 'on' or 'off'"}), 400
            
        cfg = load_config()
        print(f"[DEBUG] Loaded config: {cfg}")
        
        if not cfg or "ip" not in cfg:
            print(f"[DEBUG] Invalid config: {cfg}")
            return jsonify({"error": "No PDU configuration found"}), 400
            
        print(f"[DEBUG] Calling set_outlet_status_via_http with ip={cfg['ip']}, outlet={outlet}, state={state}")
        success, error = set_outlet_status_via_http(
            cfg["ip"],
            outlet,
            state
        )
        
        print(f"[DEBUG] Control result: success={success}, error={error}")
        if success:
            # Trigger priority polling for this outlet after successful control
            try:
                poll_outlet_status_priority(cfg["ip"], outlet)
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


if __name__ == "__main__":
    # For local dev only (in Docker this will be managed via CMD)
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
