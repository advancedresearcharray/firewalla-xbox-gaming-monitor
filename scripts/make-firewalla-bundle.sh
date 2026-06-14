#!/usr/bin/env bash
# Create a single tarball for Firewalla team / manual install.
# Contains everything needed to run install-on-firewalla.sh on the box.
#
# Usage:
#   ./scripts/make-firewalla-bundle.sh
#   scp dist/firewalla-gaming-tools-*.tar.gz pi@firewalla:/tmp/
#   ssh pi@firewalla 'cd /tmp && tar xzf firewalla-gaming-tools-*.tar.gz && cd firewalla-gaming-tools && bash install-on-firewalla.sh'
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
echo "Send to Firewalla for testing:"
echo "  scp $OUT pi@<firewalla>:/tmp/"
echo "  ssh pi@<firewalla> 'cd /tmp && tar xzf $(basename "$OUT") && cd firewalla-gaming-tools && bash install-on-firewalla.sh'"
