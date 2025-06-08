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
OUTLET_BASE_TIMEOUT = 3  # 3s timeout with retries for reliability
OUTLET_MAX_RETRIES = 2   # Two retries to handle occasional timeouts

# Master outlet OIDs for v1.0.1 PDU structure
# Each OID needs .{outlet_number}.0 appended for the actual SNMP query
# e.g. .1.3.6.1.4.1.23273.3.1.1.6.1.0 for outlet 1 status
OUTPUT_PREFIXES: dict[str, str] = {
    'Status': '.1.3.6.1.4.1.23273.3.1.1.6',   # Returns ON/OFF string
    'Current': '.1.3.6.1.4.1.23273.3.1.1.7',  # Returns amperage value
    'Energy': '.1.3.6.1.4.1.23273.3.1.1.10',  # Returns energy consumption
    'Name': '.1.3.6.1.4.1.23273.3.1.1.5'      # Returns outlet name
}

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
# CORS configuration
CORS(app, resources={r"/*": {"origins": "*", "methods": ["GET", "POST", "OPTIONS"]}})

@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        response = make_response()
        response.headers.add('Access-Control-Allow-Origin', '*')
        response.headers.add('Access-Control-Allow-Headers', '*')
        response.headers.add('Access-Control-Allow-Methods', '*')
        response.headers.add('Access-Control-Max-Age', '3600')
        return response

@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', '*')
    response.headers.add('Access-Control-Allow-Methods', '*')
    response.headers.add('Access-Control-Expose-Headers', '*')
    return response


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
def snmp_get_batch(ip: str, port: int, oids: list[str]) -> dict[str, str | None]:
    """Fetch a list of OIDs in a *single* snmpget process call to drastically
    reduce overhead. Returns a mapping of oid -> value (None on error).

    Notes: we rely on the positional order of returned lines to match the order
    of OIDs supplied when using `-Oqv` which omits the OID from the output. If
    output line count mismatches, remaining OIDs are treated as failures.
    """
    import subprocess, shlex

    # Build command once; use SNMP v2c for get-bulk like behaviour on multiple
    # OIDs but still simple snmpget for device compatibility.
    cmd = [
        "snmpget",
        "-v2c",
        "-c", DEFAULT_COMMUNITY,
        "-t", "2",    # shorter timeout
        "-r", "3",    # more retries
        "-Oqv",        # numerics for enums
        "-Oe",         # 
        f"{ip}:{port}",
    ] + oids

    start_time = time.time()
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=7)
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
    except subprocess.TimeoutExpired:
        print("[snmp_get_batch] Timeout after 7 s")
        return {oid: None for oid in oids}


def snmp_get_outlets(ip: str, port: int, base_oid: str, timeout: int = 10) -> dict[str, str | None]:
    import subprocess
    try:
        # Build OIDs for all 24 outlets
        oids = [f"{base_oid}.{i}.0" for i in range(1, OUTPUT_COUNT + 1)]
        
        cmd = [
            "snmpget",
            "-v2c",
            "-c", DEFAULT_COMMUNITY,
            "-t", str(timeout),
            "-r", "2",
            "-On", "-Ov", "-Oe",
            f"{ip}:{port}"
        ] + oids
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 0.5)
        if result.returncode == 0:
            mapping = {}
            lines = result.stdout.strip().splitlines()
            for oid_full, line in zip(oids, lines):
                try:
                    _, value = line.split(" = ", 1)
                    if value.startswith("STRING: "):
                        value = value[8:].strip('"')
                    if "No Such Object" not in value and "Error:" not in value and "Timeout:" not in value:
                        mapping[oid_full] = value
                    else:
                        mapping[oid_full] = None
                except (ValueError, IndexError):
                    mapping[oid_full] = None
            return mapping
        return {oid: None for oid in oids}
    except (subprocess.TimeoutExpired, Exception) as e:
        print(f"[snmp_get_outlets] Error: {str(e)}")
        return {oid: None for oid in oids}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

POLL_LOCK: Lock = Lock()
POLL_RESULTS: Dict[str, Dict[str, Any]] = {}
POLL_ERRORS: Dict[str, Dict[str, Any]] = {}
POLL_THREAD: Thread | None = None
POLL_STOP: bool = False

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

        # 1️⃣ Poll all generic symbols (non-outlet metrics) in batches
        generic_symbols = [pair for pair in symbols 
                         if not pair[0].startswith("Output") 
                         and not any(pair[0].startswith(slave) for slave in ["SlaveOne", "SlaveTwo", "SlaveThree", "SlaveFour"])]
        batches = [generic_symbols[i : i + SNMP_BATCH_SIZE] for i in range(0, len(generic_symbols), SNMP_BATCH_SIZE)]

        def fetch_batch(batch: list[tuple[str, str]]):
            names: list[str] = []
            oid_list: list[str] = []
            for n, o in batch:
                names.append(n)
                oid_list.append(o if o.endswith(".0") else f"{o}.0")
            print(f"[poller] polling generic batch of {len(batch)} OIDs ...")
            local_map = snmp_get_batch(ip, port, oid_list)
            return [
                (names[idx], oid_list[idx], local_map.get(oid_list[idx]))
                for idx in range(len(oid_list))
            ]

        with ThreadPoolExecutor(max_workers=min(MAX_SNMP_THREADS, max(1, len(batches)))) as executor:
            for fut in as_completed([executor.submit(fetch_batch, b) for b in batches]):
                for name, oid_full, value in fut.result():
                    with POLL_LOCK:
                        if value is not None and not str(value).startswith("Error:"):
                            POLL_RESULTS[name] = {"name": name, "oid": oid_full, "value": value}
                            POLL_ERRORS.pop(name, None)
                        else:
                            POLL_ERRORS[name] = {"name": name, "oid": oid_full, "error": value or "No response"}
                            POLL_RESULTS.pop(name, None)

        # 2️⃣ Poll outlet metrics in pairs for better reliability
        for outlet in range(1, OUTPUT_COUNT + 1):
            # Batch 1: Status and Current
            status_oid = f"{OUTPUT_PREFIXES['Status']}.{outlet}.0"
            current_oid = f"{OUTPUT_PREFIXES['Current']}.{outlet}.0"
            batch1_result = snmp_get_batch(ip, port, [status_oid, current_oid])
            
            # Update Status and Current
            status_name = f"Output{outlet}Status"
            current_name = f"Output{outlet}Current"
            with POLL_LOCK:
                if batch1_result.get(status_oid):
                    POLL_RESULTS[status_name] = {"name": status_name, "oid": status_oid, "value": batch1_result[status_oid]}
                    POLL_ERRORS.pop(status_name, None)
                else:
                    POLL_ERRORS[status_name] = {"name": status_name, "oid": status_oid, "error": "No response"}
                    POLL_RESULTS.pop(status_name, None)
                    
                if batch1_result.get(current_oid):
                    POLL_RESULTS[current_name] = {"name": current_name, "oid": current_oid, "value": batch1_result[current_oid]}
                    POLL_ERRORS.pop(current_name, None)
                else:
                    POLL_ERRORS[current_name] = {"name": current_name, "oid": current_oid, "error": "No response"}
                    POLL_RESULTS.pop(current_name, None)

            # Batch 2: Energy and Name
            energy_oid = f"{OUTPUT_PREFIXES['Energy']}.{outlet}.0"
            name_oid = f"{OUTPUT_PREFIXES['Name']}.{outlet}.0"
            batch2_result = snmp_get_batch(ip, port, [energy_oid, name_oid])
            
            # Update Energy and Name
            energy_name = f"Output{outlet}Energy"
            name_name = f"Output{outlet}Name"
            with POLL_LOCK:
                if batch2_result.get(energy_oid):
                    POLL_RESULTS[energy_name] = {"name": energy_name, "oid": energy_oid, "value": batch2_result[energy_oid]}
                    POLL_ERRORS.pop(energy_name, None)
                else:
                    POLL_ERRORS[energy_name] = {"name": energy_name, "oid": energy_oid, "error": "No response"}
                    POLL_RESULTS.pop(energy_name, None)
                    
                if batch2_result.get(name_oid):
                    POLL_RESULTS[name_name] = {"name": name_name, "oid": name_oid, "value": batch2_result[name_oid]}
                    POLL_ERRORS.pop(name_name, None)
                else:
                    POLL_ERRORS[name_name] = {"name": name_name, "oid": name_oid, "error": "No response"}
                    POLL_RESULTS.pop(name_name, None)

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


if __name__ == "__main__":
    # For local dev only (in Docker this will be managed via CMD)
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
