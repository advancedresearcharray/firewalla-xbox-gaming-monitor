#!/usr/bin/env bash
# Push gaming-tools scripts to Firewalla via LAN API (no SSH).
#
#   FIREWALLA_API_URL=http://A.A.A.A:9378 FIREWALLA_API_TOKEN=... ./scripts/push-firewalla-tools-api.sh
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${GAMING_TOOLS_SRC:-$ROOT_DIR}"
FIREWALLA_API_URL="${FIREWALLA_API_URL:?Set FIREWALLA_API_URL}"
TOKEN_FILE="${FIREWALLA_API_TOKEN_FILE:-/root/.secrets/firewalla-api.env}"

if [[ -f "$TOKEN_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$TOKEN_FILE"
fi
if [[ -z "${FIREWALLA_API_TOKEN:-}" ]]; then
  echo "Set FIREWALLA_API_TOKEN or create $TOKEN_FILE" >&2
  exit 1
fi

api_update() {
  local name="$1"
  local file="$2"
  local mode="${3:-755}"
  local b64
  b64="$(base64 -w0 "$file")"
  curl -sS -m 120 \
    -H "Authorization: Bearer ${FIREWALLA_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -X POST "${FIREWALLA_API_URL%/}/api/v1/tools/update" \
    -d "{\"name\":\"${name}\",\"content\":\"${b64}\",\"mode\":\"${mode}\"}"
  echo
}

echo "[firewalla-tools] Push via ${FIREWALLA_API_URL} (no SSH)"
for script in gaming-snapshot.sh gaming-role-qos.sh gaming-route-probe.sh gaming-route-enforce.sh \
  gaming-bandwidth-qos.sh gaming-buffer-tune.sh gaming-dns-policy.sh xbox-scope.sh \
  gaming-nat-check.sh gaming-mtu-probe.sh gaming-offload-audit.sh gaming-firewalla-tune.sh \
  gaming-processor-tune.sh gaming-link-status.sh gaming-flood-guard.sh; do
  echo "  $script"
  api_update "$script" "$SRC/remote/$script" 755
done
echo "  route-probes.json"
api_update "route-probes.json" "$SRC/data/route-probes.json" 644
echo "[firewalla-tools] Done"
