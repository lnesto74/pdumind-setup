#!/usr/bin/env bash
# Agoda-2 PDU SNMP reachability report.
#
# Run this on a host that is already on the customer VPN (the same path the
# monitoring system uses, if possible). It does not log into the PDUs and it
# does not change anything. Secrets are read from the environment and are
# never written into the report.
#
#   export SNMP_AUTH='the SHA passphrase'
#   export SNMP_PRIV='the AES passphrase'
#   bash agoda-snmp-reachability.sh
#
# Optional:
#   SNMP_USER   default pduuser
#   SNMP_AUTH_PROTO  default SHA
#   SNMP_PRIV_PROTO  default AES
#
# Requires: ping, and net-snmp's snmpget (package net-snmp-utils / net-snmp).
# Writes: agoda-snmp-report-<timestamp>.txt in the current directory.

set -u

SNMP_USER="${SNMP_USER:-pduuser}"
SNMP_AUTH_PROTO="${SNMP_AUTH_PROTO:-SHA}"
SNMP_PRIV_PROTO="${SNMP_PRIV_PROTO:-AES}"
TIMEOUT="${SNMP_TIMEOUT:-2}"

# name ip
PDUS=(
  "SIN1-PDU-2NBM04-A 10.106.76.225"
  "SIN1-PDU-2NBM04-B 10.106.77.225"
  "SIN1-PDU-2NBM05-A 10.106.76.226"
  "SIN1-PDU-2NBM05-B 10.106.77.226"
  "SIN1-PDU-2NBM06-A 10.106.76.227"
  "SIN1-PDU-2NBM06-B 10.106.77.227"
  "SIN1-PDU-2NBM07-A 10.106.76.228"
  "SIN1-PDU-2NBM07-B 10.106.77.228"
  "SIN1-PDU-2NBM08-A 10.106.76.229"
  "SIN1-PDU-2NBM08-B 10.106.77.229"
  "SIN1-PDU-2NBM09-A 10.106.76.230"
  "SIN1-PDU-2NBM09-B 10.106.77.230"
  "SIN1-PDU-2NBM10-A 10.106.76.231"
  "SIN1-PDU-2NBM10-B 10.106.77.231"
)

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${1:-agoda-snmp-report-${STAMP}.txt}"
OID_DESCR="1.3.6.1.2.1.1.1.0"
OID_NAME="1.3.6.1.2.1.1.5.0"

if [[ -z "${SNMP_AUTH:-}" || -z "${SNMP_PRIV:-}" ]]; then
  echo "Set SNMP_AUTH and SNMP_PRIV in the environment. They are not stored in this script." >&2
  exit 2
fi
if ! command -v snmpget >/dev/null 2>&1; then
  echo "snmpget not found. Install net-snmp-utils (Linux) or net-snmp (macOS), then run again." >&2
  exit 2
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

tcp_open() {
  local ip="$1" port="$2"
  if command -v nc >/dev/null 2>&1; then
    if nc -h 2>&1 | grep -q -- '-G '; then
      nc -z -G "$TIMEOUT" "$ip" "$port" >/dev/null 2>&1
    else
      nc -z -w "$TIMEOUT" "$ip" "$port" >/dev/null 2>&1
    fi
    return $?
  fi
  timeout "$TIMEOUT" bash -c "echo >/dev/tcp/${ip}/${port}" >/dev/null 2>&1
}

ping_ok() {
  local ip="$1"
  if ping -c 1 -W "$TIMEOUT" "$ip" >/dev/null 2>&1; then
    return 0
  fi
  # macOS uses -W in milliseconds
  ping -c 1 -W $((TIMEOUT * 1000)) "$ip" >/dev/null 2>&1
}

{
  echo "Agoda-2 PDU SNMP reachability"
  echo "Generated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')  local: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "Runner: $(hostname 2>/dev/null || echo unknown)  user: $(id -un 2>/dev/null || echo unknown)"
  echo "SNMP: v3 authPriv user=${SNMP_USER} auth=${SNMP_AUTH_PROTO} priv=${SNMP_PRIV_PROTO}  (keys not recorded)"
  echo
  echo "---- path from this host ----"
  if command -v ip >/dev/null 2>&1; then
    echo "source v4 addresses:"
    ip -4 addr show 2>/dev/null | awk '/inet /{print "  "$2" dev "$NF}'
    echo "route to 10.106.76.225:"
    ip route get 10.106.76.225 2>&1 | sed 's/^/  /'
    echo "route to 10.106.77.225:"
    ip route get 10.106.77.225 2>&1 | sed 's/^/  /'
  else
    echo "source v4 addresses:"
    ifconfig 2>/dev/null | awk '/inet /{print "  "$2}'
    echo "route to 10.106.76.225:"
    route -n get 10.106.76.225 2>&1 | awk '/gateway:|interface:/{print "  "$0}'
    echo "route to 10.106.77.225:"
    route -n get 10.106.77.225 2>&1 | awk '/gateway:|interface:/{print "  "$0}'
  fi
  echo
  echo "These PDUs were commissioned SNMPv3 only (v1 off, v2c off), auth SHA, privacy AES."
  echo "A monitoring system using v2c or a community string will stay red even when v3 answers."
  echo "HTTPS on the web console does not mean SNMP is up: SNMP is UDP/161, separate from TCP/443."
  echo
  printf "%-22s %-15s %-5s %-5s %-5s %-5s %-18s %s\n" \
    "NAME" "IP" "PING" "TCP80" "TCP443" "SNMP" "CAUSE" "DETAIL"
  echo "------------------------------------------------------------------------------------------------------------------------------"
} | tee "$OUT"

ok_n=0
fail_n=0
down_n=0
auth_n=0
filter_n=0
web_only_n=0

for row in "${PDUS[@]}"; do
  name="${row%% *}"
  ip="${row##* }"
  ping="no"
  p80="no"
  p443="no"
  snmp="no"
  detail=""
  cause=""

  if ping_ok "$ip"; then ping="yes"; fi
  if tcp_open "$ip" 80; then p80="yes"; fi
  if tcp_open "$ip" 443; then p443="yes"; fi

  snmp_out="$(snmpget -v3 -l authPriv -u "$SNMP_USER" \
    -a "$SNMP_AUTH_PROTO" -A "$SNMP_AUTH" \
    -x "$SNMP_PRIV_PROTO" -X "$SNMP_PRIV" \
    -t "$TIMEOUT" -r 0 -Oqv "$ip:161" "$OID_NAME" 2>"$tmp" || true)"
  err="$(cat "$tmp")"
  if [[ -n "${snmp_out// /}" && -z "$err" ]]; then
    snmp="yes"
    descr="$(snmpget -v3 -l authPriv -u "$SNMP_USER" \
      -a "$SNMP_AUTH_PROTO" -A "$SNMP_AUTH" \
      -x "$SNMP_PRIV_PROTO" -X "$SNMP_PRIV" \
      -t "$TIMEOUT" -r 0 -Oqv "$ip:161" "$OID_DESCR" 2>/dev/null || true)"
    detail="sysName=${snmp_out} sysDescr=${descr}"
    detail="${detail//$'\n'/ }"
    cause="snmp-ok"
    ok_n=$((ok_n + 1))
  else
    one_line="$(printf '%s' "$err" | tr '\n' ' ' | sed 's/  */ /g')"
    case "$one_line" in
      *[Aa]uthentication*|*[Uu]nknown\ user*|*[Ww]rong\ digest*)
        cause="auth-reject"
        auth_n=$((auth_n + 1))
        ;;
      *[Tt]imeout*|*[Nn]o\ [Rr]esponse*|"")
        if [[ "$ping" == "no" && "$p80" == "no" && "$p443" == "no" ]]; then
          cause="no-path"
          down_n=$((down_n + 1))
        elif [[ "$p80" == "yes" || "$p443" == "yes" || "$ping" == "yes" ]]; then
          cause="snmp-silent"
          web_only_n=$((web_only_n + 1))
        else
          cause="snmp-silent"
          filter_n=$((filter_n + 1))
        fi
        ;;
      *)
        cause="snmp-error"
        fail_n=$((fail_n + 1))
        ;;
    esac
    detail="${one_line:0:160}"
    [[ -z "$detail" ]] && detail="no snmp response"
  fi

  printf "%-22s %-15s %-5s %-5s %-5s %-5s %-18s %s\n" \
    "$name" "$ip" "$ping" "$p80" "$p443" "$snmp" "$cause" "$detail" | tee -a "$OUT"
done

{
  echo
  echo "---- how to read the cause column ----"
  echo "snmp-ok       This host got sysName over SNMPv3. If the NMS is still red, the NMS"
  echo "              is using another version, user, or passphrase, or it polls from another source."
  echo "auth-reject   UDP/161 reached the PDU and the agent refused the user or the keys."
  echo "snmp-silent   The PDU answers ping and/or the web ports, but SNMPv3 got no UDP reply."
  echo "              Usual causes: SNMP not enabled after the last reboot, or UDP/161 filtered"
  echo "              on the switch port or a firewall between this host and that PDU."
  echo "no-path       No ping, no web, no SNMP. The address is down from here: VLAN, route,"
  echo "              switch port, cable, or the PDU is powered off. Not an SNMP password problem."
  echo "snmp-error    The agent answered with an unexpected SNMP error. See DETAIL."
  echo
  echo "---- counts ----"
  echo "snmp-ok:     $ok_n"
  echo "auth-reject: $auth_n"
  echo "snmp-silent (device still reachable): $web_only_n"
  echo "no-path:     $down_n"
  echo "other:       $fail_n"
  echo
  echo "Feed pattern: A is 10.106.76.225-.231, B is 10.106.77.225-.231."
  echo "If every failure is snmp-silent while ping or HTTPS works, the switch path is up"
  echo "and the fault is on the PDU SNMP agent or a UDP/161 filter, not a dead VLAN."
  echo "If a whole feed is no-path, that subnet's gateway or VLAN is the fault."
  echo
  echo "Report file: $OUT"
} | tee -a "$OUT"

echo
echo "Send this file back: $OUT"
