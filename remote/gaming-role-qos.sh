#!/usr/bin/env bash
# Per-destination QoS for Xbox traffic via DSCP marks (CAKE diffserv3 on Gold).
set -euo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
CONF="${TOOLS_DIR}/gaming.conf"
STATE="${TOOLS_DIR}/.traffic-profile.state"
CHAIN="XBOX_ROLE_QOS"

if [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi
# shellcheck disable=SC1091
source "${TOOLS_DIR}/xbox-scope.sh"

log() { printf '[role-qos] %s\n' "$*"; }

need_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "Run with sudo"; exit 1; }; }

ensure_ipsets() {
  ipset create xbox_qos_critical hash:net family inet hashsize 4096 maxelem 65536 -exist
  ipset create xbox_qos_high hash:net family inet hashsize 4096 maxelem 65536 -exist
  ipset create xbox_qos_low hash:net family inet hashsize 4096 maxelem 65536 -exist
  ipset create xbox_qos_critical_6 hash:net family inet6 hashsize 4096 maxelem 65536 -exist
  ipset create xbox_qos_high_6 hash:net family inet6 hashsize 4096 maxelem 65536 -exist
  ipset create xbox_qos_low_6 hash:net family inet6 hashsize 4096 maxelem 65536 -exist
}

flush_ipsets() {
  for s in xbox_qos_critical xbox_qos_high xbox_qos_low xbox_qos_critical_6 xbox_qos_high_6 xbox_qos_low_6; do
    ipset flush "$s" 2>/dev/null || true
  done
}

load_ips_json() {
  local file="${1:-}"
  [[ -n "$file" && -f "$file" ]] || { echo 0; return; }
  python3 - "$file" <<'PY'
import json, subprocess, sys
with open(sys.argv[1], encoding="utf-8") as f:
    rows = json.load(f)
added = 0
for row in rows:
    tier = row.get("effectiveTier") or row.get("tier")
    ip = (row.get("ip") or "").strip()
    if tier not in ("critical", "high", "low") or not ip:
        continue
    setname = f"xbox_qos_{tier}_6" if ":" in ip else f"xbox_qos_{tier}"
    if subprocess.run(["ipset", "add", setname, ip, "-exist"], capture_output=True).returncode == 0:
        added += 1
print(added)
PY
}

setup_chain() {
  local cmd="$1" suffix="$2"
  "$cmd" -t mangle -N "$CHAIN" 2>/dev/null || true
  "$cmd" -t mangle -F "$CHAIN" 2>/dev/null || true

  local src
  while IFS= read -r src; do
    [[ -z "$src" ]] && continue
    if [[ "$cmd" == "ip6tables" && "$src" != *:* ]]; then continue; fi
    if [[ "$cmd" == "iptables" && "$src" == *:* ]]; then continue; fi
    "$cmd" -t mangle -A "$CHAIN" -s "$src" -m set --match-set "xbox_qos_critical${suffix}" dst -j DSCP --set-dscp-class EF
    "$cmd" -t mangle -A "$CHAIN" -s "$src" -m set --match-set "xbox_qos_high${suffix}" dst -j DSCP --set-dscp-class AF41
    "$cmd" -t mangle -A "$CHAIN" -s "$src" -m set --match-set "xbox_qos_low${suffix}" dst -j DSCP --set-dscp-class CS1
  done < <(xbox_sources)

  if ! "$cmd" -t mangle -C POSTROUTING -j "$CHAIN" 2>/dev/null; then
    "$cmd" -t mangle -A POSTROUTING -j "$CHAIN"
  fi
}

teardown() {
  iptables -t mangle -D POSTROUTING -j "$CHAIN" 2>/dev/null || true
  iptables -t mangle -F "$CHAIN" 2>/dev/null || true
  iptables -t mangle -X "$CHAIN" 2>/dev/null || true
  ip6tables -t mangle -D POSTROUTING -j "$CHAIN" 2>/dev/null || true
  ip6tables -t mangle -F "$CHAIN" 2>/dev/null || true
  ip6tables -t mangle -X "$CHAIN" 2>/dev/null || true
  flush_ipsets
  rm -f "$STATE"
}

cmd_status() {
  [[ -f "$STATE" ]] && cat "$STATE" || echo "profile=balanced (inactive)"
  for s in xbox_qos_critical xbox_qos_high xbox_qos_low xbox_qos_critical_6 xbox_qos_high_6 xbox_qos_low_6; do
    ipset list "$s" 2>/dev/null | awk -v n="$s" '/Number of entries/{print n": "$4}'
  done
}

cmd_off() {
  need_root
  teardown
  log "OFF — only Xbox device QoS (569/570) remains active"
}

cmd_sync() {
  need_root
  local profile="${1:-competitive}"
  local json_file="${2:-}"
  require_xbox_ip
  if [[ "$profile" == "balanced" ]]; then
    cmd_off
    return 0
  fi
  ensure_ipsets
  flush_ipsets
  local count
  count="$(load_ips_json "$json_file")"
  {
    echo "profile=${profile}"
    echo "updated=$(date -Is)"
    echo "ips=${count}"
  } >"$STATE"
  setup_chain iptables ""
  setup_chain ip6tables "_6"
  log "ON profile=${profile} — ${count} destination IPs classified"
}

case "${1:-status}" in
  status) cmd_status ;;
  off) need_root; cmd_off ;;
  sync) shift; cmd_sync "${1:-competitive}" "${2:-}" ;;
  *) echo "Usage: $0 {status|off|sync PROFILE [json-file]}"; exit 2 ;;
esac
