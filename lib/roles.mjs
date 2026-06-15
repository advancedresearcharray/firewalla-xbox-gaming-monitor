import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROLES_PATH = path.join(__dirname, "..", "data", "server-roles.json");

let rolesConfig = null;

function loadRoles() {
  if (rolesConfig) return rolesConfig;
  rolesConfig = JSON.parse(readFileSync(ROLES_PATH, "utf8"));
  return rolesConfig;
}

function unknownRole(config) {
  return {
    roleId: "unknown",
    role: "Unknown",
    tier: "normal",
    tierLabel: config.tiers.normal.label,
    detail: "Unclassified destination",
    dscp: config.tiers.normal.dscp,
  };
}

export function classifyHost(hostname, config = loadRoles()) {
  const host = (hostname || "").toLowerCase().trim();
  if (!host) return unknownRole(config);

  for (const rule of config.rules) {
    const excluded = (rule.matchExclude || []).some((x) => host.includes(x));
    if (excluded) continue;
    if (rule.match.some((pattern) => host.includes(pattern))) {
      const tier = rule.tier;
      const tierInfo = config.tiers[tier] || config.tiers.normal;
      return {
        roleId: rule.id,
        role: rule.role,
        tier,
        tierLabel: tierInfo.label,
        detail: rule.detail,
        dscp: tierInfo.dscp,
      };
    }
  }

  return {
    roleId: "unknown",
    role: "Other internet",
    tier: "normal",
    tierLabel: config.tiers.normal.label,
    detail: "No matching rule — treated as normal priority",
    dscp: config.tiers.normal.dscp,
  };
}

export function applyProfile(classification, profileName, config = loadRoles()) {
  const profile = config.profiles[profileName] || config.profiles.balanced;
  const overrides = profile.overrides || {};
  const tier =
    overrides[classification.roleId] ??
    overrides[classification.tier] ??
    classification.tier;
  const tierInfo = config.tiers[tier] || config.tiers.normal;
  return {
    ...classification,
    effectiveTier: tier,
    effectiveTierLabel: tierInfo.label,
    effectiveDscp: tierInfo.dscp,
    profile: profileName,
  };
}

export function enrichSnapshot(snapshot, profileName = "balanced") {
  if (!snapshot) return snapshot;
  const config = loadRoles();
  const enrich = (item) => {
    const label = item.hostname || item.label || "";
    const base = classifyHost(label, config);
    const role =
      profileName === "balanced"
        ? { ...base, effectiveTier: base.tier, effectiveTierLabel: base.tierLabel, effectiveDscp: base.dscp }
        : applyProfile(base, profileName, config);
    return { ...item, ...role };
  };

  return {
    ...snapshot,
    trafficProfile: profileName,
    roleLegend: config.tiers,
    profileInfo: config.profiles[profileName],
    destinations: (snapshot.destinations || []).map(enrich),
    connections: {
      ...snapshot.connections,
      items: (snapshot.connections?.items || []).map(enrich),
    },
    topFlows: (snapshot.topFlows || []).map(enrich),
    recentFlows: (snapshot.recentFlows || []).map(enrich),
  };
}

export function ipsForQos(snapshot, profileName = "competitive") {
  const enriched = enrichSnapshot(snapshot, profileName);
  const seen = new Set();
  const ips = [];
  const lists = [
    enriched.destinations,
    enriched.connections?.items,
    enriched.topFlows,
  ];
  for (const list of lists) {
    for (const item of list || []) {
      const ip = item.ip;
      if (!ip || seen.has(ip) || item.scope === "local") continue;
      seen.add(ip);
      const effectiveTier = item.effectiveTier || item.tier;
      if (profileName !== "balanced" && effectiveTier === "normal") continue;
      ips.push({
        ip,
        tier: item.tier,
        effectiveTier,
        role: item.role,
        hostname: item.hostname || item.label,
      });
    }
  }
  return ips;
}

export function loadRolesConfig() {
  return loadRoles();
}

export function getProfiles() {
  return loadRoles().profiles;
}

export function applySuggestedRules(suggestions) {
  const config = loadRoles();
  let added = 0;
  for (const rule of suggestions || []) {
    const exists = config.rules.some((r) =>
      r.match.some((m) => rule.match?.includes(m)),
    );
    if (exists) continue;
    config.rules.push({
      id: rule.id || "ai-learned",
      match: rule.match,
      role: rule.role,
      tier: rule.tier,
      detail: rule.detail,
    });
    added += 1;
  }
  if (added > 0) {
    rolesConfig = config;
    writeFileSync(ROLES_PATH, JSON.stringify(config, null, 2));
  }
  return { added, total: config.rules.length };
}

export function rolesFileExists() {
  return existsSync(ROLES_PATH);
}
