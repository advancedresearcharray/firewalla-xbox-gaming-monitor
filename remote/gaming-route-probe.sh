#!/usr/bin/env bash
# Probe internet paths from Firewalla: ping all candidates (v4/v6), pick best, trace for bottlenecks.
set -euo pipefail

TOOLS_DIR="/home/pi/gaming-tools"
TARGETS_FILE="${1:-}"
MAX_HOPS="${MAX_HOPS:-18}"
MAX_TARGETS="${MAX_TARGETS:-16}"

exec python3 - "$MAX_HOPS" "$MAX_TARGETS" "$TOOLS_DIR" "$TARGETS_FILE" <<'PY'
import json
import os
import re
import socket
import subprocess
import sys
from datetime import datetime, timezone

max_hops = int(sys.argv[1])
max_targets = int(sys.argv[2])
tools_dir = sys.argv[3]
targets_file = sys.argv[4] if len(sys.argv) > 4 else ""

config_path = f"{tools_dir}/route-probes.json"
try:
    with open(config_path, encoding="utf-8") as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {"scoring": {}, "regionProbes": []}

scoring = cfg.get("scoring", {})
ping_samples = int(scoring.get("pingSamples", 3))
ping_tie_ms = float(scoring.get("pingTieBreakMs", 3))


def resolve_host(host):
    if not host:
        return []
    if re.match(r"^[0-9a-fA-F:.]+$", host):
        return [host]
    ips = []
    for family, addr in ((socket.AF_INET, host), (socket.AF_INET6, host)):
        try:
            for info in socket.getaddrinfo(addr, None, family, socket.SOCK_STREAM):
                ip = info[4][0]
                if ip not in ips:
                    ips.append(ip)
        except socket.gaierror:
            pass
    return ips[:4]


def ping_ip(ip, count=None):
    count = count or ping_samples
    is_v6 = ":" in ip
    cmd = (
        ["ping", "-6", "-c", str(count), "-W", "1", ip]
        if is_v6
        else ["ping", "-c", str(count), "-W", "1", ip]
    )
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=count + 4, check=False)
        if proc.returncode != 0:
            return None
        for line in proc.stdout.splitlines():
            if "min/avg/max" in line or "rtt min/avg/max" in line:
                part = line.split("=")[-1].strip().split()[0]
                return float(part.split("/")[0])
        m = re.search(r"time=([\d.]+)\s*ms", proc.stdout)
        if m:
            return float(m.group(1))
    except (subprocess.TimeoutExpired, ValueError):
        pass
    return None


def run_traceroute(ip):
    is_v6 = ":" in ip
    cmd = [
        "traceroute",
        "-6" if is_v6 else "-4",
        "-n",
        "-w", "1",
        "-q", "1",
        "-m", str(max_hops),
        ip,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=35, check=False)
        return proc.stdout
    except subprocess.TimeoutExpired:
        return ""


def parse_traceroute(text):
    hops = []
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r"^\s*(\d+)\s+(.+)$", line)
        if not m:
            continue
        hop_num = int(m.group(1))
        rest = m.group(2)
        if rest.strip() == "*":
            hops.append({"hop": hop_num, "ip": None, "timeout": True, "rttMs": None})
            continue
        parts = rest.split()
        ip = parts[0]
        rtt = None
        for i, token in enumerate(parts[1:]):
            if token.endswith("ms"):
                try:
                    rtt = float(token.replace("ms", ""))
                    break
                except ValueError:
                    pass
            if token.replace(".", "", 1).isdigit() and i + 2 < len(parts) and parts[i + 2] == "ms":
                try:
                    rtt = float(token)
                    break
                except ValueError:
                    pass
        hops.append({"hop": hop_num, "ip": ip, "timeout": False, "rttMs": rtt})
    return hops


def hop_deltas(hops):
    deltas = []
    prev = 0.0
    for h in hops:
        if h.get("timeout") or h.get("rttMs") is None:
            continue
        rtt = h["rttMs"]
        deltas.append({"hop": h["hop"], "ip": h["ip"], "deltaMs": round(rtt - prev, 2), "rttMs": rtt})
        prev = rtt
    return deltas


def bottleneck(hops):
    deltas = hop_deltas(hops)
    if not deltas:
        return None
    worst = max(deltas, key=lambda d: d["deltaMs"])
    if worst["deltaMs"] < 2.0:
        return None
    return worst


def composite_score(ping_ms, hops, bn=None):
    hop_w = float(scoring.get("hopWeightMs", 0.8))
    to_p = float(scoring.get("timeoutPenaltyMs", 12))
    bn_w = float(scoring.get("bottleneckWeightMs", 1.2))
    if ping_ms is None:
        ping_ms = 999.0
    valid = [h for h in hops if not h.get("timeout") and h.get("rttMs") is not None]
    timeouts = sum(1 for h in hops if h.get("timeout"))
    bn_delta = bn.get("deltaMs", 0) if bn else 0
    return round(ping_ms + len(valid) * hop_w + timeouts * to_p + bn_delta * bn_w, 2)


def efficiency_label(ping_ms, hops):
    if ping_ms is None or ping_ms >= 900:
        return "unknown"
    hop_n = len([h for h in hops if not h.get("timeout")])
    if ping_ms <= 25 and hop_n <= 12:
        return "excellent"
    if ping_ms <= 45:
        return "good"
    if ping_ms <= 80:
        return "fair"
    return "poor"


def probe_path_ping_only(ip):
    ping_ms = ping_ip(ip)
    return {
        "ip": ip,
        "stack": "ipv6" if ":" in ip else "ipv4",
        "pingMs": ping_ms,
        "score": ping_ms if ping_ms is not None else 9999,
        "efficiency": efficiency_label(ping_ms, []),
        "hops": [],
        "hopCount": None,
        "bottleneck": None,
        "traceRttMs": None,
    }


def enrich_with_trace(candidate):
    out = run_traceroute(candidate["ip"])
    hops = parse_traceroute(out)
    valid = [h for h in hops if not h.get("timeout") and h.get("rttMs") is not None]
    bn = bottleneck(hops)
    trace_rtt = valid[-1]["rttMs"] if valid else None
    ping_ms = candidate["pingMs"]
    rtt = ping_ms or trace_rtt
    candidate.update({
        "hops": hops,
        "hopCount": len(valid) or len(hops),
        "bottleneck": bn,
        "traceRttMs": trace_rtt,
        "score": composite_score(rtt, hops, bn),
        "efficiency": efficiency_label(rtt, hops),
    })
    return candidate


def probe_target(ips):
    candidates = [probe_path_ping_only(ip) for ip in ips]
    chosen, ranked = choose_best_path(candidates)
    if not chosen:
        return None, ranked
    enrich_with_trace(chosen)
    for c in ranked:
        if not c["chosen"]:
            c["score"] = c["pingMs"] if c["pingMs"] is not None else 9999
            c["efficiency"] = efficiency_label(c["pingMs"], [])
    return chosen, ranked


def choose_best_path(candidates):
    ranked = sorted(
        candidates,
        key=lambda c: (
            c["pingMs"] if c["pingMs"] is not None else 9999,
            c["score"],
        ),
    )
    if not ranked:
        return None, []
    best_ping = ranked[0]["pingMs"]
    # Among paths within tie threshold of best ping, pick lowest composite score.
    close = [c for c in ranked if c["pingMs"] is not None and c["pingMs"] <= best_ping + ping_tie_ms]
    chosen = min(close or ranked, key=lambda c: c["score"])
    for c in ranked:
        c["chosen"] = c["ip"] == chosen["ip"]
    return chosen, ranked


def load_targets():
    if targets_file and os.path.isfile(targets_file):
        with open(targets_file, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("targets", [])
    targets = []
    for probe in cfg.get("regionProbes", []):
        targets.append({
            "label": probe.get("region"),
            "hostname": probe.get("hostname"),
            "role": "region-probe",
            "region": probe.get("region"),
            "purpose": probe.get("purpose"),
            "id": probe.get("id"),
        })
    for probe in cfg.get("gameProbes", []):
        targets.append({
            "label": probe.get("label"),
            "hostname": probe.get("hostname"),
            "role": "game-probe",
            "game": probe.get("game"),
            "region": probe.get("game"),
            "purpose": probe.get("purpose"),
            "id": probe.get("id"),
        })
    return targets


targets = load_targets()[:max_targets]
routes = []

for target in targets:
    host = target.get("hostname") or target.get("label") or target.get("ip")
    ips = [target["ip"]] if target.get("ip") else resolve_host(host)
    if not ips:
        routes.append({
            **target,
            "ip": None,
            "pingMs": None,
            "score": 9999,
            "efficiency": "unknown",
            "error": "dns-failed",
            "hops": [],
            "pathCandidates": [],
            "pathChosen": False,
        })
        continue

    candidates = [probe_path_ping_only(ip) for ip in ips]
    chosen, ranked = choose_best_path(candidates)
    if not chosen:
        routes.append({**target, "ip": None, "score": 9999, "efficiency": "unknown", "pathCandidates": []})
        continue

    enrich_with_trace(chosen)
    for c in ranked:
        if not c["chosen"]:
            c["score"] = c["pingMs"] if c["pingMs"] is not None else 9999
            c["efficiency"] = efficiency_label(c["pingMs"], [])

    alt = [c for c in ranked if not c["chosen"]]
    path_note = None
    if alt and chosen.get("pingMs") is not None:
        worst = max(alt, key=lambda c: c["pingMs"] or 0)
        if worst.get("pingMs") and worst["pingMs"] - chosen["pingMs"] >= 5:
            path_note = (
                f"Chose {chosen['stack']} ({chosen['pingMs']:.1f} ms) over "
                f"{worst['stack']} ({worst['pingMs']:.1f} ms)"
            )

    routes.append({
        **target,
        "ip": chosen["ip"],
        "stack": chosen["stack"],
        "pingMs": chosen["pingMs"],
        "finalRttMs": chosen["pingMs"] or chosen.get("traceRttMs"),
        "traceRttMs": chosen.get("traceRttMs"),
        "hops": chosen["hops"],
        "hopCount": chosen["hopCount"],
        "bottleneck": chosen["bottleneck"],
        "score": chosen["score"],
        "efficiency": chosen["efficiency"],
        "pathChosen": True,
        "pathNote": path_note,
        "pathCandidates": [
            {
                "ip": c["ip"],
                "stack": c["stack"],
                "pingMs": c["pingMs"],
                "score": c["score"],
                "efficiency": c["efficiency"],
                "chosen": c["chosen"],
            }
            for c in ranked
        ],
    })

region_routes = [r for r in routes if r.get("role") == "region-probe" and r.get("pingMs") is not None]
game_routes = [r for r in routes if r.get("role") == "game-probe" and r.get("pingMs") is not None]
live_routes = [r for r in routes if r.get("role") not in ("region-probe", "game-probe") and r.get("pingMs") is not None]

region_ranking = sorted(
    region_routes,
    key=lambda r: (r.get("pingMs") or 9999, r.get("score") or 9999),
)

best_region = region_ranking[0] if region_ranking else None
best_live = min(live_routes, key=lambda r: (r.get("pingMs") or 9999, r.get("score") or 9999)) if live_routes else None

recommendations = []
if best_region:
    rank_detail = ", ".join(
        f"{r.get('region')} {r.get('pingMs'):.0f}ms" for r in region_ranking[:4]
    )
    recommendations.append({
        "type": "region",
        "priority": "high",
        "title": f"Best datacenter path: {best_region.get('region')}",
        "detail": (
            f"{best_region.get('pingMs'):.1f} ms ping, {best_region.get('hopCount')} hops via {best_region.get('stack')} — "
            f"prefer this region for matchmaking. Ranking: {rank_detail}"
        ),
        "hostname": best_region.get("hostname"),
        "region": best_region.get("region"),
    })

if len(region_ranking) >= 2:
    worst = region_ranking[-1]
    if worst.get("pingMs") and best_region.get("pingMs"):
        delta = worst["pingMs"] - best_region["pingMs"]
        if delta >= 15:
            recommendations.append({
                "type": "region-avoid",
                "priority": "medium",
                "title": f"Avoid routing via {worst.get('region')}",
                "detail": f"{delta:.0f} ms slower than {best_region.get('region')} ({worst.get('pingMs'):.0f} ms vs {best_region.get('pingMs'):.0f} ms)",
            })

for game in ("warzone", "destiny2"):
    paths = [r for r in game_routes if r.get("game") == game]
    if not paths:
        continue
    best_game = min(paths, key=lambda r: (r.get("pingMs") or 9999, r.get("score") or 9999))
    title = "Warzone" if game == "warzone" else "Destiny 2"
    recommendations.append({
        "type": "game-path",
        "priority": "high",
        "title": f"{title} — best path: {best_game.get('label') or best_game.get('hostname')}",
        "detail": (
            f"{best_game.get('pingMs'):.1f} ms via {best_game.get('stack')} "
            f"({best_game.get('hopCount') or '?'} hops) — enforced for Xbox only"
        ),
        "hostname": best_game.get("hostname"),
        "game": game,
    })

for r in routes:
    if r.get("pathNote"):
        recommendations.append({
            "type": "path-choice",
            "priority": "medium",
            "title": f"Best internet path for {r.get('label') or r.get('hostname')}",
            "detail": r["pathNote"],
        })

if best_live and best_region and best_live.get("pingMs") and best_region.get("pingMs"):
    overhead = best_live["pingMs"] - best_region["pingMs"]
    if overhead >= 20 and best_live.get("roleId") in ("matchmaking", "game-server", None):
        recommendations.append({
            "type": "suboptimal",
            "priority": "high",
            "title": f"Live server path may be suboptimal: {best_live.get('label') or best_live.get('hostname')}",
            "detail": (
                f"{best_live.get('pingMs'):.0f} ms to live server vs {best_region.get('pingMs'):.0f} ms to best region "
                f"({best_region.get('region')}) — game may have placed you on a distant datacenter"
            ),
        })

for r in routes:
    bn = r.get("bottleneck")
    if bn and bn.get("deltaMs", 0) >= 6:
        recommendations.append({
            "type": "bottleneck",
            "priority": "low",
            "title": f"Backbone delay to {r.get('label') or r.get('hostname')}",
            "detail": f"Hop {bn['hop']} ({bn['ip']}) adds +{bn['deltaMs']} ms on the chosen path",
        })

priority_order = {"high": 0, "medium": 1, "low": 2}
recommendations.sort(key=lambda r: priority_order.get(r.get("priority"), 9))

wan_probe_host = cfg.get("wanProbeHost") or "one.one.one.one"
wan_ping = ping_ip(wan_probe_host, count=3)
wan_hops = parse_traceroute(run_traceroute(wan_probe_host))
wan_route = {
    "target": wan_probe_host,
    "pingMs": wan_ping,
    "hops": wan_hops,
    "score": composite_score(wan_ping, wan_hops, bottleneck(wan_hops)),
}

payload = {
    "timestamp": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
    "pathSelection": {
        "method": "ping-all-candidates-then-traceroute",
        "description": "Pings every resolved IPv4/IPv6 address, picks lowest-latency path, then traces hops for bottlenecks.",
    },
    "wanPath": wan_route,
    "routes": routes,
    "regionRanking": [
        {
            "rank": i + 1,
            "region": r.get("region"),
            "hostname": r.get("hostname"),
            "pingMs": r.get("pingMs"),
            "stack": r.get("stack"),
            "hopCount": r.get("hopCount"),
            "score": r.get("score"),
            "efficiency": r.get("efficiency"),
            "chosen": i == 0,
        }
        for i, r in enumerate(region_ranking)
    ],
    "bestRegion": best_region,
    "bestLiveRoute": best_live,
    "recommendations": recommendations[:8],
    "routingNote": "Paths ranked by live ping to each endpoint (IPv4 and IPv6 compared). Best region = lowest-latency datacenter route through the internet.",
}

print(json.dumps(payload, separators=(",", ":")))
PY
