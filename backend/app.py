import os
from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import time
from typing import List, Tuple, Dict, Any
from threading import Thread, Lock

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


def snmp_get(ip: str, port: int, oid: str) -> str | None:
    """Fetch a single OID via SNMP using command-line snmpget."""
    import subprocess
    import time

    try:
        if not oid[-1].isdigit():
            oid = f"{oid}.0"

        start_time = time.time()

        # Try both SNMP v1 and v2c with longer timeouts
        for version in ["1", "2c"]:
            for test_port in [port, 161]:  # Try specified port and standard port
                cmd = [
                    "snmpget",
                    f"-v{version}",
                    "-c", "public",
                    "-t", "15",    # 15 second timeout for high latency
                    "-r", "3",     # 3 retries for packet loss
                    "-OQv",        # Remove quotes from output
                    "-Oe",         # Print enums numerically
                    "-Pe",         # Print errors
                    f"{ip}:{test_port}",
                    oid
                ]
                
                try:
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
                    
                    if result.returncode == 0 and result.stdout.strip():
                        value = result.stdout.strip()
                        try:
                            return str(float(value))  # Try to clean up numbers
                        except ValueError:
                            return value  # Return as-is if not a number
                except:
                    continue  # Try next port/version combination
        
        # If we get here, all attempts failed
        print(f"All SNMP attempts failed for {oid}")
        return "0"

        return "0"  # Return 0 if no value

    except subprocess.TimeoutExpired:
        return "0"  # Return 0 for timeouts
    except Exception as e:
        print(f"SNMP Exception: {str(e)}")
        return "0"  # Return 0 for other errors

    return "0"  # Return 0 as final fallback


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

POLL_LOCK: Lock = Lock()
POLL_RESULTS: Dict[str, Dict[str, Any]] = {}
POLL_ERRORS: Dict[str, Dict[str, Any]] = {}
POLL_THREAD: Thread | None = None
POLL_STOP: bool = False

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


import time

@app.route("/api/data", methods=["GET"])
def get_pdu_data():
    try:
        cfg = load_config()
        if not cfg:
            return jsonify({"error": "No PDU configuration present"}), 400

        ip = cfg["ip"]
        port = int(cfg.get("port", 161))

        # Standard system OIDs
        system_oids = [
            ("SystemDescription", ".1.3.6.1.2.1.1.1"),
            ("SystemObjectID", ".1.3.6.1.2.1.1.2"),
            ("SystemUptime", ".1.3.6.1.2.1.1.3"),
            ("SystemContact", ".1.3.6.1.2.1.1.4"),
            ("SystemName", ".1.3.6.1.2.1.1.5"),
            ("SystemLocation", ".1.3.6.1.2.1.1.6"),
            ("SystemServices", ".1.3.6.1.2.1.1.7")
        ]
        
        # 1️⃣ Define the minimal set of ~100 OIDs required by the
        #    React dashboard (2 device info + 15 phase metrics +
        #    8 environmental sensors + 72 output metrics)
        
        # Device Information (2 OIDs)
        device_oids = [
            ("DeviceType", ".1.3.6.1.4.1.23273.3.1.1.1.2"),
            ("DeviceMac", ".1.3.6.1.4.1.23273.3.1.1.1.4")
        ]

        # Phase Metrics
        phase_oids = [
            # Phase 1
            ("VoltageP1", ".1.3.6.1.4.1.23273.3.1.1.2.1"),
            ("CurrentP1", ".1.3.6.1.4.1.23273.3.1.1.2.2"),
            ("PowerP1", ".1.3.6.1.4.1.23273.3.1.1.2.3"),
            ("PFP1", ".1.3.6.1.4.1.23273.3.1.1.2.4"),
            ("EnergyP1", ".1.3.6.1.4.1.23273.3.1.1.2.5"),
            # Phase 2
            ("VoltageP2", ".1.3.6.1.4.1.23273.3.1.1.3.1"),
            ("CurrentP2", ".1.3.6.1.4.1.23273.3.1.1.3.2"),
            ("PowerP2", ".1.3.6.1.4.1.23273.3.1.1.3.3"),
            ("PFP2", ".1.3.6.1.4.1.23273.3.1.1.3.4"),
            ("EnergyP2", ".1.3.6.1.4.1.23273.3.1.1.3.5"),
            # Phase 3
            ("VoltageP3", ".1.3.6.1.4.1.23273.3.1.1.4.1"),
            ("CurrentP3", ".1.3.6.1.4.1.23273.3.1.1.4.2"),
            ("PowerP3", ".1.3.6.1.4.1.23273.3.1.1.4.3"),
            ("PFP3", ".1.3.6.1.4.1.23273.3.1.1.4.4"),
            ("EnergyP3", ".1.3.6.1.4.1.23273.3.1.1.4.5")
        ]

        # Environmental Sensors
        sensor_oids_dashboard = [
            ("Temperature1", ".1.3.6.1.4.1.23273.3.1.1.11.1"),
            ("Temperature2", ".1.3.6.1.4.1.23273.3.1.1.11.2"),
            ("Humidity1", ".1.3.6.1.4.1.23273.3.1.1.11.5"),
            ("Humidity2", ".1.3.6.1.4.1.23273.3.1.1.11.6"),
            ("Door1", ".1.3.6.1.4.1.23273.3.1.1.11.9"),
            ("Door2", ".1.3.6.1.4.1.23273.3.1.1.11.10"),
            ("Smoke", ".1.3.6.1.4.1.23273.3.1.1.11.11"),
            ("Water", ".1.3.6.1.4.1.23273.3.1.1.11.12"),
        ]

        # Output metrics required by OutputGrid (Name, Status, Current, Energy)
        output_oids_dashboard = []
        for i in range(1, 25):
            output_oids_dashboard.extend([
                (f"Output{i}Name",   f".1.3.6.1.4.1.23273.3.1.1.5.{i}"),
                (f"Output{i}Status", f".1.3.6.1.4.1.23273.3.1.1.6.{i}"),
                (f"Output{i}Current",f".1.3.6.1.4.1.23273.3.1.1.7.{i}"),
                (f"Output{i}Energy", f".1.3.6.1.4.1.23273.3.1.1.10.{i}"),
            ])

        default_oids = (
            device_oids + phase_oids + sensor_oids_dashboard + output_oids_dashboard
        )

        symbols: List[Tuple[str, str]] = default_oids.copy()

        # Merge extra OIDs from uploaded MIB (if any)
        if cfg.get("oids"):
            symbols.extend(cfg["oids"])

        # Deduplicate by name keeping the *first* occurrence to avoid excessive
        # growth when users re-upload the same MIB multiple times.
        seen: set[str] = set()
        dedup: List[Tuple[str, str]] = []
        for name, oid in symbols:
            if name not in seen:
                dedup.append((name, oid))
                seen.add(name)

        symbols = dedup

        # Store symbols in config (used by background poller)
        cfg["symbols"] = symbols
        save_config(cfg)

        # ------------------------------------------------------------------
        # Start background poller if not already running so that subsequent
        # /api/data requests return immediately with cached values.
        # ------------------------------------------------------------------

        global POLL_THREAD, POLL_STOP

        def poller():
            while not POLL_STOP:
                for name, oid in symbols:
                    # Ensure OID ends with .0
                    if not oid.endswith(".0"):
                        oid = f"{oid}.0"
                    
                    print(f"Polling {name} ({oid})...")
                    value = snmp_get(ip, port, oid)
                    print(f"Got value: {value}")
                    
                    with POLL_LOCK:
                        if value and not value.startswith("Error:"):
                            POLL_RESULTS[name] = {"name": name, "oid": oid, "value": value}
                            print(f"Success: {name} = {value}")
                        else:
                            POLL_ERRORS[name] = {"name": name, "oid": oid, "error": value or "No response"}
                            print(f"Error: {name} - {value or 'No response'}")
                    time.sleep(0.1)  # small delay keeps CPU usage low

        if POLL_THREAD is None or not POLL_THREAD.is_alive():
            POLL_STOP = False
            POLL_THREAD = Thread(target=poller, daemon=True)
            POLL_THREAD.start()

        # ------------------------------------------------------------------
        # Return current snapshot immediately – frontend fills placeholders
        # and updates every 5s (as currently implemented).
        # ------------------------------------------------------------------

        with POLL_LOCK:
            results_snapshot = list(POLL_RESULTS.values())
            errors_snapshot = list(POLL_ERRORS.values())

        return jsonify({
            "ip": ip,
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
                    "-t", "10",  # timeout in seconds
                    "-r", "2",   # number of retries
                    f"{ip}:{port}",
                    oid
                ]
                result = {
                    "version": f"v{version}",
                    "community": community,
                    "success": False,
                    "error": None,
                    "value": None
                }

                process = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
                
                if process.returncode != 0:
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

    return jsonify(results)


if __name__ == "__main__":
    # For local dev only (in Docker this will be managed via CMD)
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
