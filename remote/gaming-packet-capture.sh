#!/usr/bin/env bash
# Deep packet capture for Xbox — JSON output for Warzone Sentinel inspection.
set -euo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
CONF="${TOOLS_DIR}/gaming.conf"
if [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi

TARGET_IP="${1:-${XBOX_IP:-}}"
COUNT="${2:-400}"
LAN="${LAN_IF:-br2}"

if [[ -z "$TARGET_IP" ]]; then
  echo '{"error":"XBOX_IP not configured"}'
  exit 2
fi

exec python3 - "$TARGET_IP" "$LAN" "$COUNT" "${XBOX_MAC:-}" <<'PY'
import json
import re
import subprocess
import sys
from datetime import datetime, timezone

target_ip, lan, count_s, xbox_mac = sys.argv[1:5]
count = max(50, min(int(count_s), 800))
xbox_mac = (xbox_mac or "").upper().replace("-", ":")


def run(cmd, timeout=8):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except Exception:
        return None


def parse_endpoint(raw):
    raw = raw.rstrip(":")
    if "." in raw and ":" not in raw.split(".")[-1]:
        return raw.rsplit(".", 1)[0]
    if raw.count(":") > 1 and raw.rsplit(":", 1)[-1].isdigit():
        return raw.rsplit(":", 1)[0]
    return raw


def host_port(raw):
    host = parse_endpoint(raw)
    port = None
    if "." in raw and ":" not in raw.split(".")[-1]:
        tail = raw.rsplit(".", 1)[-1]
        if tail.isdigit():
            port = int(tail)
    elif raw.count(":") > 1 and raw.rsplit(":", 1)[-1].isdigit():
        port = int(raw.rsplit(":", 1)[-1])
    return host, port


def addr_match(addr, targets):
    return addr in targets or any(addr == t for t in targets)


def parse_line(line, targets):
    if " IP " not in line and " IP6 " not in line:
        return None
    parts = line.split()
    if len(parts) < 6:
        return None
    try:
        length = int(parts[-1])
    except ValueError:
        length = 0
    src_raw, dst_raw = parts[2], parts[4]
    src, src_port = host_port(src_raw)
    dst, dst_port = host_port(dst_raw)
    tail = " ".join(parts[5:-2]) if len(parts) > 6 else ""
    proto = "unknown"
    flags = ""
    if " UDP" in tail or tail.startswith("UDP"):
        proto = "udp"
    elif " TCP" in tail or tail.startswith("TCP"):
        proto = "tcp"
        m = re.search(r"\[([^\]]+)\]", tail)
        if m:
            flags = m.group(1)
    elif " ICMP" in tail or tail.startswith("ICMP"):
        proto = "icmp"
    if addr_match(src, targets) or addr_match(src_raw, targets):
        direction = "out"
        remote = dst
        local_port, remote_port = src_port, dst_port
    elif addr_match(dst, targets) or addr_match(dst_raw, targets):
        direction = "in"
        remote = src
        local_port, remote_port = dst_port, src_port
    else:
        return None
    return {
        "dir": direction,
        "proto": proto,
        "len": length,
        "remote": remote,
        "localPort": local_port,
        "remotePort": remote_port,
        "flags": flags,
    }


targets = [target_ip]
proc = run(["sudo", "-n", "tcpdump", "-ni", lan, "-q", "-c", str(count), f"host {target_ip}"])
lines = proc.stdout.splitlines() if proc and proc.stdout else []
records = []
flows = {}
for line in lines:
    pkt = parse_line(line, targets)
    if not pkt:
        continue
    records.append({k: v for k, v in pkt.items() if v not in (None, "")})
    key = (pkt["dir"], pkt["remote"], pkt["proto"])
    if key not in flows:
        flows[key] = {"bytes": 0, "packets": 0, "sizes": []}
    flows[key]["bytes"] += pkt["len"]
    flows[key]["packets"] += 1
    flows[key]["sizes"].append(pkt["len"])

flow_rows = []
for (direction, remote, proto), agg in flows.items():
    sizes = agg["sizes"]
    flow_rows.append({
        "direction": direction,
        "remote": remote,
        "proto": proto,
        "bytes": agg["bytes"],
        "packets": agg["packets"],
        "avgSize": round(agg["bytes"] / max(agg["packets"], 1)),
        "minSize": min(sizes) if sizes else 0,
        "maxSize": max(sizes) if sizes else 0,
    })
flow_rows.sort(key=lambda x: x["bytes"], reverse=True)

in_recs = [r for r in records if r["dir"] == "in"]
out_recs = [r for r in records if r["dir"] == "out"]
in_remotes = {r["remote"] for r in in_recs if r.get("remote")}

payload = {
    "timestamp": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
    "xboxIp": target_ip,
    "captureCount": count,
    "captured": len(records),
    "records": records[:200],
    "flows": flow_rows[:40],
    "stats": {
        "total": len(records),
        "inbound": len(in_recs),
        "outbound": len(out_recs),
        "tinyInbound": sum(1 for r in in_recs if r["len"] < 80),
        "largeInbound": sum(1 for r in in_recs if r["len"] > 1200),
        "uniqueInboundRemotes": len(in_remotes),
        "udpInbound": sum(1 for r in in_recs if r["proto"] == "udp"),
        "tcpSynInbound": sum(1 for r in in_recs if r["proto"] == "tcp" and "S" in r.get("flags", "")),
        "avgInboundSize": round(sum(r["len"] for r in in_recs) / len(in_recs), 1) if in_recs else 0,
        "avgOutboundSize": round(sum(r["len"] for r in out_recs) / len(out_recs), 1) if out_recs else 0,
    },
}
print(json.dumps(payload))
PY
