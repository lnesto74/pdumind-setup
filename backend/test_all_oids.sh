#!/bin/bash

IP="218.16.58.43"
PORT="1663"

echo "Testing Status OIDs..."
snmpget -v2c -c private -t 3 -r 1 $IP:$PORT \
  .1.3.6.1.4.1.23273.3.1.1.6.1.0 \
  .1.3.6.1.4.1.23273.3.1.1.6.2.0

echo -e "\nTesting Current OIDs..."
snmpget -v2c -c private -t 3 -r 1 $IP:$PORT \
  .1.3.6.1.4.1.23273.3.1.1.7.1.0 \
  .1.3.6.1.4.1.23273.3.1.1.7.2.0

echo -e "\nTesting Energy OIDs..."
snmpget -v2c -c private -t 3 -r 1 $IP:$PORT \
  .1.3.6.1.4.1.23273.3.1.1.8.1.0 \
  .1.3.6.1.4.1.23273.3.1.1.8.2.0

echo -e "\nTesting Name OIDs..."
snmpget -v2c -c private -t 3 -r 1 $IP:$PORT \
  .1.3.6.1.4.1.23273.3.1.1.5.1.0 \
  .1.3.6.1.4.1.23273.3.1.1.5.2.0
