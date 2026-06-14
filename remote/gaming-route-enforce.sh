#!/usr/bin/env bash
# Block slow internet paths for Xbox — forces use of lowest-latency routes from route probes.
set -euo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
CONF="${TOOLS_DIR}/gaming.conf"
STATE="${TOOLS_DIR}/.route-enforce.state"
CHAIN="XBOX_ROUTE_ENFORCE"
IPSET4="xbox_route_block"
IPSET6="xbox_route_block_6"

if [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi

XBOX_IP="${XBOX_IP:-A.A.A.A6}"
XBOX_MAC="${XBOX_MAC:-28:EA:0B:75:3B:75}"

log() { printf '[route-enforce] %s\n' "$*"; }

need_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "Run with sudo"; exit 1; }; }

discover_xbox_ipv6() {
  [[ -n "${XBOX_MAC:-}" ]] || return 0
  local mac="${XBOX_MAC,,}"
  ip -6 neigh show dev "${LAN_IF:-br2}" 2>/dev/null | while read -r line; do
    [[ "${line,,}" == *"$mac"* ]] || continue
    echo "$line" | awk '{print $1}'
  done
}

xbox_sources() {
  { echo "${XBOX_IP}"; discover_xbox_ipv6; } | sort -u | grep -v '^$' || true
}

ensure_ipsets() {
  ipset create "$IPSET4" hash:net family inet hashsize 4096 maxelem 65536 -exist
  ipset create "$IPSET6" hash:net family inet6 hashsize 4096 maxelem 65536 -exist
}

flush_ipsets() {
  ipset flush "$IPSET4" 2>/dev/null || true
  ipset flush "$IPSET6" 2>/dev/null || true
}

load_enforcement_json() {
  local file="${1:-}"
  [[ -n "$file" && -f "$file" ]] || { echo 0; return; }
  python3 - "$file" "$IPSET4" "$IPSET6" <<'PY'
import json, subprocess, sys

path = sys.argv[1]
set4, set6 = sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as f:
    data = json.load(f)

added = 0
for row in data.get("blocked", []):
    ip = (row.get("ip") or "").strip()
    if not ip:
        continue
    setname = set6 if ":" in ip else set4
    if subprocess.run(["ipset", "add", setname, ip, "-exist"], capture_output=True).returncode == 0:
        added += 1
print(added)
PY
}

remove_jump() {
  local cmd="$1" src="$2" suffix="$3"
  while "$cmd" -C FORWARD -s "$src" -j "${CHAIN}${suffix}" 2>/dev/null; do
    "$cmd" -D FORWARD -s "$src" -j "${CHAIN}${suffix}" 2>/dev/null || break
  done
}

setup_chain() {
  local cmd="$1" suffix="$2" ipset="$3"
  local chain="${CHAIN}${suffix}"

  "$cmd" -N "$chain" 2>/dev/null || true
  "$cmd" -F "$chain" 2>/dev/null || true
  "$cmd" -A "$chain" -m set --match-set "$ipset" dst -j DROP

  local src
  while IFS= read -r src; do
    [[ -z "$src" ]] && continue
    if [[ "$cmd" == "ip6tables" && "$src" != *:* ]]; then continue; fi
    if [[ "$cmd" == "iptables" && "$src" == *:* ]]; then continue; fi
    if ! "$cmd" -C FORWARD -s "$src" -j "$chain" 2>/dev/null; then
      "$cmd" -I FORWARD 1 -s "$src" -j "$chain"
    fi
  done < <(xbox_sources)
}

teardown() {
  local src
  while IFS= read -r src; do
    [[ -z "$src" ]] && continue
    remove_jump iptables "$src" ""
    remove_jump ip6tables "$src" "_6"
  done < <(xbox_sources)

  iptables -F "$CHAIN" 2>/dev/null || true
  iptables -X "$CHAIN" 2>/dev/null || true
  ip6tables -F "${CHAIN}_6" 2>/dev/null || true
  ip6tables -X "${CHAIN}_6" 2>/dev/null || true
  flush_ipsets
  rm -f "$STATE"
}

cmd_status() {
  [[ -f "$STATE" ]] && cat "$STATE" || echo "enabled=inactive"
  ipset list "$IPSET4" 2>/dev/null | awk '/Number of entries/{print "blocked_v4: "$4}'
  ipset list "$IPSET6" 2>/dev/null | awk '/Number of entries/{print "blocked_v6: "$4}'
  if [[ -f "$STATE" ]]; then
    echo "--- blocked IPs ---"
    ipset list "$IPSET4" 2>/dev/null | awk '/^[^#]/ && !/Name|Number|Type|Revision|Header|Size|References|Members|timeout/ {print "  v4 " $0}'
    ipset list "$IPSET6" 2>/dev/null | awk '/^[^#]/ && !/Name|Number|Type|Revision|Header|Size|References|Members|timeout/ {print "  v6 " $0}'
  fi
}

cmd_off() {
  need_root
  teardown
  log "OFF — no slow-path blocks active"
}

cmd_sync() {
  need_root
  local json_file="${1:-}"
  ensure_ipsets
  flush_ipsets
  local count
  count="$(load_enforcement_json "$json_file")"
  setup_chain iptables "" "$IPSET4"
  setup_chain ip6tables "_6" "$IPSET6"
  {
    echo "enabled=active"
    echo "updated=$(date -Is)"
    echo "blocked=${count}"
    echo "bestRegion=$(python3 -c "import json; print(json.load(open('$json_file')).get('bestRegion') or '')" 2>/dev/null || true)"
  } >"$STATE"
  log "ON — blocking ${count} slow path destination(s) for Xbox"
}

case "${1:-status}" in
  status) cmd_status ;;
  off) need_root; cmd_off ;;
  sync) shift; cmd_sync "${1:-}" ;;
  *) echo "Usage: $0 {status|off|sync [json-file]}"; exit 2 ;;
esac
