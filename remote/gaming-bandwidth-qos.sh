#!/usr/bin/env bash
# Xbox-only bandwidth caps (static) or release to Firewalla CAKE/device QoS (dynamic).
# Uses ingress policing on LAN_IF only — does not replace CAKE/ifb shaping.
set -euo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
CONF="${TOOLS_DIR}/gaming.conf"
STATE="${TOOLS_DIR}/.bandwidth-qos.state"
FILTER_TAG="xbox_bw"

if [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi
# shellcheck disable=SC1091
source "${TOOLS_DIR}/xbox-scope.sh"

log() { printf '[bandwidth-qos] %s\n' "$*"; }

need_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "Run with sudo"; exit 1; }; }

dev() { echo "${LAN_IF:-br2}"; }

ensure_ingress() {
  tc qdisc add dev "$(dev)" handle ffff: ingress 2>/dev/null || true
}

flush_xbox_filters() {
  local d
  d="$(dev)"
  # Remove prior filters tagged in pref range 49000-49099
  local pref
  for pref in $(seq 49000 49099); do
    tc filter del dev "$d" parent ffff: pref "$pref" 2>/dev/null || true
  done
}

teardown() {
  flush_xbox_filters
  rm -f "$STATE"
}

cmd_status() {
  [[ -f "$STATE" ]] && cat "$STATE" || echo "mode=inactive"
  tc -s filter show dev "$(dev)" parent ffff: 2>/dev/null | head -20 || true
}

cmd_dynamic() {
  need_root
  require_xbox_ip
  teardown
  {
    echo "mode=dynamic"
    echo "updated=$(date -Is)"
    echo "xbox_ip=${XBOX_IP}"
  } >"$STATE"
  log "DYNAMIC — no Xbox bandwidth caps; Firewalla CAKE + device QoS allocate bandwidth"
}

add_police_filter() {
  local pref="$1" match_proto="$2" match_clause="$3" rate_bps="$4"
  tc filter add dev "$(dev)" parent ffff: protocol "$match_proto" pref "$pref" u32 \
    $match_clause police rate "${rate_bps}bit" burst 512k drop
}

cmd_static() {
  need_root
  local up_mbps="${1:-0}"
  local down_mbps="${2:-0}"
  require_xbox_ip
  if [[ "$up_mbps" -le 0 || "$down_mbps" -le 0 ]]; then
    echo "Usage: $0 static UPLOAD_MBPS DOWNLOAD_MBPS" >&2
    exit 2
  fi

  teardown
  ensure_ingress

  local up_bps=$((up_mbps * 1000 * 1000))
  local down_bps=$((down_mbps * 1000 * 1000))
  local pref=49000

  while IFS= read -r src; do
    [[ -z "$src" ]] && continue
    if [[ "$src" == *:* ]]; then
      add_police_filter "$pref" ipv6 "match ip6 src $src" "$up_bps" || true
      pref=$((pref + 1))
      add_police_filter "$pref" ipv6 "match ip6 dst $src" "$down_bps" || true
    else
      add_police_filter "$pref" ip "match ip src $src" "$up_bps"
      pref=$((pref + 1))
      add_police_filter "$pref" ip "match ip dst $src" "$down_bps"
    fi
    pref=$((pref + 1))
  done < <(xbox_sources)

  {
    echo "mode=static"
    echo "upload_mbps=${up_mbps}"
    echo "download_mbps=${down_mbps}"
    echo "updated=$(date -Is)"
    echo "xbox_ip=${XBOX_IP}"
    echo "lan_if=$(dev)"
  } >"$STATE"
  log "STATIC — Xbox ${XBOX_IP} capped at ↑${up_mbps} ↓${down_mbps} Mbps (other LAN devices unchanged)"
}

case "${1:-status}" in
  status) cmd_status ;;
  dynamic) need_root; cmd_dynamic ;;
  static) shift; cmd_static "${1:-0}" "${2:-0}" ;;
  off) need_root; teardown; log "OFF — bandwidth caps removed" ;;
  *) echo "Usage: $0 {status|dynamic|static UP_MBPS DOWN_MBPS|off}"; exit 2 ;;
esac
