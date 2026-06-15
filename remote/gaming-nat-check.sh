#!/usr/bin/env bash
# Assess Xbox NAT readiness from Firewalla (UPnP, WAN topology, STUN).
set -euo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
CONF="${TOOLS_DIR}/gaming.conf"
if [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi
# shellcheck disable=SC1091
source "${TOOLS_DIR}/xbox-scope.sh"

exec python3 - "${XBOX_IP:-}" "${XBOX_MAC:-}" "${LAN_IF:-br2}" <<'PY'
import ipaddress
import json
import re
import socket
import struct
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.request import urlopen

xbox_ip, xbox_mac, lan_if = sys.argv[1:4]
xbox_mac = (xbox_mac or "").upper().replace("-", ":")

XBOX_PORTS = {3074, 88, 500, 3544, 4500, 2869}


def run(cmd, timeout=6):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        return proc.stdout.strip(), proc.returncode
    except Exception:
        return "", 1


def wan_info():
    out, _ = run(["ip", "route", "get", "8.8.8.8"])
    wan_ip = ""
    gateway = ""
    iface = ""
    for token in out.split():
        if token == "src" and "src" in out:
            idx = out.split().index("src")
            if idx + 1 < len(out.split()):
                wan_ip = out.split()[idx + 1]
        if token == "via":
            idx = out.split().index("via")
            gateway = out.split()[idx + 1]
        if token == "dev":
            idx = out.split().index("dev")
            iface = out.split()[idx + 1]
    public_ip = ""
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip"):
        try:
            with urlopen(url, timeout=4) as resp:
                public_ip = resp.read().decode().strip()
                if public_ip:
                    break
        except Exception:
            pass
    wan_private = False
    double_nat = False
    try:
        if wan_ip:
            wan_private = ipaddress.ip_address(wan_ip).is_private
    except ValueError:
        pass
    if wan_private:
        double_nat = True
    if public_ip and wan_ip and public_ip != wan_ip and wan_private:
        double_nat = True
    return {
        "wanIp": wan_ip or None,
        "wanGateway": gateway or None,
        "wanIface": iface or None,
        "publicIp": public_ip or None,
        "wanPrivate": wan_private,
        "doubleNat": double_nat,
    }


def parse_upnp_mappings():
    mappings = []
    for chain in (f"UPNP_PR_{lan_if}", f"UPNP_{lan_if}", "UPNP_PR_br0", "UPNP_br0"):
        out, _ = run(["sudo", "iptables", "-t", "nat", "-S", chain])
        for line in out.splitlines():
            if "DNAT" not in line and "REDIRECT" not in line:
                continue
            parts = line.split()
            proto = ""
            ext_port = ""
            int_ip = ""
            int_port = ""
            for i, p in enumerate(parts):
                if p in ("-p", "--protocol") and i + 1 < len(parts):
                    proto = parts[i + 1].lower()
                if p in ("--dport", "-m", "multiport") and "--dport" in line:
                    m = re.search(r"--dport[s]?\s+(\d+)", line)
                    if m:
                        ext_port = m.group(1)
                if p == "DNAT" or p == "REDIRECT":
                    m = re.search(r"--to-destination\s+([^:\s]+):?(\d+)?", line)
                    if m:
                        int_ip = m.group(1)
                        int_port = m.group(2) or ext_port
            if not int_ip and xbox_ip in line:
                int_ip = xbox_ip
            if int_ip == xbox_ip or (not int_ip and xbox_ip in line):
                mappings.append(
                    {
                        "proto": proto or "tcp",
                        "externalPort": int(ext_port) if ext_port.isdigit() else None,
                        "internalIp": int_ip or xbox_ip,
                        "internalPort": int(int_port) if str(int_port).isdigit() else None,
                        "chain": chain,
                    }
                )
    lease_out, _ = run(["sudo", "find", "/var/lib/miniupnpd", "-type", "f", "-maxdepth", "2"])
    for path in lease_out.splitlines():
        if not path:
            continue
        body, _ = run(["sudo", "cat", path], timeout=2)
        if xbox_ip in body:
            mappings.append({"source": "miniupnpd", "raw": body[:200]})
    for path in ("/var/run/upnp.br2.leases", "/var/run/upnp.br0.leases"):
        body, _ = run(["sudo", "cat", path], timeout=2)
        for line in body.splitlines():
            if xbox_ip not in line:
                continue
            parts = line.split(":")
            if len(parts) < 4:
                continue
            mappings.append(
                {
                    "proto": parts[0].lower(),
                    "externalPort": int(parts[1]) if parts[1].isdigit() else None,
                    "internalIp": parts[2],
                    "internalPort": int(parts[3]) if parts[3].isdigit() else None,
                    "source": path,
                    "description": line,
                }
            )
    return mappings


def stun_nat_behavior():
    """Binding test against Google STUN — reflects Firewalla WAN NAT, not Xbox directly."""
    server = ("stun.l.google.com", 19302)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(3)
    try:
        tid = struct.pack("!III", 0x2112A442, 0, 0)
        req = struct.pack("!HHI", 0x0001, 0, 0x2112A442) + tid
        sock.sendto(req, server)
        data, _ = sock.recvfrom(512)
        if len(data) < 20:
            return {"ok": False, "detail": "short response"}
        msg_type, msg_len, magic = struct.unpack("!HHI", data[:8])
        if magic != 0x2112A442:
            return {"ok": False, "detail": "bad magic"}
        mapped = None
        off = 20
        while off + 4 <= len(data):
            atype, alen = struct.unpack("!HH", data[off : off + 4])
            aval = data[off + 4 : off + 4 + alen]
            off += 4 + alen
            if atype in (0x0001, 0x0020) and alen >= 8:
                port = struct.unpack("!H", aval[2:4])[0]
                ip = socket.inet_ntoa(aval[4:8])
                mapped = f"{ip}:{port}"
        sock2 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock2.settimeout(3)
        sock2.bind(("0.0.0.0", 0))
        tid2 = struct.pack("!III", 0x2112A443, 0, 0)
        req2 = struct.pack("!HHI", 0x0001, 0, 0x2112A442) + tid2
        sock2.sendto(req2, server)
        data2, _ = sock2.recvfrom(512)
        mapped2 = None
        off = 20
        while off + 4 <= len(data2):
            atype, alen = struct.unpack("!HH", data2[off : off + 4])
            aval = data2[off + 4 : off + 4 + alen]
            off += 4 + alen
            if atype in (0x0001, 0x0020) and alen >= 8:
                port = struct.unpack("!H", aval[2:4])[0]
                ip = socket.inet_ntoa(aval[4:8])
                mapped2 = f"{ip}:{port}"
        behavior = "unknown"
        if mapped and mapped2:
            behavior = "symmetric" if mapped != mapped2 else "cone"
        return {"ok": True, "mappedEndpoint": mapped, "behavior": behavior}
    except Exception as exc:
        return {"ok": False, "detail": str(exc)}
    finally:
        sock.close()


def xbox_live_port_hits():
    hits = []
    out, _ = run(["sudo", "conntrack", "-L", "-s", xbox_ip], timeout=4)
    if not out:
        out, _ = run(["sudo", "cat", "/proc/net/nf_conntrack"], timeout=4)
    for port in sorted(XBOX_PORTS):
        if re.search(rf"dport={port}\b|sport={port}\b", out):
            hits.append(port)
    return hits


def classify_nat(wan, upnp, stun):
    score = 0
    issues = []
    if wan.get("doubleNat"):
        issues.append("Double NAT detected on Firewalla WAN (private upstream gateway)")
        score += 2
    xbox_maps = [m for m in upnp if m.get("internalIp") == xbox_ip or xbox_ip in (m.get("description") or m.get("raw") or "")]
    if xbox_maps:
        score -= 2
    else:
        issues.append("No UPnP port mappings for Xbox on Firewalla")
        score += 1
    if stun.get("ok") and stun.get("behavior") == "symmetric":
        if not wan.get("doubleNat"):
            issues.append("WAN NAT is symmetric (STUN) — IPv4 inbound can be harder; IPv6 may still be Open")
            score += 1
        else:
            issues.append("Firewalla WAN uses symmetric NAT (STUN) — harder for inbound peers")
            score += 2
    elif stun.get("ok") and stun.get("behavior") == "cone":
        score -= 1

    if score <= 0 and not wan.get("doubleNat"):
        nat_type = "open"
        xbox_equiv = "Open"
    elif score <= 1:
        nat_type = "moderate"
        xbox_equiv = "Moderate"
    else:
        nat_type = "strict"
        xbox_equiv = "Strict"

    return nat_type, xbox_equiv, issues


wan = wan_info()
upnp = parse_upnp_mappings()
stun = stun_nat_behavior()
port_hits = xbox_live_port_hits()
nat_type, xbox_equiv, issues = classify_nat(wan, upnp, stun)

payload = {
    "timestamp": datetime.now(timezone.utc).astimezone().isoformat(),
    "xboxIp": xbox_ip,
    "xboxMac": xbox_mac,
    "natType": nat_type,
    "xboxNatEquivalent": xbox_equiv,
    "wan": wan,
    "upnp": {
        "enabled": True,
        "xboxMappings": [m for m in upnp if m.get("internalIp") == xbox_ip or xbox_ip in (m.get("description") or m.get("raw") or "")],
        "totalMappings": len(upnp),
    },
    "stun": stun,
    "xboxLivePortsSeen": port_hits,
    "issues": issues,
    "healthy": nat_type == "open" and not wan.get("doubleNat"),
    "detail": (
        f"Estimated {xbox_equiv} — "
        + ("double NAT; " if wan.get("doubleNat") else "")
        + (f"{len(upnp)} UPnP mapping(s); " if upnp else "no UPnP mappings; ")
        + (f"STUN {stun.get('behavior', 'n/a')}" if stun.get("ok") else "STUN unavailable")
    ),
}
print(json.dumps(payload, separators=(",", ":")))
PY
