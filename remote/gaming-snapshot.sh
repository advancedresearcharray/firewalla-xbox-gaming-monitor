#!/usr/bin/env bash
# One-shot JSON snapshot for Xbox traffic monitoring (runs on Firewalla).
set -euo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
CONF="${TOOLS_DIR}/gaming.conf"
if [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi

TARGET_IP="${1:-${XBOX_IP:-}}"
LAN="${LAN_IF:-br2}"
UPLOAD_IF="${UPLOAD_IF:-ifb0}"
DOWNLOAD_IF="${DOWNLOAD_IF:-ifb1}"

if [[ -z "$TARGET_IP" ]]; then
  echo '{"error":"XBOX_IP not configured"}'
  exit 2
fi

shift || true

exec python3 - "$TARGET_IP" "$LAN" "$UPLOAD_IF" "$DOWNLOAD_IF" "${XBOX_NAME:-Xbox}" "${XBOX_MAC:-}" "$TOOLS_DIR" "${WAN_PROBE_HOST:-one.one.one.one}" "$@" <<'PY'
import json
import ipaddress
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

target_ip, lan, upload_if, download_if, xbox_name, xbox_mac, tools_dir, wan_probe_host = sys.argv[1:9]
extra_args = sys.argv[9:]
wire_mode = "--wire" in extra_args
minimal_mode = "--minimal" in extra_args
critical_mode = "--critical" in extra_args
xbox_mac = (xbox_mac or "").upper().replace("-", ":")


def read_mem_available_mb():
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        return None


mem_available_mb = read_mem_available_mb()
if critical_mode:
    pressure_mode = "critical"
elif minimal_mode:
    pressure_mode = "minimal"
else:
    pressure_mode = "normal"

if pressure_mode == "normal" and mem_available_mb is not None:
    if mem_available_mb < 400:
        pressure_mode = "critical"
    elif mem_available_mb < 512:
        pressure_mode = "minimal"

LIMITS = {
    "normal": {
        "conn": 40,
        "dest": 50,
        "flows": 20,
        "top": 15,
        "ping": 999,
        "tcpdump": True,
        "conntrack": True,
        "redis_flows": 19,
    },
    "minimal": {
        "conn": 8,
        "dest": 12,
        "flows": 5,
        "top": 5,
        "ping": 4,
        "tcpdump": False,
        "conntrack": True,
        "redis_flows": 5,
    },
    "critical": {
        "conn": 8,
        "dest": 8,
        "flows": 0,
        "top": 0,
        "ping": 0,
        "tcpdump": False,
        "conntrack": False,
        "redis_flows": 0,
    },
}
lim = LIMITS[pressure_mode]


def trim_conn(c):
    return {
        "proto": c.get("proto"),
        "state": c.get("state"),
        "local": c.get("local"),
        "remote": c.get("remote"),
        "direction": c.get("direction"),
        "hostname": c.get("hostname"),
        "label": c.get("label"),
        "ip": c.get("ip"),
        "port": c.get("port"),
        "scope": c.get("scope"),
        "latencyMs": c.get("latencyMs"),
    }


def fold_conn_row(c):
    return [
        c.get("ip") or "",
        c.get("label") or c.get("hostname") or "",
        c.get("proto") or "",
        c.get("state") or "",
        c.get("latencyMs"),
    ]


def fold_dest_row(d):
    return [
        d.get("ip") or "",
        d.get("label") or "",
        d.get("kind") or "",
        d.get("latencyMs"),
    ]

def run(cmd, timeout=5):
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        ).stdout.strip()
    except Exception:
        return ""

def ping_ok(host):
    r = subprocess.run(
        ["ping", "-c", "1", "-W", "1", host],
        capture_output=True,
        timeout=3,
        check=False,
    )
    return r.returncode == 0

def is_private_ip(value):
    raw = value.split("%")[0]
    try:
        ip = ipaddress.ip_address(raw)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        return True

def split_remote(remote):
    if remote.startswith("["):
        m = re.match(r"^\[(.+)\]:(\d+)$", remote)
        if m:
            return m.group(1), m.group(2)
    if remote.count(":") > 1:
        host, port = remote.rsplit(":", 1)
        return host, port
    if ":" in remote:
        host, port = remote.rsplit(":", 1)
        return host, port
    return remote, ""

def parse_ping_ms(output):
    for line in output.splitlines():
        if "time=" in line:
            m = re.search(r"time[=<]([\d.]+)", line)
            if m:
                return float(m.group(1))
        if "min/avg" in line or "rtt min/avg" in line:
            try:
                return float(line.split("=")[1].split("/")[1])
            except (IndexError, ValueError):
                pass
    return None

def ping_host(ip, timeout=2):
    if not ip or is_private_ip(ip):
        return None
    try:
        version = ipaddress.ip_address(ip.split("%")[0]).version
    except ValueError:
        return None
    cmd = (
        ["ping", "-6", "-c", "1", "-W", "1", ip]
        if version == 6
        else ["ping", "-c", "1", "-W", "1", ip]
    )
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    return parse_ping_ms(proc.stdout)

def measure_latencies(ips, max_hosts=18):
    unique = []
    seen = set()
    for ip in ips:
        if not ip or ip in seen:
            continue
        seen.add(ip)
        unique.append(ip)
        if len(unique) >= max_hosts:
            break
    results = {}
    if not unique:
        return results
    with ThreadPoolExecutor(max_workers=min(8, len(unique))) as pool:
        futures = {pool.submit(ping_host, ip): ip for ip in unique}
        for future in as_completed(futures, timeout=6):
            ip = futures[future]
            try:
                results[ip] = future.result()
            except Exception:
                results[ip] = None
    return results

def attach_latency(entry, latency_map):
    ip = entry.get("ip")
    if ip and ip in latency_map:
        entry["latencyMs"] = latency_map[ip]
        return
    ips = entry.get("ips") or []
    samples = [latency_map[i] for i in ips if i in latency_map and latency_map[i] is not None]
    entry["latencyMs"] = min(samples) if samples else None

hostname_cache = {}

def resolve_hostname(ip):
    if not ip or is_private_ip(ip):
        return ""
    if ip in hostname_cache:
        return hostname_cache[ip]
    host = run(["redis-cli", "hget", f"host:ext.x509:{ip}", "server_name"], timeout=2)
    if not host:
        host = run(["redis-cli", "hget", f"host:ext.x509:{ip}", "host"], timeout=2)
    hostname_cache[ip] = host or ""
    return hostname_cache[ip]

def enrich_remote(remote, host="", service=""):
    ip, port = split_remote(remote)
    hostname = host or resolve_hostname(ip)
    scope = "local" if is_private_ip(ip) else "wan"
    label = hostname or ip or remote
    return {
        "remote": remote,
        "ip": ip,
        "port": port,
        "hostname": hostname,
        "label": label,
        "service": service,
        "scope": scope,
    }

def discover_ipv6(mac, dev):
    if not mac:
        return ""
    want = mac.lower()
    out = run(["ip", "-6", "neigh", "show", "dev", dev], timeout=4)
    for line in out.splitlines():
        if "lladdr" not in line:
            continue
        parts = line.split()
        ip6 = parts[0]
        try:
            lladdr = parts[parts.index("lladdr") + 1].lower()
        except (ValueError, IndexError):
            continue
        if lladdr == want and not ip6.startswith("fe80:"):
            return ip6
    return ""

def addr_match(value, addrs):
    if not value:
        return False
    base = value.split("%")[0]
    return base in addrs

def parse_conn_key(key):
    m = re.match(r"^conn:(tcp|udp):", key)
    if not m:
        return None
    proto = m.group(1)
    for addr in sorted(target_addrs, key=len, reverse=True):
        prefix = f"conn:{proto}:{addr}:"
        if not key.startswith(prefix):
            continue
        tail = key[len(prefix):]
        rport_m = re.search(r":(\d+)$", tail)
        if not rport_m:
            continue
        remote_port = rport_m.group(1)
        mid = tail[: rport_m.start()]
        lpm = re.match(r"^(\d+):(.+)$", mid)
        if not lpm:
            continue
        local_port, remote_ip = lpm.group(1), lpm.group(2)
        direction = "out"
        return {
            "proto": proto,
            "state": "tracked",
            "local": f"{addr}:{local_port}",
            "remote": f"{remote_ip}:{remote_port}",
            "direction": direction,
        }
    return None

def parse_tcpdump_endpoint(raw):
    raw = raw.rstrip(":")
    if "." in raw and ":" not in raw.split(".")[-1]:
        return raw.rsplit(".", 1)[0]
    if raw.count(":") > 1 and raw.rsplit(":", 1)[-1].isdigit():
        return raw.rsplit(":", 1)[0]
    return raw

target_ipv6 = discover_ipv6(xbox_mac, lan)
target_addrs = [target_ip]
if target_ipv6:
    target_addrs.append(target_ipv6)

now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
online = ping_ok(target_ip) or bool(target_ipv6)

arp_line = run(["ip", "neigh", "show", target_ip, "dev", lan])
arp_parts = arp_line.split()
arp_mac = arp_parts[4] if len(arp_parts) >= 5 else ""
arp_state = arp_parts[5] if len(arp_parts) >= 6 else ""

def redis_hgetall(key):
    out = run(["redis-cli", "hgetall", key], timeout=3)
    if not out:
        return {}
    lines = out.splitlines()
    data = {}
    for i in range(0, len(lines) - 1, 2):
        data[lines[i]] = lines[i + 1]
    return data

connections = []
seen = set()
for addr in target_addrs:
    keys_out = run(["redis-cli", "--scan", "--pattern", f"conn:*{addr}*"], timeout=8)
    for key in keys_out.splitlines():
        if not key or key.startswith("conn:dns:") or key in seen:
            continue
        seen.add(key)
        parsed = parse_conn_key(key)
        if not parsed:
            continue
        meta = redis_hgetall(key)
        parsed["host"] = meta.get("host", "")
        parsed["service"] = meta.get("proto", "")
        info = enrich_remote(parsed["remote"], parsed["host"], parsed["service"])
        parsed.update(info)
        connections.append(parsed)

grep_re = "|".join(re.escape(addr) for addr in target_addrs)
if lim["conntrack"]:
    ct_out = run(["bash", "-lc", f"sudo conntrack -L 2>/dev/null | grep -E '{grep_re}'"], timeout=10)
    for line in ct_out.splitlines():
        if not any(addr in line for addr in target_addrs):
            continue
        parts = line.split()
        if not parts or parts[0] in ("icmp", "unknown"):
            continue
        proto = parts[0]
        state = parts[3] if len(parts) > 3 else ""
        fields = {}
        for token in parts[4:]:
            if "=" in token:
                k, v = token.split("=", 1)
                fields[k] = v
        src = fields.get("src", "")
        dst = fields.get("dst", "")
        sport = fields.get("sport", "")
        dport = fields.get("dport", "")
        if addr_match(src, target_addrs):
            remote = f"{dst}:{dport}"
            direction = "out"
            local = f"{src}:{sport}"
        elif addr_match(dst, target_addrs):
            remote = f"{src}:{sport}"
            direction = "in"
            local = f"{dst}:{dport}"
        else:
            continue
        dedupe = (proto, local, remote, state)
        if dedupe in seen:
            continue
        seen.add(dedupe)
        info = enrich_remote(remote)
        connections.append({
            "proto": proto,
            "state": state,
            "local": local,
            "remote": remote,
            "direction": direction,
            "host": info["hostname"],
            "service": "",
            **info,
        })

dns_destinations = []
dns_by_host = {}
if xbox_mac:
    dns_keys = run(["redis-cli", "--scan", "--pattern", f"conn:dns:{xbox_mac}:*"], timeout=8)
    for key in dns_keys.splitlines():
        if not key:
            continue
        meta = redis_hgetall(key)
        ip = meta.get("ip", "")
        host = meta.get("host", "")
        if not ip:
            continue
        info = enrich_remote(f"{ip}", host, meta.get("proto", "dns"))
        if info["scope"] != "wan":
            continue
        label = host or info["hostname"] or ip
        bucket = dns_by_host.setdefault(label, {
            "kind": "dns",
            "label": label,
            "hostname": host or info["hostname"],
            "ips": [],
            "proto": "dns",
            "state": "resolved",
            "service": meta.get("proto", "dns"),
        })
        if ip not in bucket["ips"]:
            bucket["ips"].append(ip)
    dns_destinations = list(dns_by_host.values())

recent_flows = []
if lim["redis_flows"] > 0:
    for addr in target_addrs:
        for direction, zkey in (("out", f"flow:conn:out:{addr}"), ("in", f"flow:conn:in:{addr}")):
            rows = run(["redis-cli", "zrevrange", zkey, "0", str(lim["redis_flows"])], timeout=4)
            for row in rows.splitlines():
                if not row.strip():
                    continue
                try:
                    flow = json.loads(row)
                except json.JSONDecodeError:
                    continue
                remote = flow.get("sh") or flow.get("dh") or flow.get("lh") or "?"
                if addr_match(str(remote), target_addrs):
                    remote = flow.get("dh") or flow.get("sh") or "?"
                info = enrich_remote(str(remote))
                recent_flows.append({
                    "direction": direction,
                    "remote": str(remote),
                    "upload": flow.get("ob", 0),
                    "download": flow.get("rb", 0),
                    "duration": flow.get("du", 0),
                    "timestamp": flow.get("_ts", 0),
                    "hostname": info["hostname"],
                    "label": info["label"],
                    "ip": info["ip"],
                    "scope": info["scope"],
                })

connections.sort(key=lambda c: (0 if c.get("state") == "ESTABLISHED" else 1, c.get("scope") != "wan", c.get("label", "")))

destinations = []
dest_seen = set()

def add_destination(entry):
    key = (entry.get("kind"), entry.get("label"), entry.get("ip"), entry.get("remote", ""))
    if key in dest_seen:
        return
    dest_seen.add(key)
    destinations.append(entry)

for conn in connections:
    if conn.get("scope") != "wan":
        continue
    add_destination({
        "kind": "active",
        "label": conn.get("label") or conn.get("remote"),
        "hostname": conn.get("hostname", ""),
        "ip": conn.get("ip", ""),
        "port": conn.get("port", ""),
        "proto": conn.get("proto", ""),
        "state": conn.get("state", ""),
        "service": conn.get("service", ""),
        "remote": conn.get("remote", ""),
    })

for flow in recent_flows:
    if flow.get("scope") != "wan":
        continue
    add_destination({
        "kind": "recent",
        "label": flow.get("label") or flow.get("remote"),
        "hostname": flow.get("hostname", ""),
        "ip": flow.get("ip", ""),
        "proto": "flow",
        "state": "recent",
        "upload": flow.get("upload", 0),
        "download": flow.get("download", 0),
    })

for dns in dns_destinations:
    ips = dns.get("ips") or []
    add_destination({
        "kind": "dns",
        "label": dns.get("label"),
        "hostname": dns.get("hostname", ""),
        "ip": ips[0] if ips else "",
        "ips": ips[:6],
        "ipCount": len(ips),
        "proto": "dns",
        "state": "resolved",
        "service": dns.get("service", "dns"),
    })

destinations.sort(key=lambda d: ({"active": 0, "recent": 1, "dns": 2}.get(d.get("kind"), 9), d.get("label", "")))

sample_packets = 0
sample_bytes = 0
sample_in = 0
sample_out = 0
flow_map = {}

if online and lim["tcpdump"]:
    host_filter = " or ".join(f"host {addr}" for addr in target_addrs)
    tcpdump_cmd = ["sudo", "-n", "tcpdump", "-ni", lan, "-q", "-c", "250", host_filter]
    try:
        proc = subprocess.run(
            tcpdump_cmd, capture_output=True, text=True, timeout=5, check=False
        )
        dump_lines = proc.stdout.splitlines()
    except Exception:
        dump_lines = []

    for line in dump_lines:
        is_v4 = " IP " in line
        is_v6 = " IP6 " in line
        if not is_v4 and not is_v6:
            continue
        parts = line.split()
        if len(parts) < 6:
            continue
        src = parse_tcpdump_endpoint(parts[2])
        dst = parse_tcpdump_endpoint(parts[4])
        try:
            length = int(parts[-1])
        except ValueError:
            length = 0
        sample_packets += 1
        sample_bytes += length
        if addr_match(src, target_addrs):
            sample_out += length
            key = ("out", dst)
        elif addr_match(dst, target_addrs):
            sample_in += length
            key = ("in", src)
        else:
            continue
        flow_map[key] = flow_map.get(key, 0) + length

top_flows = sorted(
    [
        {
            "direction": d,
            "endpoint": ep,
            "bytes": b,
            **enrich_remote(parse_tcpdump_endpoint(ep)),
        }
        for (d, ep), b in flow_map.items()
    ],
    key=lambda x: x["bytes"],
    reverse=True,
)[:15]

ping_targets = []
if lim["ping"] > 0:
    for conn in connections:
        if conn.get("scope") == "wan" and conn.get("ip"):
            ping_targets.append(conn["ip"])
    for item in top_flows:
        if item.get("scope") == "wan" and item.get("ip"):
            ping_targets.append(item["ip"])
    for dest in destinations:
        if dest.get("kind") == "active" and dest.get("ip"):
            ping_targets.append(dest["ip"])
        elif dest.get("kind") == "dns":
            ips = dest.get("ips") or ([dest["ip"]] if dest.get("ip") else [])
            if ips:
                ping_targets.append(ips[0])
    ping_targets = list(dict.fromkeys(ping_targets))[: lim["ping"]]

latency_map = measure_latencies(ping_targets) if ping_targets else {}
for conn in connections:
    attach_latency(conn, latency_map)
for dest in destinations:
    attach_latency(dest, latency_map)
for item in top_flows:
    attach_latency(item, latency_map)
for flow in recent_flows:
    attach_latency(flow, latency_map)

destinations.sort(
    key=lambda d: (
        {"active": 0, "recent": 1, "dns": 2}.get(d.get("kind"), 9),
        d.get("latencyMs") if d.get("latencyMs") is not None else 9999,
        d.get("label", ""),
    )
)

cake_upload = run(["tc", "qdisc", "show", "dev", upload_if]).splitlines()
cake_download = run(["tc", "qdisc", "show", "dev", download_if]).splitlines()
cake_upload = next((l for l in cake_upload if "cake" in l), "")
cake_download = next((l for l in cake_download if "cake" in l), "")


def normalize_mac(mac):
    return (mac or "").upper().replace("-", ":")


def redis_hget(key, field):
    out = run(["redis-cli", "HGET", key, field], timeout=3)
    return out.strip() if out else ""


def detect_gaming_mode(mac):
    """Read Firewalla device QoS policies (e.g. 569/570) scoped to Xbox MAC."""
    import os

    legacy = f"{tools_dir}/.gaming-mode.state"
    if os.path.isfile(legacy):
        return "on", "companion-state"

    norm_mac = normalize_mac(mac)
    if not norm_mac:
        return "unknown", "no-mac-configured"

    policy_keys = run(["redis-cli", "--scan", "--pattern", "policy:*"], timeout=12).splitlines()
    upload_qos = False
    download_qos = False
    pids = []

    for key in policy_keys:
        if not key.startswith("policy:"):
            continue
        pid = key.rsplit(":", 1)[-1]
        if not pid.isdigit():
            continue
        if redis_hget(key, "action") != "qos":
            continue
        disabled = redis_hget(key, "disabled")
        if disabled not in ("0", ""):
            continue
        scope = redis_hget(key, "scope")
        if norm_mac not in scope.upper():
            continue
        direction = redis_hget(key, "trafficDirection")
        pids.append(pid)
        if direction == "upload":
            upload_qos = True
        elif direction == "download":
            download_qos = True

    if upload_qos and download_qos:
        return "on", f"firewalla-qos {','.join(sorted(set(pids)))}"
    if upload_qos or download_qos:
        return "partial", f"firewalla-qos-one-way {','.join(sorted(set(pids)))}"

    traffic_state = f"{tools_dir}/.traffic-profile.state"
    if os.path.isfile(traffic_state):
        try:
            with open(traffic_state, encoding="utf-8") as f:
                for line in f:
                    if line.startswith("profile="):
                        profile = line.split("=", 1)[1].strip()
                        if profile and profile != "balanced":
                            return "on", f"companion-{profile}"
        except OSError:
            pass

    return "off", "firewalla-qos-inactive"


gaming_mode, gaming_mode_detail = detect_gaming_mode(xbox_mac)

wan_latency_ms = None
if wan_probe_host:
    ping_out = run(["ping", "-c", "1", "-W", "2", wan_probe_host], timeout=4)
    for line in ping_out.splitlines():
        if "min/avg" in line or "rtt min/avg" in line:
            try:
                wan_latency_ms = float(line.split("=")[1].split("/")[1])
            except (IndexError, ValueError):
                pass

conn_slice = connections[: lim["conn"]]
dest_slice = destinations[: lim["dest"]]
conn_items = [trim_conn(c) for c in conn_slice] if pressure_mode != "normal" else conn_slice[: lim["conn"]]

payload = {
    "timestamp": now,
    "preabstract": {
        "mode": pressure_mode,
        "memAvailableMb": mem_available_mb,
        "folded": pressure_mode != "normal",
        "wire": (
            "fld1"
            if pressure_mode == "critical" and wire_mode
            else ("gz1" if wire_mode else "json")
        ),
    },
    "xbox": {
        "name": xbox_name,
        "ip": target_ip,
        "ipv6": target_ipv6,
        "mac": xbox_mac,
        "online": online,
        "arpMac": arp_mac,
        "arpState": arp_state,
    },
    "sample": {
        "windowSec": 3 if lim["tcpdump"] else 0,
        "packets": sample_packets,
        "bytes": sample_bytes,
        "bytesIn": sample_in,
        "bytesOut": sample_out,
        "stack": "ipv4+ipv6" if lim["tcpdump"] else "skipped",
    },
    "connections": {
        "count": len(connections),
        "items": conn_items,
        "source": "redis+conntrack" if lim["conntrack"] else "redis",
    },
    "recentFlows": recent_flows[: lim["flows"]],
    "destinations": dest_slice if pressure_mode == "normal" else [],
    "topFlows": top_flows[: lim["top"]],
    "sqm": {
        "uploadQdisc": cake_upload,
        "downloadQdisc": cake_download,
        "gamingMode": gaming_mode,
        "gamingModeDetail": gaming_mode_detail,
    },
    "wan": {
        "latencyMs": wan_latency_ms,
    },
}

if pressure_mode != "normal":
    payload["connections"]["folded"] = [fold_conn_row(c) for c in conn_slice]
    payload["destinationsFolded"] = [fold_dest_row(d) for d in dest_slice]

text = json.dumps(payload, separators=(",", ":"))
if wire_mode:
    import base64
    import gzip

    if pressure_mode == "critical":
        print("FLD1:" + text)
    else:
        blob = gzip.compress(text.encode("utf-8"), compresslevel=6)
        print("GZ1:" + base64.b64encode(blob).decode("ascii"))
else:
    print(text)
PY
