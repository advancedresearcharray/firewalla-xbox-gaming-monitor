#!/usr/bin/env bash
# Xbox inbound flood guard — rate-limits abusive per-source traffic during detected boot/flood.
# Safe to leave always-on: Xbox Live / Warzone ports whitelisted; hashlimit on everything else.
set -uo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
CONF="${TOOLS_DIR}/gaming.conf"
STATE="${TOOLS_DIR}/.flood-guard.state"
CHAIN="XBOX_FLOOD_GUARD"

if [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi
# shellcheck disable=SC1091
source "${TOOLS_DIR}/xbox-scope.sh"

log() { printf '[flood-guard] %s\n' "$*"; }

need_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "Run with sudo"; exit 1; }; }

ipt() {
  if ! iptables "$@"; then
    log "WARN iptables $*"
    return 1
  fi
}

cmd_status() {
  [[ -f "$STATE" ]] && cat "$STATE" || echo "mode=inactive"
  iptables -L "$CHAIN" -n -v 2>/dev/null | head -30 || echo "chain inactive"
}

cmd_relax() {
  need_root
  require_xbox_ip
  while iptables -D FORWARD -d "$XBOX_IP" -j "$CHAIN" 2>/dev/null; do :; done
  iptables -F "$CHAIN" 2>/dev/null || true
  iptables -X "$CHAIN" 2>/dev/null || true
  rm -f "$STATE"
  log "RELAX — flood guard removed for Xbox ${XBOX_IP}"
}

cmd_defend() {
  need_root
  require_xbox_ip
  cmd_relax

  ipt -N "$CHAIN"
  ipt -A FORWARD -d "$XBOX_IP" -j "$CHAIN"

  # Established game flows first
  ipt -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  # Xbox Live + Warzone ports (always allow — see xbox-scope.sh for full list)
  for port in "${XBOX_UDP_PORTS[@]}"; do
    ipt -A "$CHAIN" -p udp --dport "$port" -j ACCEPT
  done
  for port in "${XBOX_TCP_PORTS[@]}"; do
    ipt -A "$CHAIN" -p tcp --dport "$port" -j ACCEPT
  done

  # Per-source connection cap when connlimit module exists (optional on Firewalla nf_tables)
  if ipt -A "$CHAIN" -p udp -m connlimit --connlimit 96 --connlimit-mask 32 --connlimit-saddr -j DROP 2>/dev/null; then
    log "connlimit active (96 UDP flows per source)"
  else
    ipt -D "$CHAIN" -p udp -m connlimit --connlimit 96 --connlimit-mask 32 --connlimit-saddr -j DROP 2>/dev/null || true
    log "connlimit unavailable — hashlimit-only mode"
    ipt -A "$CHAIN" -p udp -m conntrack --ctstate NEW -m hashlimit \
      --hashlimit 400/sec --hashlimit-burst 800 \
      --hashlimit-mode srcip --hashlimit-name "xbox_udp_new_${XBOX_IP//./_}" \
      -j ACCEPT || true
  fi

  # Per-source UDP rate limit (aggressive sources on non-whitelisted ports)
  ipt -A "$CHAIN" -p udp -m hashlimit \
    --hashlimit 1200/sec --hashlimit-burst 2400 \
    --hashlimit-mode srcip --hashlimit-name "xbox_udp_${XBOX_IP//./_}" \
    -j ACCEPT || true
  ipt -A "$CHAIN" -p udp -j DROP || true

  # TCP SYN flood cap
  ipt -A "$CHAIN" -p tcp --syn -m hashlimit \
    --hashlimit 180/sec --hashlimit-burst 360 \
    --hashlimit-mode srcip --hashlimit-name "xbox_tcp_${XBOX_IP//./_}" \
    -j ACCEPT || true
  ipt -A "$CHAIN" -p tcp --syn -j DROP || true

  ipt -A "$CHAIN" -j ACCEPT || true

  {
    echo "mode=defend"
    echo "xbox_ip=${XBOX_IP}"
    echo "updated=$(date -Is)"
  } >"$STATE"
  log "DEFEND — inbound flood guard active for Xbox ${XBOX_IP}"
}

case "${1:-status}" in
  status) cmd_status ;;
  defend) cmd_defend ;;
  relax|off) cmd_relax ;;
  *) echo "Usage: $0 {status|defend|relax}"; exit 2 ;;
esac
