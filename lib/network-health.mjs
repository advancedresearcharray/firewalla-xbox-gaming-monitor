import { buildRouteTargets, loadRouteProbesConfig } from "./routes.mjs";

export function buildMtuTargets(snapshot) {
  const config = loadRouteProbesConfig();
  const routeTargets = buildRouteTargets(snapshot, config);
  const targets = [];
  const seen = new Set();

  for (const item of routeTargets) {
    const key = item.hostname || item.ip || item.label;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    targets.push({
      label: item.label || item.hostname,
      hostname: item.hostname,
      ip: item.ip,
      game: item.game,
      region: item.region,
    });
  }

  return { targets: targets.slice(0, 12) };
}

export function mergeNetworkHealth(snapshot, health) {
  if (!health) return snapshot;
  return { ...snapshot, networkHealth: health };
}

export function networkHealthSummary(health) {
  if (!health) return null;
  const nat = health.nat || {};
  const mtu = health.mtu || {};
  const offload = health.offload || {};
  const offSum = offload.summary || {};
  return {
    natType: nat.natType || "unknown",
    xboxNatEquivalent: nat.xboxNatEquivalent || "Unknown",
    natHealthy: Boolean(nat.healthy),
    doubleNat: Boolean(nat.wan?.doubleNat),
    mtuLowest: mtu.summary?.lowestMtu ?? null,
    mtuRiskCount: mtu.summary?.fragmentationRiskCount ?? 0,
    offloadScore: offSum.overallScore ?? null,
    offloadStatus: offSum.status || "unknown",
    issues: [
      ...(nat.issues || []),
      mtu.recommendation,
      ...(offSum.issues || []),
    ].filter(Boolean),
  };
}
