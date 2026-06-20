#!/usr/bin/env bash
# Deploy Array Folding Compression Engine to dashboard LXC (guide v2 §4–§8).
# Container-only — never on Firewalla host.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${XBOX_MONITOR_SRC:-$ROOT_DIR}"
CTID="${ARRAY_COMPRESSION_CTID:-${XBOX_MONITOR_CTID:-933}}"
PROXMOX_NODE="${PROXMOX_NODE:-192.168.167.9}"
INSTALL_DIR="/opt/array-compression"
PORT="${ARRAY_COMPRESSION_PORT:-8200}"

run_pct() {
  if command -v pct >/dev/null 2>&1 && pct status "$CTID" &>/dev/null; then
    pct "$@"
  else
    ssh "root@${PROXMOX_NODE}" pct "$@"
  fi
}

push_file() {
  local local_path="$1"
  local remote_path="$2"
  if command -v pct >/dev/null 2>&1 && pct status "$CTID" &>/dev/null; then
    pct push "$CTID" "$local_path" "$remote_path"
  else
    ssh "root@${PROXMOX_NODE}" "pct exec ${CTID} -- mkdir -p $(dirname "$remote_path")"
    cat "$local_path" | ssh "root@${PROXMOX_NODE}" "pct exec ${CTID} -- tee ${remote_path} >/dev/null"
  fi
}

if ! run_pct status "$CTID" &>/dev/null; then
  echo "CT ${CTID} not found" >&2
  exit 1
fi

echo "[array-compression] Push to CT${CTID}:${INSTALL_DIR}"
run_pct exec "$CTID" -- mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/deploy" /opt/arrayfolding
push_file "$SRC/array-compression/server.py" "$INSTALL_DIR/server.py"
push_file "$SRC/array-compression/requirements.txt" "$INSTALL_DIR/requirements.txt"
push_file "$SRC/array-compression/deploy/config.env.example" "$INSTALL_DIR/deploy/config.env.example"
push_file "$SRC/array-compression/deploy/array-compression.service" /etc/systemd/system/array-compression.service

if [[ -f /opt/arrayfolding/arrayfolding-1.0.0-py3-none-any.whl ]]; then
  echo "[array-compression] Push SDK wheel from /opt/arrayfolding"
  push_file /opt/arrayfolding/arrayfolding-1.0.0-py3-none-any.whl /opt/arrayfolding/arrayfolding-1.0.0-py3-none-any.whl
fi
if [[ -f /opt/arrayfolding/libarray_core.so ]]; then
  push_file /opt/arrayfolding/libarray_core.so /opt/arrayfolding/libarray_core.so
fi

run_pct exec "$CTID" -- bash -s <<REMOTE
set -euo pipefail
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-numpy >/dev/null
pip3 install -r ${INSTALL_DIR}/requirements.txt --break-system-packages -q
if [[ -f /opt/arrayfolding/arrayfolding-1.0.0-py3-none-any.whl ]]; then
  pip3 install /opt/arrayfolding/arrayfolding-1.0.0-py3-none-any.whl --break-system-packages -q || true
fi
if [[ ! -f /etc/default/array-compression ]]; then
  install -m 600 ${INSTALL_DIR}/deploy/config.env.example /etc/default/array-compression
fi
systemctl daemon-reload
systemctl enable array-compression.service
systemctl restart array-compression.service
sleep 2
systemctl is-active array-compression.service
curl -sS -m 5 http://127.0.0.1:${PORT}/ | head -c 200
echo
REMOTE

IP="$(run_pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "[array-compression] Running at http://${IP:-?}:${PORT}/"
echo "[array-compression] Set on dashboard: ARRAY_COMPRESSION_URL=http://127.0.0.1:${PORT}"
echo "[array-compression] Install SDK wheel to /opt/arrayfolding on host, re-run to push native engine"
