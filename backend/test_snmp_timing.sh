#!/bin/bash

IP="218.16.58.43"
PORT="1663"
BASE_OID=".1.3.6.1.4.1.23273.3.1.1.6"

# Test different timeout and batch size combinations
for timeout in 3 5 8 10; do
  for batch_size in 4 8 12 24; do
    echo "Testing with timeout ${timeout}s and batch size ${batch_size}..."
    
    # Build OID list for this batch size
    oids=""
    for i in $(seq 1 $batch_size); do
      oids="$oids $BASE_OID.$i.0"
    done
    
    echo "snmpget -v2c -c private -t $timeout -r 1 $IP:$PORT $oids"
    time snmpget -v2c -c private -t $timeout -r 1 $IP:$PORT $oids
    echo "---"
    sleep 2  # Give PDU a break between tests
  done
done
