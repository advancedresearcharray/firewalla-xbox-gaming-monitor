#!/usr/bin/env bash
# Install gaming monitor scripts on Firewalla Gold / Purple.
#
# Run ON Firewalla as pi (after copying files), OR from repo via:
#   ./scripts/install-on-firewalla.sh
#
set -euo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Support flat bundle layout (all .sh files in same dir as this script)
if [[ -f "$SCRIPT_DIR/gaming-snapshot.sh" ]]; then
  REMOTE_SRC="$SCRIPT_DIR"
  DATA_DIR="$SCRIPT_DIR"
elif [[ -f "$REPO_ROOT/remote/gaming-snapshot.sh" ]]; then
  REMOTE_SRC="$REPO_ROOT/remote"
  DATA_DIR="$REPO_ROOT/data"
else
  echo "Cannot find gaming-snapshot.sh — run from repo or bundle directory" >&2
  exit 1
fi

echo "[firewalla] Installing gaming tools to ${TOOLS_DIR}"
mkdir -p "$TOOLS_DIR"

install -m 755 "$REMOTE_SRC/gaming-snapshot.sh" "$TOOLS_DIR/gaming-snapshot.sh"
install -m 755 "$REMOTE_SRC/gaming-role-qos.sh" "$TOOLS_DIR/gaming-role-qos.sh"
install -m 755 "$REMOTE_SRC/gaming-bandwidth-qos.sh" "$TOOLS_DIR/gaming-bandwidth-qos.sh"
install -m 755 "$REMOTE_SRC/gaming-dns-policy.sh" "$TOOLS_DIR/gaming-dns-policy.sh"
install -m 755 "$REMOTE_SRC/xbox-scope.sh" "$TOOLS_DIR/xbox-scope.sh"
install -m 755 "$REMOTE_SRC/gaming-route-probe.sh" "$TOOLS_DIR/gaming-route-probe.sh"
install -m 755 "$REMOTE_SRC/gaming-route-enforce.sh" "$TOOLS_DIR/gaming-route-enforce.sh"
install -m 755 "$REMOTE_SRC/gaming-nat-check.sh" "$TOOLS_DIR/gaming-nat-check.sh"
install -m 755 "$REMOTE_SRC/gaming-mtu-probe.sh" "$TOOLS_DIR/gaming-mtu-probe.sh"
install -m 755 "$REMOTE_SRC/gaming-firewalla-tune.sh" "$TOOLS_DIR/gaming-firewalla-tune.sh"
install -m 644 "$DATA_DIR/route-probes.json" "$TOOLS_DIR/route-probes.json"

CONF_EXAMPLE="$REPO_ROOT/deploy/gaming.conf.example"
[[ -f "$SCRIPT_DIR/gaming.conf.example" ]] && CONF_EXAMPLE="$SCRIPT_DIR/gaming.conf.example"

if [[ ! -f "$TOOLS_DIR/gaming.conf" ]]; then
  install -m 644 "$CONF_EXAMPLE" "$TOOLS_DIR/gaming.conf"
  echo "[firewalla] Created $TOOLS_DIR/gaming.conf — edit XBOX_IP and XBOX_MAC"
else
  echo "[firewalla] Keeping existing $TOOLS_DIR/gaming.conf"
fi

echo ""
echo "[firewalla] Quick test:"
echo "  nano $TOOLS_DIR/gaming.conf"
echo "  bash $TOOLS_DIR/gaming-snapshot.sh | head -c 400"
echo ""
echo "[firewalla] QoS / route enforcement (sudo):"
echo "  sudo $TOOLS_DIR/gaming-role-qos.sh status"
echo "  sudo $TOOLS_DIR/gaming-bandwidth-qos.sh status"
echo "  sudo $TOOLS_DIR/gaming-dns-policy.sh status"
