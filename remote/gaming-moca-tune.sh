#!/usr/bin/env bash
# Mitigate MoCA hop latency: prioritize game traffic TO Xbox, deprioritize bulk downloads,
# and probe LAN jitter (Firewalla → Xbox over MoCA/Ethernet).
set -uo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
CONF="${TOOLS_DIR}/gaming.conf"
STATE="${TOOLS_DIR}/.moca-tune.state"
CHAIN="XBOX_MOCA_QOS"
BULK_CHAIN="XBOX_MOCA_BULK"

if [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi
# shellcheck disable=SC1091
source "${TOOLS_DIR}/xbox-scope.sh"

log() { printf '[moca-tune] %s\n' "$*"; }

need_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "Run with sudo"; exit 1; }; }

discover_xbox_port() {
  [[ -n "${XBOX_MAC:-}" ]] || return 0
  local mac="${XBOX_MAC,,}"
  bridge fdb show br "${LAN_IF:-br2}" 2>/dev/null | while read -r _ _ dev _ _ m; do
    [[ "${m,,}" == "$mac" ]] || continue
    echo "$dev"
    break
  done
}

setup_mangle() {
  local cmd="$1" suffix="$2"
  "$cmd" -t mangle -N "$CHAIN" 2>/dev/null || true
  "$cmd" -t mangle -F "$CHAIN" 2>/dev/null || true
  "$cmd" -t mangle -N "$BULK_CHAIN" 2>/dev/null || true
  "$cmd" -t mangle -F "$BULK_CHAIN" 2>/dev/null || true

  local dst
  while IFS= read -r dst; do
    [[ -z "$dst" ]] && continue
    if [[ "$cmd" == "ip6tables" && "$dst" != *:* ]]; then continue; fi
    if [[ "$cmd" == "iptables" && "$dst" == *:* ]]; then continue; fi

    # Game traffic TO Xbox — Expedited Forwarding (CAKE / switches honor if present)
    for port in 3074 3075; do
      "$cmd" -t mangle -A "$CHAIN" -d "$dst" -p udp --dport "$port" -j DSCP --set-dscp-class EF
      "$cmd" -t mangle -A "$CHAIN" -d "$dst" -p tcp --dport "$port" -j DSCP --set-dscp-class EF
    done
    for port in 88 500 3544 4500 53; do
      "$cmd" -t mangle -A "$CHAIN" -d "$dst" -p udp --dport "$port" -j DSCP --set-dscp-class EF
    done

    # Bulk download TO Xbox — lower priority so MoCA buffers fill with game first
    "$cmd" -t mangle -A "$BULK_CHAIN" -d "$dst" -p tcp -m multiport --dports 80,443,7680 -j DSCP --set-dscp-class CS1
  done < <(xbox_sources)

  if ! "$cmd" -t mangle -C FORWARD -j "$CHAIN" 2>/dev/null; then
    "$cmd" -t mangle -I FORWARD 1 -j "$CHAIN"
  fi
  if ! "$cmd" -t mangle -C FORWARD -j "$BULK_CHAIN" 2>/dev/null; then
    "$cmd" -t mangle -A FORWARD -j "$BULK_CHAIN"
  fi
}

teardown_mangle() {
  iptables -t mangle -D FORWARD -j "$CHAIN" 2>/dev/null || true
  iptables -t mangle -F "$CHAIN" 2>/dev/null || true
  iptables -t mangle -X "$CHAIN" 2>/dev/null || true
  iptables -t mangle -D FORWARD -j "$BULK_CHAIN" 2>/dev/null || true
  iptables -t mangle -F "$BULK_CHAIN" 2>/dev/null || true
  iptables -t mangle -X "$BULK_CHAIN" 2>/dev/null || true
  ip6tables -t mangle -D FORWARD -j "$CHAIN" 2>/dev/null || true
  ip6tables -t mangle -F "$CHAIN" 2>/dev/null || true
  ip6tables -t mangle -X "$CHAIN" 2>/dev/null || true
  ip6tables -t mangle -D FORWARD -j "$BULK_CHAIN" 2>/dev/null || true
  ip6tables -t mangle -F "$BULK_CHAIN" 2>/dev/null || true
  ip6tables -t mangle -X "$BULK_CHAIN" 2>/dev/null || true
}

cmd_ping() {
  require_xbox_ip
  python3 - "$XBOX_IP" <<'PY'
import re, statistics, subprocess, sys, json

host = sys.argv[1]
proc = subprocess.run(
    ["ping", "-c", "20", "-i", "0.2", "-W", "1", host],
    capture_output=True, text=True, check=False,
)
text = proc.stdout or ""
ms = [float(x) for x in re.findall(r"time=(\d+(?:\.\d+)?)\s*ms", text)]
if len(ms) < 3:
    print(json.dumps({"ok": False, "error": "insufficient ping replies", "raw": text[-400:]}))
    raise SystemExit(0)
jitter = statistics.pstdev(ms) if len(ms) > 1 else 0
print(json.dumps({
    "ok": True,
    "host": host,
    "samples": len(ms),
    "minMs": round(min(ms), 2),
    "avgMs": round(statistics.mean(ms), 2),
    "maxMs": round(max(ms), 2),
    "jitterMs": round(jitter, 2),
    "path": "firewalla-to-xbox",
}, indent=2))
PY
}

cmd_track() {
  require_xbox_ip
  local d1="${MOCA_DEVICE_1_IP:-192.168.167.13}"
  local d2="${MOCA_DEVICE_2_IP:-192.168.167.19}"
  local l1="${MOCA_DEVICE_1_LABEL:-MoCA .13}"
  local l2="${MOCA_DEVICE_2_LABEL:-MoCA .19}"
  MOCA_DEVICE_1_IP="$d1" MOCA_DEVICE_2_IP="$d2" \
  MOCA_DEVICE_1_LABEL="$l1" MOCA_DEVICE_2_LABEL="$l2" \
  MOCA_ADMIN_USER="${MOCA_ADMIN_USER:-admin}" \
  MOCA_ADMIN_PASSWORD="${MOCA_ADMIN_PASSWORD:-}" \
  XBOX_IP="$XBOX_IP" TOOLS_DIR="$TOOLS_DIR" \
  python3 "${TOOLS_DIR}/moca-adapter-lib.py" track
}

cmd_adapter_tune() {
  local d1="${MOCA_DEVICE_1_IP:-192.168.167.13}"
  local d2="${MOCA_DEVICE_2_IP:-192.168.167.19}"
  MOCA_DEVICE_1_IP="$d1" MOCA_DEVICE_2_IP="$d2" \
  MOCA_ADMIN_USER="${MOCA_ADMIN_USER:-admin}" \
  MOCA_ADMIN_PASSWORD="${MOCA_ADMIN_PASSWORD:-}" \
  TOOLS_DIR="$TOOLS_DIR" \
  python3 "${TOOLS_DIR}/moca-adapter-lib.py" adapter-tune
}

cmd_adapter_status() {
  local d1="${MOCA_DEVICE_1_IP:-192.168.167.13}"
  local d2="${MOCA_DEVICE_2_IP:-192.168.167.19}"
  MOCA_DEVICE_1_IP="$d1" MOCA_DEVICE_2_IP="$d2" \
  MOCA_ADMIN_USER="${MOCA_ADMIN_USER:-admin}" \
  MOCA_ADMIN_PASSWORD="${MOCA_ADMIN_PASSWORD:-}" \
  TOOLS_DIR="$TOOLS_DIR" \
  python3 "${TOOLS_DIR}/moca-adapter-lib.py" adapter-status
}

cmd_status() {
  [[ -f "$STATE" ]] && cat "$STATE" || echo "mode=inactive"
  local port
  port="$(discover_xbox_port || true)"
  echo "xbox_lan_port=${port:-unknown}"
  iptables -t mangle -L "$CHAIN" -n 2>/dev/null | head -12 || echo "chain inactive"
}

cmd_apply() {
  need_root
  require_xbox_ip
  teardown_mangle
  setup_mangle iptables ""
  setup_mangle ip6tables "_6"
  local port
  port="$(discover_xbox_port || true)"
  {
    echo "mode=active"
    echo "xbox_ip=${XBOX_IP}"
    echo "xbox_mac=${XBOX_MAC:-}"
    echo "lan_if=${LAN_IF:-br2}"
    echo "xbox_lan_port=${port:-unknown}"
    echo "updated=$(date -Is)"
  } >"$STATE"
  log "ACTIVE — game traffic TO Xbox marked EF; bulk HTTPS/HTTP marked CS1; MoCA port=${port:-unknown}"
  if [[ "${MOCA_ADAPTER_GAMING_TUNE:-}" == "1" && -n "${MOCA_ADMIN_PASSWORD:-}" ]]; then
    cmd_adapter_tune >/dev/null 2>&1 || log "adapter-tune skipped or failed (check MOCA_ADMIN_PASSWORD)"
  fi
}

cmd_relax() {
  need_root
  teardown_mangle
  rm -f "$STATE"
  log "RELAX — MoCA QoS marks removed"
}

case "${1:-status}" in
  apply) cmd_apply ;;
  relax|off) cmd_relax ;;
  ping|probe) cmd_ping ;;
  track) cmd_track ;;
  adapter-tune) cmd_adapter_tune ;;
  adapter-status) cmd_adapter_status ;;
  status) cmd_status ;;
  *) echo "Usage: $0 {apply|relax|ping|track|adapter-tune|adapter-status|status}"; exit 2 ;;
esac
