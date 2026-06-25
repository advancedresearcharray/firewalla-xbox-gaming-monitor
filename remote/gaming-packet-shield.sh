#!/usr/bin/env bash
# Size-aware Xbox protection — sheds tiny inbound flood packets (<80 bytes) that
# kick/boot tools use, while normal Warzone UDP (typically 80–1400 bytes) passes
# without aggressive rate limits. Lighter than gaming-flood-guard defend/harden.
set -uo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
CONF="${TOOLS_DIR}/gaming.conf"
STATE="${TOOLS_DIR}/.packet-shield.state"
CHAIN="XBOX_PACKET_SHIELD"
# Match gaming-snapshot.sh tinyInbound threshold
TINY_MAX="${XBOX_TINY_PACKET_MAX:-79}"

if [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi
# shellcheck disable=SC1091
source "${TOOLS_DIR}/xbox-scope.sh"

log() { printf '[packet-shield] %s\n' "$*"; }

need_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "Run with sudo"; exit 1; }; }

ipt() {
  if ! iptables "$@"; then
    log "WARN iptables $*"
    return 1
  fi
}

cmd_status() {
  [[ -f "$STATE" ]] && cat "$STATE" || echo "mode=inactive"
  iptables -L "$CHAIN" -n -v 2>/dev/null | head -24 || echo "chain inactive"
}

cmd_relax() {
  need_root
  while iptables -D FORWARD -d "${XBOX_IP:-}" -j "$CHAIN" 2>/dev/null; do :; done
  iptables -F "$CHAIN" 2>/dev/null || true
  iptables -X "$CHAIN" 2>/dev/null || true
  rm -f "$STATE"
  log "RELAX — packet shield removed"
}

apply_tiny_rules() {
  local tiny_rate="$1"
  local tiny_burst="$2"
  local ip_tag="${XBOX_IP//./_}"

  for port in "${XBOX_UDP_PORTS[@]}"; do
    ipt -A "$CHAIN" -p udp --dport "$port" -m length --length "0:${TINY_MAX}" \
      -m hashlimit \
      --hashlimit "${tiny_rate}/sec" --hashlimit-burst "$tiny_burst" \
      --hashlimit-mode srcip --hashlimit-name "xbox_tiny_${port}_${ip_tag}" \
      -j ACCEPT || true
    ipt -A "$CHAIN" -p udp --dport "$port" -m length --length "0:${TINY_MAX}" -j DROP || true
  done

  # Tiny TCP SYN probes to game/aux ports
  for port in "${XBOX_TCP_PORTS[@]}"; do
    ipt -A "$CHAIN" -p tcp --dport "$port" --tcp-flags SYN,RST,ACK,FIN SYN \
      -m length --length "0:${TINY_MAX}" \
      -m hashlimit \
      --hashlimit "${tiny_rate}/sec" --hashlimit-burst "$tiny_burst" \
      --hashlimit-mode srcip --hashlimit-name "xbox_tiny_tcp_${port}_${ip_tag}" \
      -j ACCEPT || true
    ipt -A "$CHAIN" -p tcp --dport "$port" --tcp-flags SYN,RST,ACK,FIN SYN \
      -m length --length "0:${TINY_MAX}" -j DROP || true
  done
}

apply_normal_game_pass() {
  for port in "${XBOX_UDP_PORTS[@]}"; do
    ipt -A "$CHAIN" -p udp --dport "$port" -j ACCEPT || true
  done
  for port in "${XBOX_TCP_PORTS[@]}"; do
    ipt -A "$CHAIN" -p tcp --dport "$port" -m conntrack --ctstate NEW,ESTABLISHED,RELATED -j ACCEPT || true
  done
}

apply_mss_clamp() {
  # TCP only — clamp large segments on bulk HTTPS to Xbox so MoCA handles smaller frames.
  # Does not touch Warzone UDP game traffic.
  ipt -A "$CHAIN" -p tcp --tcp-flags SYN,RST SYN -m tcpmss --mss 1:1300 \
    -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null || \
    ipt -A "$CHAIN" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1200 2>/dev/null || true
}

cmd_shield() {
  need_root
  require_xbox_ip
  local level="${1:-normal}"
  cmd_relax

  local tiny_rate=30
  local tiny_burst=60
  case "$level" in
    strict) tiny_rate=12; tiny_burst=24 ;;
    normal|*) ;;
  esac

  ipt -N "$CHAIN"
  ipt -A FORWARD -d "$XBOX_IP" -j "$CHAIN"
  ipt -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  apply_tiny_rules "$tiny_rate" "$tiny_burst"
  apply_normal_game_pass
  apply_mss_clamp

  # Non-game UDP: drop remaining tiny, moderate cap on small/medium
  ipt -A "$CHAIN" -p udp -m length --length "0:${TINY_MAX}" -j DROP || true
  ipt -A "$CHAIN" -p udp -m hashlimit \
    --hashlimit 600/sec --hashlimit-burst 1200 \
    --hashlimit-mode srcip --hashlimit-name "xbox_shield_udp_${XBOX_IP//./_}" \
    -j ACCEPT || true
  ipt -A "$CHAIN" -p udp -j DROP || true
  ipt -A "$CHAIN" -p tcp --syn -m hashlimit \
    --hashlimit 80/sec --hashlimit-burst 160 \
    --hashlimit-mode srcip --hashlimit-name "xbox_shield_tcp_${XBOX_IP//./_}" \
    -j ACCEPT || true
  ipt -A "$CHAIN" -p tcp --syn -j DROP || true
  ipt -A "$CHAIN" -j ACCEPT || true

  {
    echo "mode=shield"
    echo "level=${level}"
    echo "tiny_max_bytes=${TINY_MAX}"
    echo "tiny_rate_per_src=${tiny_rate}/sec"
    echo "xbox_ip=${XBOX_IP}"
    echo "updated=$(date -Is)"
  } >"$STATE"
  log "SHIELD (${level}) — drop inbound UDP/TCP ≤${TINY_MAX}B floods; normal game packets pass"
}

case "${1:-status}" in
  status) cmd_status ;;
  shield) shift; cmd_shield "${1:-normal}" ;;
  strict) cmd_shield strict ;;
  relax|off) cmd_relax ;;
  *) echo "Usage: $0 {status|shield [normal|strict]|strict|relax}"; exit 2 ;;
esac
