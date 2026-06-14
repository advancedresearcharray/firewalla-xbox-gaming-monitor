#!/usr/bin/env python3
"""Classify Xbox destination hostnames into gameplay roles and QoS tiers."""
import json
import sys
from pathlib import Path

ROLES_PATH = Path(__file__).resolve().parent.parent / "data" / "server-roles.json"
if not ROLES_PATH.exists():
    ROLES_PATH = Path("/opt/xbox-traffic-monitor/data/server-roles.json")

def load_roles():
    with open(ROLES_PATH, encoding="utf-8") as f:
        return json.load(f)

def classify_host(hostname, config=None):
    config = config or load_roles()
    host = (hostname or "").lower().strip()
    if not host:
        return {
            "roleId": "unknown",
            "role": "Unknown",
            "tier": "normal",
            "tierLabel": config["tiers"]["normal"]["label"],
            "detail": "Unclassified destination",
            "dscp": config["tiers"]["normal"]["dscp"],
        }

    for rule in config["rules"]:
        excluded = any(x in host for x in rule.get("matchExclude", []))
        if excluded:
            continue
        if any(pattern in host for pattern in rule["match"]):
            tier = rule["tier"]
            tier_info = config["tiers"].get(tier, config["tiers"]["normal"])
            return {
                "roleId": rule["id"],
                "role": rule["role"],
                "tier": tier,
                "tierLabel": tier_info["label"],
                "detail": rule["detail"],
                "dscp": tier_info["dscp"],
            }

    return {
        "roleId": "unknown",
        "role": "Other internet",
        "tier": "normal",
        "tierLabel": config["tiers"]["normal"]["label"],
        "detail": "No matching rule — treated as normal priority",
        "dscp": config["tiers"]["normal"]["dscp"],
    }

def apply_profile(classification, profile_name, config=None):
    config = config or load_roles()
    profile = config["profiles"].get(profile_name, config["profiles"]["balanced"])
    overrides = profile.get("overrides", {})
    role_id = classification.get("roleId")
    tier = overrides.get(role_id, overrides.get(classification.get("tier"), classification.get("tier")))
    tier_info = config["tiers"].get(tier, config["tiers"]["normal"])
    out = dict(classification)
    out["effectiveTier"] = tier
    out["effectiveTierLabel"] = tier_info["label"]
    out["effectiveDscp"] = tier_info["dscp"]
    out["profile"] = profile_name
    return out

if __name__ == "__main__":
    host = sys.argv[1] if len(sys.argv) > 1 else ""
    print(json.dumps(classify_host(host), indent=2))
