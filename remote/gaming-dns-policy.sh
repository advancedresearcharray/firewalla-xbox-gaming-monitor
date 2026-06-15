#!/usr/bin/env bash
# Redirect DNS queries to custom resolvers for Xbox ONLY.
# Does NOT change Firewalla global DNS, DHCP option 6, or dnsmasq for other devices.
set -euo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
CONF="${TOOLS_DIR}/gaming.conf"
STATE="${TOOLS_DIR}/.dns-policy.state"
CHAIN="XBOX_DNS_REDIRECT"

if [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi
# shellcheck disable=SC1091
source "${TOOLS_DIR}/xbox-scope.sh"

log() { printf '[dns-policy] %s\n' "$*"; }

need_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "Run with sudo"; exit 1; }; }

teardown() {
  local src
  while IFS= read -r src; do
    [[ -z "$src" ]] && continue
    iptables -t nat -D PREROUTING -i "${LAN_IF:-br2}" -s "$src" -p udp --dport 53 -j "$CHAIN" 2>/dev/null || true
    iptables -t nat -D PREROUTING -i "${LAN_IF:-br2}" -s "$src" -p tcp --dport 53 -j "$CHAIN" 2>/dev/null || true
    ip6tables -t nat -D PREROUTING -i "${LAN_IF:-br2}" -s "$src" -p udp --dport 53 -j "${CHAIN}_6" 2>/dev/null || true
    ip6tables -t nat -D PREROUTING -i "${LAN_IF:-br2}" -s "$src" -p tcp --dport 53 -j "${CHAIN}_6" 2>/dev/null || true
  done < <(xbox_sources 2>/dev/null || true)

  iptables -t nat -F "$CHAIN" 2>/dev/null || true
  iptables -t nat -X "$CHAIN" 2>/dev/null || true
  ip6tables -t nat -F "${CHAIN}_6" 2>/dev/null || true
  ip6tables -t nat -X "${CHAIN}_6" 2>/dev/null || true
  rm -f "$STATE"
}

cmd_status() {
  [[ -f "$STATE" ]] && cat "$STATE" || echo "enabled=inactive"
}

cmd_off() {
  need_root
  teardown
  log "OFF — Xbox uses network default DNS (no redirect rules)"
}

setup_nat_chain() {
  local cmd="$1" chain="$2" resolver="$3"
  "$cmd" -t nat -N "$chain" 2>/dev/null || true
  "$cmd" -t nat -F "$chain" 2>/dev/null || true
  if [[ "$resolver" == *:* ]]; then
    "$cmd" -t nat -A "$chain" -p udp --dport 53 -j DNAT --to-destination "[$resolver]:53"
    "$cmd" -t nat -A "$chain" -p tcp --dport 53 -j DNAT --to-destination "[$resolver]:53"
  else
    "$cmd" -t nat -A "$chain" -p udp --dport 53 -j DNAT --to-destination "${resolver}:53"
    "$cmd" -t nat -A "$chain" -p tcp --dport 53 -j DNAT --to-destination "${resolver}:53"
  fi
}

resolver_for_stack() {
  local resolver="$1"
  local stack="$2"
  if [[ "$stack" == "ipv4" ]]; then
    [[ "$resolver" != *:* ]] || return 1
    echo "$resolver"
    return
  fi
  if [[ "$resolver" == *:* ]]; then
    echo "$resolver"
    return
  fi
  case "$resolver" in
    1.1.1.1) echo "2606:4700:4700::1111" ;;
    1.0.0.1) echo "2606:4700:4700::1001" ;;
    8.8.8.8) echo "2001:4860:4860::8888" ;;
    8.8.4.4) echo "2001:4860:4860::8844" ;;
    9.9.9.9) echo "2620:fe::fe" ;;
    149.112.112.112) echo "2620:fe::9" ;;
    *) return 1 ;;
  esac
}

cmd_on() {
  need_root
  local primary="${1:-}"
  local secondary="${2:-}"
  require_xbox_ip
  if [[ -z "$primary" ]]; then
    echo "Usage: $0 on PRIMARY_DNS [SECONDARY_DNS]" >&2
    exit 2
  fi

  teardown

  setup_nat_chain iptables "$CHAIN" "$primary"
  if [[ -n "$secondary" ]]; then
    setup_nat_chain iptables "${CHAIN}_2" "$secondary"
  fi

  local src resolver_v6
  while IFS= read -r src; do
    [[ -z "$src" ]] && continue
    [[ "$src" == fe80:* ]] && continue
    if [[ "$src" == *:* ]]; then
      resolver_v6="$(resolver_for_stack "$primary" ipv6)" || continue
      setup_nat_chain ip6tables "${CHAIN}_6" "$resolver_v6"
      if ! ip6tables -t nat -C PREROUTING -i "${LAN_IF:-br2}" -s "$src" -p udp --dport 53 -j "${CHAIN}_6" 2>/dev/null; then
        ip6tables -t nat -I PREROUTING 1 -i "${LAN_IF:-br2}" -s "$src" -p udp --dport 53 -j "${CHAIN}_6"
        ip6tables -t nat -I PREROUTING 1 -i "${LAN_IF:-br2}" -s "$src" -p tcp --dport 53 -j "${CHAIN}_6"
      fi
    else
      if ! iptables -t nat -C PREROUTING -i "${LAN_IF:-br2}" -s "$src" -p udp --dport 53 -j "$CHAIN" 2>/dev/null; then
        iptables -t nat -I PREROUTING 1 -i "${LAN_IF:-br2}" -s "$src" -p udp --dport 53 -j "$CHAIN"
        iptables -t nat -I PREROUTING 1 -i "${LAN_IF:-br2}" -s "$src" -p tcp --dport 53 -j "$CHAIN"
      fi
    fi
  done < <(xbox_sources)

  {
    echo "enabled=active"
    echo "scope=xbox-only"
    echo "primary=${primary}"
    echo "secondary=${secondary}"
    echo "xbox_ip=${XBOX_IP}"
    echo "lan_if=${LAN_IF:-br2}"
    echo "updated=$(date -Is)"
  } >"$STATE"
  log "ON — DNS redirect for Xbox ${XBOX_IP} only → ${primary}${secondary:+ / $secondary} (other devices unchanged)"
}

case "${1:-status}" in
  status) cmd_status ;;
  off) cmd_off ;;
  on) shift; cmd_on "${1:-}" "${2:-}" ;;
  *) echo "Usage: $0 {status|off|on PRIMARY [SECONDARY]}"; exit 2 ;;
esac
