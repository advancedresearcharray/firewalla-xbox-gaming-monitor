"""Classify Firewalla snapshot flows — raw API lacks roleId; gaming monitor would add this."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_ROLES: dict | None = None


def _load_roles() -> dict:
    global _ROLES
    if _ROLES is not None:
        return _ROLES
    path = Path(__file__).resolve().parents[1] / "data" / "server-roles.json"
    _ROLES = json.loads(path.read_text())
    return _ROLES


def classify_host(hostname: str) -> str:
    host = (hostname or "").lower().strip()
    if not host:
        return "unknown"
    for rule in _load_roles()["rules"]:
        if any(x in host for x in rule.get("matchExclude", [])):
            continue
        if any(p in host for p in rule["match"]):
            return rule["id"]
    return "unknown"


def _flow_hosts(snapshot: dict) -> list[str]:
    hosts: list[str] = []
    for key in ("recentFlows", "recent_flows"):
        for flow in snapshot.get(key) or []:
            h = flow.get("hostname") or flow.get("host") or flow.get("label") or ""
            if h and not h.replace(".", "").isdigit():
                hosts.append(h)
    for bucket in snapshot.get("dnsDestinations") or snapshot.get("dns_destinations") or []:
        h = bucket.get("hostname") or bucket.get("label") or ""
        if h:
            hosts.append(h)
    for item in snapshot.get("connections", {}).get("items", []):
        h = item.get("hostname") or item.get("host") or item.get("label") or ""
        if h and not h.replace(".", "").isdigit():
            hosts.append(h)
    return hosts


def enrich_snapshot(snapshot: dict) -> dict:
    """Return snapshot with roleCounts + inferred phase/game from netbot flow hostnames."""
    if not snapshot or snapshot.get("error"):
        return snapshot

    role_counts: dict[str, int] = {}
    classified: list[dict[str, Any]] = []
    for host in _flow_hosts(snapshot):
        rid = classify_host(host)
        role_counts[rid] = role_counts.get(rid, 0) + 1
        if rid != "unknown":
            classified.append({"hostname": host, "roleId": rid})

    xbox_online = bool((snapshot.get("xbox") or {}).get("online"))
    conns = int(snapshot.get("connections", {}).get("count") or 0)

    game = "unknown"
    if role_counts.get("warzone-game") or role_counts.get("game-assets") or role_counts.get("telemetry"):
        game = "warzone"
    elif role_counts.get("xbox-live") and xbox_online:
        game = "warzone"

    phase = "idle"
    if role_counts.get("warzone-game"):
        phase = "in-match"
    elif role_counts.get("matchmaking") or (role_counts.get("azure-qos", 0) >= 2 and conns >= 80):
        phase = "matchmaking"
    elif game == "warzone" and xbox_online and conns >= 20 and (
        role_counts.get("game-assets") or role_counts.get("telemetry")
    ):
        # In-match UDP often lacks hostnames in netbot flows; CoD CDN + lower conn fan-out = in game.
        phase = "in-match"
    elif xbox_online and conns >= 40 and (role_counts.get("xbox-live") or role_counts.get("game-assets")):
        phase = "matchmaking"
    elif xbox_online and conns >= 15:
        phase = "background"
    elif not xbox_online and conns == 0:
        phase = "idle"

    out = dict(snapshot)
    out["_enriched"] = {
        "roleCounts": role_counts,
        "classified": classified[:20],
        "phase": phase,
        "game": game,
    }
    return out
