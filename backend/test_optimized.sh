#!/bin/bash

IP="218.16.58.43"
PORT="1663"

# Test a single metric for an outlet
test_single_metric() {
    local outlet=$1
    local metric_oid=$2
    local metric_name=$3
    local timeout=$4
    
    echo "Testing $metric_name for outlet $outlet (timeout ${timeout}s)..."
    result=$(snmpget -v2c -c private -t $timeout -r 1 $IP:$PORT .1.3.6.1.4.1.23273.3.1.1.$metric_oid.$outlet.0 2>&1)
    if [ $? -eq 0 ]; then
        if [[ $result == *"STRING:"* ]]; then
            value=${result#*STRING: }
            echo "  $value"
        fi
    else
        echo "  Error: $result"
    fi
}

# Test problematic outlets (6-9, 13, 16, 18) with individual metrics
echo "=== Testing problematic outlets individually ==="
echo "Time: $(date)"
echo "================================"

# Array of problematic outlets
problem_outlets=(6 7 8 9 13 16 18)

# Test each problematic outlet
for outlet in "${problem_outlets[@]}"; do
    echo "=== Outlet $outlet ==="
    # Test each metric with increased timeout
    test_single_metric $outlet "6" "Status" 5
    test_single_metric $outlet "7" "Current" 5
    test_single_metric $outlet "2" "Voltage" 5
    test_single_metric $outlet "10" "Energy" 5
    test_single_metric $outlet "5" "Name" 5
    echo "---"
done

# Now test working outlets in small batches
echo -e "\n=== Testing working outlets in batches ==="

# Array of working outlets
working_outlets=(1 2 3 4 5 10 11 12 14 15 17 19 20 21 22 23 24)

# Test working outlets in batches of 4
for outlet in "${working_outlets[@]}"; do
    echo "=== Outlet $outlet ==="
    # Get status and current in one batch
    result1=$(snmpget -v2c -c private -t 3 -r 1 $IP:$PORT \
        .1.3.6.1.4.1.23273.3.1.1.6.$outlet.0 \
        .1.3.6.1.4.1.23273.3.1.1.7.$outlet.0 2>&1)
    
    # Get voltage and energy in another batch
    result2=$(snmpget -v2c -c private -t 3 -r 1 $IP:$PORT \
        .1.3.6.1.4.1.23273.3.1.1.2.$outlet.0 \
        .1.3.6.1.4.1.23273.3.1.1.10.$outlet.0 2>&1)
    
    # Get name separately
    result3=$(snmpget -v2c -c private -t 3 -r 1 $IP:$PORT \
        .1.3.6.1.4.1.23273.3.1.1.5.$outlet.0 2>&1)
    
    # Print results
    echo "$result1" "$result2" "$result3" | while IFS= read -r line; do
        if [[ $line == *"STRING:"* ]]; then
            value=${line#*STRING: }
            echo "  $value"
        fi
    done
    echo "---"
done

echo "Test complete!"
