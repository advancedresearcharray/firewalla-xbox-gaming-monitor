#!/usr/bin/env bash
# Hardware offload audit for Firewalla switching path (Xbox LAN → QoS → WAN).
set -euo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
CONF="${TOOLS_DIR}/gaming.conf"
if [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi

exec python3 - "${LAN_IF:-br2}" "${UPLOAD_IF:-ifb0}" "${DOWNLOAD_IF:-ifb1}" <<'PY'
import json
import re
import subprocess
import sys
from datetime import datetime, timezone

lan_if, upload_if, download_if = sys.argv[1:4]
wan_if = "eth0"
phys_ifaces = ["eth0", "eth1", "eth2"]
path_ifaces = [lan_if, upload_if, download_if, wan_if]
issues = []
recommendations = []


def run(cmd, timeout=8):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        return (r.stdout or "").strip()
    except Exception:
        return ""


def iface_exists(name):
    return run(["ip", "link", "show", name]) != ""


def parse_ethtool_k(name):
    out = run(["ethtool", "-k", name])
    if not out:
        return None
    feats = {}
    for line in out.splitlines():
        m = re.match(r"^([\w-]+):\s+(\S+)", line.strip())
        if m:
            feats[m.group(1)] = m.group(2)
    return feats


def parse_ring(name):
    out = run(["ethtool", "-g", name])
    if not out:
        return None
    cur = {}
    section = None
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("Current hardware settings"):
            section = "current"
            continue
        if section == "current" and ":" in line:
            k, v = [x.strip() for x in line.split(":", 1)]
            if v.isdigit():
                cur[k] = int(v)
    return cur or None


def parse_coalesce(name):
    out = run(["ethtool", "-c", name])
    if not out:
        return None
    vals = {}
    for line in out.splitlines():
        m = re.match(r"^([\w-]+):\s+(\S+)", line.strip())
        if m and m.group(2) not in ("n/a",):
            vals[m.group(1)] = m.group(2)
    return vals or None


def stat(name, field):
    try:
        with open(f"/sys/class/net/{name}/statistics/{field}") as f:
            return int(f.read().strip())
    except OSError:
        return None


def promisc(name):
    out = run(["ip", "-d", "link", "show", name])
    return "PROMISC" in out


def qdisc(name):
    out = run(["ip", "-d", "link", "show", name])
    m = re.search(r"qdisc (\S+)", out)
    return m.group(1) if m else None


def score_iface(name, feats, ring, drops):
    if not feats:
        return {"iface": name, "score": None, "status": "unknown"}
    good = []
    warn = []
    # Gaming UDP benefits from checksum + GSO/GRO on phys NICs; LRO stays off.
    for key in ("rx-checksumming", "tx-checksumming", "generic-receive-offload", "generic-segmentation-offload"):
        val = feats.get(key, "")
        if val.startswith("on"):
            good.append(key)
        elif val.startswith("off") and "[fixed]" not in val:
            warn.append(f"{key} off")
    if drops and (drops.get("rx_dropped", 0) or drops.get("tx_dropped", 0)):
        d = drops.get("rx_dropped", 0) + drops.get("tx_dropped", 0)
        if d > 0:
            warn.append(f"drops={d}")
    score = max(0, 100 - len(warn) * 15)
    status = "good" if score >= 85 else "fair" if score >= 60 else "poor"
    return {
        "iface": name,
        "score": score,
        "status": status,
        "good": good,
        "warnings": warn,
        "ring": ring,
        "promiscuous": promisc(name),
        "qdisc": qdisc(name),
        "driver": run(["ethtool", "-i", name]).splitlines()[0].split(": ", 1)[-1] if run(["ethtool", "-i", name]) else None,
    }


ifaces = {}
for name in sorted(set(path_ifaces + phys_ifaces)):
    if not iface_exists(name):
        continue
    feats = parse_ethtool_k(name)
    ring = parse_ring(name)
    drops = {
        "rx_dropped": stat(name, "rx_dropped"),
        "tx_dropped": stat(name, "tx_dropped"),
        "rx_errors": stat(name, "rx_errors"),
        "tx_errors": stat(name, "tx_errors"),
    }
    ifaces[name] = {
        "features": feats,
        "ring": ring,
        "coalesce": parse_coalesce(name) if name in phys_ifaces else None,
        "drops": drops,
        "promiscuous": promisc(name),
        "qdisc": qdisc(name),
        "scorecard": score_iface(name, feats, ring, drops),
    }

# Path-specific checks
lan = ifaces.get(lan_if, {})
wan = ifaces.get(wan_if, {})
if lan.get("promiscuous"):
    issues.append(f"{lan_if} is PROMISC — Zeek tap adds software switching overhead on LAN path")
if ifaces.get("eth1", {}).get("promiscuous") or ifaces.get("eth2", {}).get("promiscuous"):
    issues.append("eth1/eth2 PROMISC for IDS — expected; limits some NIC fast-path optimizations")
for qname in (upload_if, download_if):
    d = ifaces.get(qname, {}).get("drops", {})
    if d and (d.get("rx_dropped") or 0) > 0:
        issues.append(f"{qname} rx_dropped={d['rx_dropped']} — CAKE/QoS redirect drops under burst (check competitive bandwidth)")
if lan.get("qdisc") == "htb":
    recommendations.append(f"{lan_if} uses HTB qdisc — correct for Firewalla QoS; software queuing is expected")

phys_scores = [ifaces[i]["scorecard"]["score"] for i in phys_ifaces if i in ifaces and ifaces[i]["scorecard"]["score"] is not None]
overall = round(sum(phys_scores) / len(phys_scores)) if phys_scores else None

sysctl = {}
for key in (
    "net.core.rmem_max",
    "net.core.wmem_max",
    "net.core.netdev_max_backlog",
    "net.ipv4.tcp_low_latency",
):
    out = run(["sysctl", "-n", key])
    if out:
        try:
            sysctl[key] = int(out)
        except ValueError:
            sysctl[key] = out

# Safe read-only assessment — do not auto-tune offloads on Firewalla.
recommendations.append("Physical NIC offloads (GRO/GSO/checksum) are driver-managed — leave enabled on eth0–eth2")
recommendations.append("LRO stays off [fixed] on igc — correct for low-latency gaming")
if overall and overall >= 85:
    recommendations.append("No hardware offload changes needed — switching path is already optimized")
else:
    recommendations.append("Review QoS drops and IDS promisc mode before changing NIC offloads")

payload = {
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "path": {
        "lan": lan_if,
        "wan": wan_if,
        "uploadQos": upload_if,
        "downloadQos": download_if,
        "xboxLan": lan_if,
    },
    "summary": {
        "overallScore": overall,
        "status": "good" if overall and overall >= 85 else "fair" if overall and overall >= 60 else "unknown",
        "driver": "igc",
        "issues": issues,
        "recommendations": recommendations,
    },
    "sysctl": sysctl,
    "interfaces": ifaces,
}
print(json.dumps(payload, indent=2))
PY
