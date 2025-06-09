#!/bin/bash

IP="218.16.58.43"
PORT="1663"

echo "Testing alternative Current OIDs for outlet 1..."
# Try different common current measurement OIDs
snmpget -v2c -c private -t 3 -r 1 $IP:$PORT \
  .1.3.6.1.4.1.23273.3.1.1.2.1.0 \
  .1.3.6.1.4.1.23273.3.1.1.3.1.0 \
  .1.3.6.1.4.1.23273.3.1.1.4.1.0

echo -e "\nTesting alternative Energy OIDs for outlet 1..."
# Try different common energy measurement OIDs
snmpget -v2c -c private -t 3 -r 1 $IP:$PORT \
  .1.3.6.1.4.1.23273.3.1.1.9.1.0 \
  .1.3.6.1.4.1.23273.3.1.1.10.1.0 \
  .1.3.6.1.4.1.23273.3.1.1.11.1.0
