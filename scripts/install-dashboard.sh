#!/usr/bin/env bash
# Install the web dashboard on a Linux host (LXC, VM, Raspberry Pi, etc.)
# The dashboard SSHes to Firewalla to poll gaming-snapshot.sh.
#
# Usage:
#   sudo ./scripts/install-dashboard.sh
#
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/xbox-traffic-monitor}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIREWALLA_HOST="${FIREWALLA_HOST:-192.168.1.1}"
FIREWALLA_USER="${FIREWALLA_USER:-pi}"
XBOX_IP="${XBOX_IP:-192.168.1.100}"
PORT="${PORT:-9377}"

need_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "Run with sudo"; exit 1; }; }
need_root

if ! command -v node >/dev/null; then
  echo "Node.js 20+ required. Install: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs"
  exit 1
fi

echo "[dashboard] Installing to ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR"/{lib,data,public,remote}
cp "$REPO_ROOT/server.mjs" "$INSTALL_DIR/"
cp "$REPO_ROOT/package.json" "$INSTALL_DIR/"
cp "$REPO_ROOT/lib/"*.mjs "$INSTALL_DIR/lib/"
cp "$REPO_ROOT/data/"*.json "$INSTALL_DIR/data/"
cp "$REPO_ROOT/public/"* "$INSTALL_DIR/public/"
cp "$REPO_ROOT/deploy/xbox-traffic-monitor.service" /etc/systemd/system/

KEY="/root/.ssh/firewalla-gaming-monitor"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [[ ! -f "$KEY" ]]; then
  ssh-keygen -t ed25519 -N "" -f "$KEY" -C "xbox-gaming-monitor" >/dev/null
  echo ""
  echo "=== Add this SSH public key to Firewalla pi user authorized_keys ==="
  cat "${KEY}.pub"
  echo "==================================================================="
  echo "  ssh pi@${FIREWALLA_HOST}"
  echo "  mkdir -p ~/.ssh && echo '<paste key>' >> ~/.ssh/authorized_keys"
  echo ""
  read -r -p "Press Enter after adding the key to Firewalla..."
fi
ssh-keyscan -H "$FIREWALLA_HOST" >> /root/.ssh/known_hosts 2>/dev/null || true

cat > /etc/default/xbox-traffic-monitor <<EOF
PORT=${PORT}
POLL_MS=2500
FIREWALLA_HOST=${FIREWALLA_HOST}
FIREWALLA_USER=${FIREWALLA_USER}
FIREWALLA_SSH_KEY=${KEY}
REMOTE_SCRIPT=/home/pi/gaming-tools/gaming-snapshot.sh
REMOTE_QOS=/home/pi/gaming-tools/gaming-role-qos.sh
REMOTE_ROUTE=/home/pi/gaming-tools/gaming-route-probe.sh
REMOTE_ENFORCE=/home/pi/gaming-tools/gaming-route-enforce.sh
XBOX_IP=${XBOX_IP}
EOF

systemctl daemon-reload
systemctl enable xbox-traffic-monitor.service
systemctl restart xbox-traffic-monitor.service
sleep 2
systemctl is-active xbox-traffic-monitor.service

IP="$(hostname -I | awk '{print $1}')"
echo ""
echo "[dashboard] Running at http://${IP}:${PORT}/"
echo "[dashboard] Health:  http://${IP}:${PORT}/api/health"
