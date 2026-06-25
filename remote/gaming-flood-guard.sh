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

  # Established flows always pass (your active game server session)
  ipt -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  # Game ports: per-source rate limit (blocks kick floods on 3074 etc.)
  for port in "${XBOX_UDP_PORTS[@]}"; do
    ipt -A "$CHAIN" -p udp --dport "$port" -m hashlimit \
      --hashlimit 400/sec --hashlimit-burst 800 \
      --hashlimit-mode srcip --hashlimit-name "xbox_udp_game_${port}_${XBOX_IP//./_}" \
      -j ACCEPT || true
  done
  for port in "${XBOX_TCP_PORTS[@]}"; do
    ipt -A "$CHAIN" -p tcp --dport "$port" -m conntrack --ctstate NEW -m hashlimit \
      --hashlimit 120/sec --hashlimit-burst 240 \
      --hashlimit-mode srcip --hashlimit-name "xbox_tcp_game_${port}_${XBOX_IP//./_}" \
      -j ACCEPT || true
    ipt -A "$CHAIN" -p tcp --dport "$port" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || true
  done

  # Per-source connection cap when connlimit module exists
  if ipt -A "$CHAIN" -p udp -m connlimit --connlimit 64 --connlimit-mask 32 --connlimit-saddr -j DROP 2>/dev/null; then
    log "connlimit active (64 UDP flows per source)"
  else
    ipt -D "$CHAIN" -p udp -m connlimit --connlimit 64 --connlimit-mask 32 --connlimit-saddr -j DROP 2>/dev/null || true
    log "connlimit unavailable — hashlimit-only mode"
  fi

  # Non-game UDP/TCP caps
  ipt -A "$CHAIN" -p udp -m hashlimit \
    --hashlimit 800/sec --hashlimit-burst 1600 \
    --hashlimit-mode srcip --hashlimit-name "xbox_udp_${XBOX_IP//./_}" \
    -j ACCEPT || true
  ipt -A "$CHAIN" -p udp -j DROP || true
  ipt -A "$CHAIN" -p tcp --syn -m hashlimit \
    --hashlimit 120/sec --hashlimit-burst 240 \
    --hashlimit-mode srcip --hashlimit-name "xbox_tcp_${XBOX_IP//./_}" \
    -j ACCEPT || true
  ipt -A "$CHAIN" -p tcp --syn -j DROP || true
  ipt -A "$CHAIN" -j ACCEPT || true

  {
    echo "mode=defend"
    echo "xbox_ip=${XBOX_IP}"
    echo "updated=$(date -Is)"
  } >"$STATE"
  log "DEFEND — per-source game-port limits active for Xbox ${XBOX_IP}"
}

cmd_harden() {
  need_root
  require_xbox_ip
  cmd_relax

  ipt -N "$CHAIN"
  ipt -A FORWARD -d "$XBOX_IP" -j "$CHAIN"
  ipt -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  # Aggressive per-source caps on game ports (kick-attack mitigation)
  for port in "${XBOX_UDP_PORTS[@]}"; do
    ipt -A "$CHAIN" -p udp --dport "$port" -m hashlimit \
      --hashlimit 180/sec --hashlimit-burst 360 \
      --hashlimit-mode srcip --hashlimit-name "xbox_harden_${port}_${XBOX_IP//./_}" \
      -j ACCEPT || true
  done
  for port in "${XBOX_UDP_PORTS[@]}"; do
    ipt -A "$CHAIN" -p udp --dport "$port" -j DROP || true
  done
  for port in "${XBOX_TCP_PORTS[@]}"; do
    ipt -A "$CHAIN" -p tcp --dport "$port" -m hashlimit \
      --hashlimit 60/sec --hashlimit-burst 120 \
      --hashlimit-mode srcip --hashlimit-name "xbox_harden_tcp_${port}_${XBOX_IP//./_}" \
      -j ACCEPT || true
  done

  if ipt -A "$CHAIN" -p udp -m connlimit --connlimit 32 --connlimit-mask 32 --connlimit-saddr -j DROP 2>/dev/null; then
    log "connlimit harden (32 UDP flows per source)"
  fi

  ipt -A "$CHAIN" -p udp -m hashlimit \
    --hashlimit 400/sec --hashlimit-burst 800 \
    --hashlimit-mode srcip --hashlimit-name "xbox_harden_udp_${XBOX_IP//./_}" \
    -j ACCEPT || true
  ipt -A "$CHAIN" -p udp -j DROP || true
  ipt -A "$CHAIN" -p tcp --syn -m hashlimit \
    --hashlimit 60/sec --hashlimit-burst 120 \
    --hashlimit-mode srcip --hashlimit-name "xbox_harden_tcp_${XBOX_IP//./_}" \
    -j ACCEPT || true
  ipt -A "$CHAIN" -p tcp --syn -j DROP || true
  ipt -A "$CHAIN" -j ACCEPT || true

  {
    echo "mode=harden"
    echo "xbox_ip=${XBOX_IP}"
    echo "updated=$(date -Is)"
  } >"$STATE"
  log "HARDEN — aggressive kick/flood mitigation for Xbox ${XBOX_IP}"
}

case "${1:-status}" in
  status) cmd_status ;;
  defend) cmd_defend ;;
  harden) cmd_harden ;;
  relax|off) cmd_relax ;;
  *) echo "Usage: $0 {status|defend|harden|relax}"; exit 2 ;;
esac
