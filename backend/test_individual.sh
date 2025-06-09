#!/bin/bash

IP="218.16.58.43"
PORT="1663"

echo "Testing Current OID..."
snmpget -v2c -c private -t 3 -r 1 $IP:$PORT .1.3.6.1.4.1.23273.3.1.1.7.1.0

echo -e "\nTesting Status OID..."
snmpget -v2c -c private -t 3 -r 1 $IP:$PORT .1.3.6.1.4.1.23273.3.1.1.6.1.0

echo -e "\nTesting Energy OID..."
snmpget -v2c -c private -t 3 -r 1 $IP:$PORT .1.3.6.1.4.1.23273.3.1.1.10.1.0

echo -e "\nTesting Voltage OID..."
snmpget -v2c -c private -t 3 -r 1 $IP:$PORT .1.3.6.1.4.1.23273.3.1.1.2.1.0
