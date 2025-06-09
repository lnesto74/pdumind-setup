#!/bin/bash

IP="218.16.58.43"
PORT="1663"

# Test each metric type with snmpwalk
echo "=== Testing Status OIDs ==="
snmpwalk -v2c -c private -t 3 -r 2 -On -Ov $IP:$PORT .1.3.6.1.4.1.23273.3.1.1.6

echo -e "\n=== Testing Current OIDs ==="
snmpwalk -v2c -c private -t 3 -r 2 -On -Ov $IP:$PORT .1.3.6.1.4.1.23273.3.1.1.7

echo -e "\n=== Testing Energy OIDs ==="
snmpwalk -v2c -c private -t 3 -r 2 -On -Ov $IP:$PORT .1.3.6.1.4.1.23273.3.1.1.10

echo -e "\n=== Testing Name OIDs ==="
snmpwalk -v2c -c private -t 3 -r 2 -On -Ov $IP:$PORT .1.3.6.1.4.1.23273.3.1.1.5
