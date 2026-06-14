import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBES_PATH = path.join(__dirname, "..", "data", "route-probes.json");

export function loadRouteProbesConfig() {
  if (!existsSync(PROBES_PATH)) return { regionProbes: [], probeIntervalSec: 300 };
  return JSON.parse(readFileSync(PROBES_PATH, "utf8"));
}

export function buildRouteTargets(snapshot, config = loadRouteProbesConfig()) {
  const targets = [];
  const seen = new Set();

  for (const probe of config.regionProbes || []) {
    const key = probe.hostname;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      id: probe.id,
      label: probe.region,
      hostname: probe.hostname,
      role: "region-probe",
      region: probe.region,
      purpose: probe.purpose,
    });
  }

  const liveSources = [
    ...(snapshot?.destinations || []),
    ...(snapshot?.connections?.items || []),
  ];
  const live = [];
  for (const item of liveSources) {
    if (item.kind && item.kind !== "active") continue;
    if (item.scope === "local") continue;
    const host = item.hostname || item.label;
    const ip = item.ip;
    const key = ip || host;
    if (!key || seen.has(key)) continue;
    if (item.roleId === "telemetry" || item.roleId === "connectivity-probe") continue;
    seen.add(key);
    live.push({
      label: host,
      hostname: host,
      ip,
      role: item.role || "live-server",
      roleId: item.roleId,
      tier: item.tier,
    });
  }

  const maxTotal = config.maxTargetsPerRun || 10;
  const maxLive = config.maxLiveTargetsPerRun || 4;
  return [...targets, ...live.slice(0, maxLive)].slice(0, maxTotal);
}

export function buildRouteEnforcement(routeData, config = loadRouteProbesConfig()) {
  if (!routeData?.routes?.length) {
    return { blocked: [], allowed: [], bestRegion: null, stats: { blockedCount: 0 } };
  }

  const rules = config.enforcement || {};
  const pathDelta = rules.slowPathDeltaMs ?? 5;
  const regionDelta = rules.slowRegionDeltaMs ?? 35;
  const blocked = [];
  const blockedIps = new Set();

  const addBlock = (ip, entry) => {
    if (!ip || blockedIps.has(ip)) return;
    blockedIps.add(ip);
    blocked.push({ ip, ...entry });
  };

  for (const route of routeData.routes) {
    const candidates = route.pathCandidates || [];
    const chosen = candidates.find((c) => c.chosen) || { pingMs: route.pingMs, ip: route.ip };
    const chosenPing = chosen.pingMs ?? route.pingMs;
    if (chosenPing == null) continue;

    for (const alt of candidates) {
      if (alt.chosen || alt.pingMs == null) continue;
      if (alt.pingMs - chosenPing < pathDelta) continue;
      addBlock(alt.ip, {
        reason: "slow-path",
        hostname: route.hostname || route.label,
        region: route.region,
        stack: alt.stack,
        pingMs: alt.pingMs,
        chosenPingMs: chosenPing,
        chosenStack: chosen.stack || route.stack,
        detail: `${alt.stack} ${alt.pingMs.toFixed(1)} ms vs chosen ${chosenPing.toFixed(1)} ms`,
      });
    }
  }

  const ranking = routeData.regionRanking || [];
  const best = ranking.find((r) => r.chosen) || ranking[0];
  const bestPing = best?.pingMs;

  if (bestPing != null) {
    for (const row of ranking) {
      if (row.chosen || row.pingMs == null) continue;
      if (row.pingMs - bestPing < regionDelta) continue;
      const match = (routeData.routes || []).find(
        (r) => r.role === "region-probe" && r.region === row.region,
      );
      if (match?.ip) {
        addBlock(match.ip, {
          reason: "slow-region",
          hostname: match.hostname,
          region: row.region,
          stack: match.stack,
          pingMs: row.pingMs,
          chosenPingMs: bestPing,
          chosenRegion: best.region,
          detail: `${row.region} ${row.pingMs.toFixed(0)} ms vs best ${best.region} ${bestPing.toFixed(0)} ms`,
        });
      }
    }
  }

  const allowed = (routeData.routes || [])
    .filter((r) => r.ip && !blockedIps.has(r.ip))
    .map((r) => ({
      ip: r.ip,
      hostname: r.hostname || r.label,
      region: r.region,
      stack: r.stack,
      pingMs: r.pingMs,
    }));

  return {
    blocked,
    allowed,
    bestRegion: routeData.bestRegion?.region || best?.region || null,
    stats: {
      blockedCount: blocked.length,
      slowPathBlocks: blocked.filter((b) => b.reason === "slow-path").length,
      slowRegionBlocks: blocked.filter((b) => b.reason === "slow-region").length,
    },
  };
}

export function attachRouteToDestinations(snapshot, routeData) {
  if (!routeData?.routes?.length) return snapshot;
  const byIp = new Map();
  const byHost = new Map();
  for (const route of routeData.routes || []) {
    if (route.ip) byIp.set(route.ip, route);
    const h = (route.hostname || route.label || "").toLowerCase();
    if (h) byHost.set(h, route);
  }

  const merge = (item) => {
    const route =
      (item.ip && byIp.get(item.ip)) ||
      byHost.get((item.hostname || item.label || "").toLowerCase());
    if (!route) return item;
    const bestRegionPing = routeData.bestRegion?.pingMs;
    const pingMs = route.pingMs ?? route.finalRttMs;
    let pathQuality = null;
    if (pingMs != null && bestRegionPing != null && item.roleId === "matchmaking") {
      const delta = pingMs - bestRegionPing;
      pathQuality = delta <= 15 ? "optimal" : delta <= 35 ? "acceptable" : "suboptimal";
    }
    return {
      ...item,
      routeScore: route.score,
      routeEfficiency: route.efficiency,
      routeHops: route.hopCount,
      routePingMs: pingMs,
      routeFinalRttMs: route.finalRttMs ?? pingMs,
      routeBottleneck: route.bottleneck,
      routeStack: route.stack,
      routePathNote: route.pathNote,
      routePathQuality: pathQuality,
      routePathCandidates: route.pathCandidates,
    };
  };

  return {
    ...snapshot,
    destinations: (snapshot.destinations || []).map(merge),
    connections: {
      ...snapshot.connections,
      items: (snapshot.connections?.items || []).map(merge),
    },
  };
}

export function mergeRouteAnalysis(snapshot, routeData, enforcement = null) {
  const base = attachRouteToDestinations(snapshot, routeData);
  return {
    ...base,
    routeAnalysis: {
      timestamp: routeData.timestamp,
      pathSelection: routeData.pathSelection,
      wanPath: routeData.wanPath,
      bestRegion: routeData.bestRegion,
      bestLiveRoute: routeData.bestLiveRoute,
      regionRanking: routeData.regionRanking,
      recommendations: routeData.recommendations,
      routingNote: routeData.routingNote,
      routes: routeData.routes,
      enforcement,
    },
  };
}
