#!/usr/bin/env python3
import subprocess
import time

def try_snmp_set(ip, port, outlet, command_format):
    """Try an SNMP SET with different formats"""
    oid_formats = [
        f".1.3.6.1.4.1.23273.3.1.1.6.{outlet}.0",  # Current format
        f".1.3.6.1.4.1.23273.2.1.1.{outlet}.0",    # Alternative format
        f".1.3.6.1.4.1.23273.3.1.1.4.{outlet}.0",  # Status OID
        f".1.3.6.1.4.1.23273.3.1.1.7.{outlet}.0",  # Another branch
    ]
    
    value_formats = [
        ("s", "OFF"),   # String uppercase
        ("s", "off"),   # String lowercase
        ("s", "2"),     # String number
        ("i", "2"),     # Integer
        ("i", "0"),     # Integer zero
    ]
    
    for oid in oid_formats:
        for val_type, value in value_formats:
            cmd = [
                "snmpset",
                "-v2c",
                "-c", "private",
                "-t", "5",
                "-r", "2",
                ip + ":" + str(port),
                oid,
                val_type,
                value
            ]
            
            print(f"\nTrying: {' '.join(cmd)}")
            try:
                result = subprocess.run(cmd, capture_output=True, text=True)
                print(f"Exit code: {result.returncode}")
                if result.stdout:
                    print(f"stdout: {result.stdout.strip()}")
                if result.stderr:
                    print(f"stderr: {result.stderr.strip()}")
            except Exception as e:
                print(f"Error: {str(e)}")
            
            # Check status after each attempt
            check_cmd = [
                "snmpget",
                "-v2c",
                "-c", "private",
                "-t", "5",
                "-r", "2",
                ip + ":" + str(port),
                f".1.3.6.1.4.1.23273.3.1.1.6.{outlet}.0"
            ]
            try:
                check_result = subprocess.run(check_cmd, capture_output=True, text=True)
                if check_result.stdout:
                    print(f"Current status: {check_result.stdout.strip()}")
            except Exception as e:
                print(f"Error checking status: {str(e)}")
            
            time.sleep(1)  # Wait between attempts

if __name__ == "__main__":
    IP = "218.16.58.43"
    PORT = 1663
    OUTLET = 1
    
    print("Starting SNMP SET test sequence...")
    try_snmp_set(IP, PORT, OUTLET, "off")
