#!/bin/bash

IP="218.16.58.43"
PORT="1663"

# Function to test one outlet
test_outlet() {
    local outlet=$1
    echo "Testing outlet $outlet..."
    
    # Get all metrics for this outlet
    result=$(snmpget -v2c -c private -t 3 -r 1 $IP:$PORT \
        .1.3.6.1.4.1.23273.3.1.1.6.$outlet.0 \
        .1.3.6.1.4.1.23273.3.1.1.7.$outlet.0 \
        .1.3.6.1.4.1.23273.3.1.1.2.$outlet.0 \
        .1.3.6.1.4.1.23273.3.1.1.10.$outlet.0 \
        .1.3.6.1.4.1.23273.3.1.1.5.$outlet.0 2>&1)
    
    # Check if command succeeded
    if [ $? -eq 0 ]; then
        echo "$result" | while IFS= read -r line; do
            if [[ $line == *"STRING:"* ]]; then
                value=${line#*STRING: }
                echo "  $value"
            fi
        done
    else
        echo "  Error: $result"
    fi
    echo "---"
}

# Test all 24 outlets
echo "=== Testing all master outlets ==="
echo "Time: $(date)"
echo "================================"

for outlet in $(seq 1 24); do
    test_outlet $outlet
done

echo "Test complete!"
