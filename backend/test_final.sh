#!/bin/bash

IP="218.16.58.43"
PORT="1663"

# Test all outlets with just Status, Current, Energy, and Name
for outlet in {1..24}; do
    echo "=== Outlet $outlet ==="
    # Test in two batches to avoid tooBig errors
    
    # Batch 1: Status and Current
    snmpget -v2c -c private -t 3 -r 1 $IP:$PORT \
        .1.3.6.1.4.1.23273.3.1.1.6.$outlet.0 \
        .1.3.6.1.4.1.23273.3.1.1.7.$outlet.0
    
    # Batch 2: Energy and Name
    snmpget -v2c -c private -t 3 -r 1 $IP:$PORT \
        .1.3.6.1.4.1.23273.3.1.1.10.$outlet.0 \
        .1.3.6.1.4.1.23273.3.1.1.5.$outlet.0
    
    echo "---"
done
