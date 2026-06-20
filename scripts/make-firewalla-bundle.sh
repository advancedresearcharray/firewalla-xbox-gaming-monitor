#!/usr/bin/env bash
# Create a tarball of gaming-tools for manual on-box install (offline fallback).
# Normal deploy uses LAN API — see scripts/push-firewalla-tools-api.sh
#
# Usage:
#   ./scripts/make-firewalla-bundle.sh
#   # Copy tarball to Firewalla via console/USB, then on-box:
#   tar xzf firewalla-gaming-tools-*.tar.gz && cd firewalla-gaming-tools && bash install-on-firewalla.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo 1.0.0)"
OUT="$REPO_ROOT/dist/firewalla-gaming-tools-${VERSION}.tar.gz"
WORKDIR="$(mktemp -d)"
BUNDLE="$WORKDIR/firewalla-gaming-tools"

mkdir -p "$REPO_ROOT/dist" "$BUNDLE"
cp "$REPO_ROOT/remote/"*.sh "$BUNDLE/"
cp "$REPO_ROOT/data/route-probes.json" "$BUNDLE/"
cp "$REPO_ROOT/deploy/gaming.conf.example" "$BUNDLE/"
cp "$REPO_ROOT/scripts/install-on-firewalla.sh" "$BUNDLE/"
chmod +x "$BUNDLE/"*.sh

tar -czf "$OUT" -C "$WORKDIR" firewalla-gaming-tools
rm -rf "$WORKDIR"

echo "Created: $OUT"
echo ""
echo "Preferred: push over LAN API (no SSH):"
echo "  FIREWALLA_API_URL=http://A.A.A.A:9378 FIREWALLA_API_TOKEN=... ./scripts/push-firewalla-tools-api.sh"
echo ""
echo "Offline fallback: copy tarball to Firewalla and run install-on-firewalla.sh on-box."
