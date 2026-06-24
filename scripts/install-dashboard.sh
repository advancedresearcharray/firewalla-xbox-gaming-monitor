#!/usr/bin/env bash
# Install the web dashboard on a Linux host — Firewalla via LAN API only (no SSH).
#
# Usage:
#   sudo FIREWALLA_API_TOKEN=... ./scripts/install-dashboard.sh
#   sudo ./scripts/install-dashboard.sh   # reads /root/.secrets/firewalla-api.env if present
#
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/xbox-traffic-monitor}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOKEN_FILE="${FIREWALLA_API_TOKEN_FILE:-/root/.secrets/firewalla-api.env}"
PORT="${PORT:-9377}"

: "${FIREWALLA_API_URL:?Set FIREWALLA_API_URL (e.g. http://A.A.A.A:9378)}"
: "${XBOX_IP:?Set XBOX_IP (e.g. B.B.B.B)}"

need_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "Run with sudo"; exit 1; }; }
need_root

if [[ -f "$TOKEN_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$TOKEN_FILE"
fi
if [[ -z "${FIREWALLA_API_TOKEN:-}" ]]; then
  echo "Set FIREWALLA_API_TOKEN or create ${TOKEN_FILE}" >&2
  exit 1
fi

if ! command -v node >/dev/null; then
  echo "Node.js 20+ required. Install: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs"
  exit 1
fi

echo "[dashboard] Verify Firewalla LAN API at ${FIREWALLA_API_URL}"
curl -sS -m 10 "${FIREWALLA_API_URL%/}/api/health" | grep -q '"ok"' || {
  echo "Firewalla API not reachable — install array-firewalla-api on the box first" >&2
  exit 1
}

echo "[dashboard] Installing to ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR"/{lib,data,public}
cp "$REPO_ROOT/server.mjs" "$INSTALL_DIR/"
cp "$REPO_ROOT/package.json" "$INSTALL_DIR/"
cp "$REPO_ROOT/lib/"*.mjs "$INSTALL_DIR/lib/"
cp "$REPO_ROOT/data/"*.json "$INSTALL_DIR/data/"
cp "$REPO_ROOT/public/"* "$INSTALL_DIR/public/"
cp "$REPO_ROOT/deploy/xbox-traffic-monitor.service" /etc/systemd/system/

cat > /etc/default/xbox-traffic-monitor <<EOF
PORT=${PORT}
POLL_MS=8000
NETWORK_HEALTH_MS=1800000
FIREWALLA_API_URL=${FIREWALLA_API_URL}
FIREWALLA_API_TOKEN=${FIREWALLA_API_TOKEN}
FIREWALLA_CORES=4
REMOTE_SCRIPT=/home/pi/gaming-tools/gaming-snapshot.sh
REMOTE_QOS=/home/pi/gaming-tools/gaming-role-qos.sh
REMOTE_BANDWIDTH=/home/pi/gaming-tools/gaming-bandwidth-qos.sh
REMOTE_BUFFER=/home/pi/gaming-tools/gaming-buffer-tune.sh
REMOTE_DNS=/home/pi/gaming-tools/gaming-dns-policy.sh
REMOTE_ROUTE=/home/pi/gaming-tools/gaming-route-probe.sh
REMOTE_ENFORCE=/home/pi/gaming-tools/gaming-route-enforce.sh
REMOTE_NAT=/home/pi/gaming-tools/gaming-nat-check.sh
REMOTE_MTU=/home/pi/gaming-tools/gaming-mtu-probe.sh
REMOTE_OFFLOAD=/home/pi/gaming-tools/gaming-offload-audit.sh
REMOTE_PROCESSOR_TUNE=/home/pi/gaming-tools/gaming-processor-tune.sh
REMOTE_FIREWALLA_TUNE=/home/pi/gaming-tools/gaming-firewalla-tune.sh
REMOTE_FLOOD_GUARD=/home/pi/gaming-tools/gaming-flood-guard.sh
XBOX_IP=${XBOX_IP}
EOF
chmod 600 /etc/default/xbox-traffic-monitor

systemctl daemon-reload
systemctl enable xbox-traffic-monitor.service
systemctl restart xbox-traffic-monitor.service
sleep 2
systemctl is-active xbox-traffic-monitor.service

IP="$(hostname -I | awk '{print $1}')"
echo ""
echo "[dashboard] Running at http://${IP}:${PORT}/"
echo "[dashboard] Health:  http://${IP}:${PORT}/api/health"
echo "[dashboard] Firewalla: ${FIREWALLA_API_URL} (API only, no SSH)"
