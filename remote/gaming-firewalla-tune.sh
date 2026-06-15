#!/usr/bin/env bash
# Apply performance-oriented Firewalla settings for Xbox gaming (safe, reversible).
set -euo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
CONF="${TOOLS_DIR}/gaming.conf"
STATE="${TOOLS_DIR}/.firewalla-tune.state"
# Fall back if tools dir is not writable (e.g. root-owned).
if ! touch "$STATE" 2>/dev/null; then
  STATE="/tmp/firewalla-tune.state"
fi

if [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi

log() { printf '[firewalla-tune] %s\n' "$*"; }

kill_stuck_shells() {
  local killed=0
  while read -r pid etime cpu cmd; do
    [[ "$cmd" == *"bash -s"* ]] || continue
    [[ "$cpu" =~ ^[0-9]+\.?[0-9]*$ ]] || continue
    # E.g. 03:26:54 or 205:20 — kill long-running remote audit shells only.
    if awk -v e="$etime" -v c="$cpu" 'BEGIN {
      split(e, p, ":");
      mins = 0;
      if (length(p) == 3) mins = p[1]*60 + p[2];
      else if (length(p) == 2) mins = p[1];
      exit !(mins >= 30 || c + 0 >= 50);
    }'; then
      kill "$pid" 2>/dev/null || sudo kill "$pid" 2>/dev/null || true
      killed=$((killed + 1))
      log "Killed stuck shell pid=$pid etime=$etime cpu=$cpu"
    fi
  done < <(ps -eo pid,etime,pcpu,args | grep "bash -s" | grep -v grep || true)
  echo "killed_stuck_shells=$killed"
}

apply_redis_tuning() {
  python3 - "$XBOX_MAC" <<'PY'
import json
import subprocess
import sys

mac = (sys.argv[1] or "").upper().replace("-", ":")
changes = []


def rcli(*args):
    out = subprocess.run(["redis-cli", *args], capture_output=True, text=True, check=False)
    return (out.stdout or "").strip()


def merge_policy_system(field, patch):
    raw = rcli("hget", "policy:system", field)
    obj = json.loads(raw) if raw else {}
    if not isinstance(obj, dict):
        obj = {"state": False}
    obj.update(patch)
    rcli("hset", "policy:system", field, json.dumps(obj))
    changes.append(f"policy:system.{field}={obj}")


def set_feature(name, value="0"):
    rcli("hset", "sys:features", name, value)
    changes.append(f"sys:features.{name}={value}")


set_feature("device_service_scan", "0")
set_feature("weak_password_scan", "0")
set_feature("network_monitor", "0")
set_feature("vulnerability", "0")
set_feature("external_scan", "0")
set_feature("internal_scan", "0")
set_feature("cyber_security.autoBlock", "0")

merge_policy_system("weak_password_scan", {"state": False})
merge_policy_system("network_monitor", {"state": False})
merge_policy_system("internet_speedtest", {"state": False})
merge_policy_system("unbound", {"state": False})

if mac:
    key = f"policy:mac:{mac}"
    if rcli("exists", key) == "1":
        rcli("hset", key, "monitor", "false")
        rcli("hset", key, "device_service_scan", "false")
        rcli("hset", key, "weak_password_scan", json.dumps({"state": False}))
        rcli("hset", key, "adblock", "false")
        rcli("hset", key, "family", "false")
        rcli("hset", key, "doh", json.dumps({"state": False}))
        rcli("hset", key, "unbound", json.dumps({"state": False}))
        changes.append(f"{key} gaming exemptions applied")

print(json.dumps({"ok": True, "changes": changes}, indent=2))
PY
}

cmd_apply() {
  kill_stuck_shells
  apply_redis_tuning >"$STATE"
  cat "$STATE"
  log "Done — settings stored in Redis (app sync may override some global flags after reboot)"
}

cmd_status() {
  echo "=== load ===" && uptime
  echo "=== mem ===" && free -h | head -2
  echo "=== stuck shells ===" && ps aux | grep "bash -s" | grep -v grep || echo none
  echo "=== sys:features (tuned) ===" && redis-cli hmget sys:features device_service_scan weak_password_scan network_monitor cyber_security.autoBlock 2>/dev/null
  if [[ -n "${XBOX_MAC:-}" ]]; then
    echo "=== Xbox policy ===" && redis-cli hmget "policy:mac:${XBOX_MAC^^}" monitor device_service_scan adblock family 2>/dev/null
  fi
  [[ -f "$STATE" ]] && echo "=== last tune ===" && tail -5 "$STATE"
}

case "${1:-apply}" in
  apply) cmd_apply ;;
  status) cmd_status ;;
  *) echo "Usage: $0 {apply|status}"; exit 2 ;;
esac
