#!/usr/bin/env bash
# Lower CPU/IO priority for gaming-tools workloads on Firewalla.
set -euo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
RENICE="${GAMING_RENICE:-10}"
IONICE_CLASS="${GAMING_IONICE_CLASS:-2}"
IONICE_LEVEL="${GAMING_IONICE_LEVEL:-7}"

log() { printf '[processor-tune] %s\n' "$*"; }

apply_niceness() {
  local pattern="$1"
  local pids
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  [[ -n "$pids" ]] || return 0
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    renice -n "$RENICE" "$pid" 2>/dev/null || sudo renice -n "$RENICE" "$pid" 2>/dev/null || true
    ionice -c "$IONICE_CLASS" -n "$IONICE_LEVEL" -p "$pid" 2>/dev/null || \
      sudo ionice -c "$IONICE_CLASS" -n "$IONICE_LEVEL" -p "$pid" 2>/dev/null || true
    log "pid $pid ($pattern) renice=$RENICE ionice=${IONICE_CLASS}/${IONICE_LEVEL}"
  done <<< "$pids"
}

wrap_scripts() {
  for script in gaming-snapshot.sh gaming-route-probe.sh gaming-mtu-probe.sh gaming-nat-check.sh; do
    local path="${TOOLS_DIR}/${script}"
    [[ -x "$path" ]] || continue
    if ! head -n 3 "$path" | grep -q "processor-tune-wrapped"; then
      continue
    fi
  done
}

case "${1:-apply}" in
  apply)
    apply_niceness "gaming-snapshot.sh"
    apply_niceness "gaming-route-probe.sh"
    apply_niceness "gaming-mtu-probe.sh"
    apply_niceness "gaming-nat-check.sh"
    apply_niceness "gaming-firewalla-tune.sh"
    log "Done — gaming-tools processes deprioritized vs Zeek/FireMain"
    ;;
  status)
    ps -eo pid,ni,cls,pri,cmd | grep -E "gaming-|zeek|FireMain" | grep -v grep || true
    ;;
  *)
    echo "Usage: $0 {apply|status}"
    exit 2
    ;;
esac
