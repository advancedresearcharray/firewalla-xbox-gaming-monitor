/**
 * Session advisor — local heuristics and learning only (no LLM).
 */

import {
  buildLearningInsights,
  suggestRoleRules,
  classifyHostnamePattern,
} from "./ai-learning.mjs";

function unknownHosts(snapshot, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const item of [
    ...(snapshot?.destinations || []),
    ...(snapshot?.connections?.items || []),
  ]) {
    const host = (item.hostname || item.label || "").toLowerCase();
    if (!host || item.roleId !== "unknown" || seen.has(host)) continue;
    seen.add(host);
    out.push({ hostname: host, port: item.port, ip: item.ip });
    if (out.length >= limit) break;
  }
  return out;
}

function detectSessionPhase(snapshot) {
  const items = snapshot?.connections?.items || [];
  const roles = items.map((i) => i.roleId).filter(Boolean);
  const counts = {};
  for (const r of roles) counts[r] = (counts[r] || 0) + 1;

  if ((counts["game-assets"] || 0) >= 2 && (counts.matchmaking || 0) === 0) {
    return { phase: "patch-download", confidence: "high", detail: "Heavy CDN/asset traffic — likely downloading or patching" };
  }
  if ((counts.matchmaking || 0) >= 1 || (counts["xbox-live"] || 0) >= 2) {
    return { phase: "matchmaking", confidence: "high", detail: "PlayFab / Xbox Live active — lobby or session setup" };
  }
  if (items.length >= 5 && (counts.telemetry || 0) / items.length < 0.4) {
    return { phase: "in-match", confidence: "medium", detail: "Multiple live connections with gameplay-weighted traffic mix" };
  }
  if (items.length === 0) {
    return { phase: "idle", confidence: "high", detail: "No active WAN connections tracked" };
  }
  return { phase: "background", confidence: "low", detail: "Mixed background Xbox services" };
}

function detectAnomalies(snapshot, routeAnalysis) {
  const anomalies = [];
  const phase = detectSessionPhase(snapshot).phase;

  for (const d of snapshot?.destinations || []) {
    if (d.roleId === "matchmaking" && d.routePathQuality === "suboptimal") {
      anomalies.push({
        type: "suboptimal-matchmaking",
        severity: "high",
        message: `Matchmaking server ${d.hostname} path looks suboptimal vs best datacenter`,
        action: "Run route probe and keep path enforcement enabled",
      });
    }
    if (d.latencyMs != null && d.latencyMs >= 80 && d.tier === "critical") {
      anomalies.push({
        type: "high-latency-critical",
        severity: "high",
        message: `${d.hostname} at ${d.latencyMs.toFixed(0)} ms — high for critical tier`,
        action: "Check route ranking; verify enforcement is blocking slow regions",
      });
    }
  }

  if (phase === "in-match") {
    const telemetry = (snapshot?.connections?.items || []).filter((i) => i.roleId === "telemetry");
    const crit = (snapshot?.connections?.items || []).filter((i) => i.tier === "critical");
    if (telemetry.length > crit.length) {
      anomalies.push({
        type: "telemetry-noise",
        severity: "medium",
        message: "Telemetry connections rival gameplay traffic during match",
        action: "Switch to Competitive profile to deprioritize telemetry",
      });
    }
  }

  const ranking = routeAnalysis?.regionRanking || [];
  if (ranking.length >= 2 && ranking[0]?.pingMs != null && ranking[ranking.length - 1]?.pingMs != null) {
    const spread = ranking[ranking.length - 1].pingMs - ranking[0].pingMs;
    if (spread >= 80) {
      anomalies.push({
        type: "region-spread",
        severity: "medium",
        message: `${spread.toFixed(0)} ms spread between best (${ranking[0].region}) and worst (${ranking[ranking.length - 1].region}) datacenter paths`,
        action: "Path enforcement helps avoid distant Azure probe regions",
      });
    }
  }

  return anomalies;
}

function buildSummary(recommendations) {
  return recommendations
    .filter((r) => r.priority !== "info")
    .slice(0, 4)
    .map((r) => `• ${r.title}: ${r.detail}`)
    .join("\n");
}

function heuristicRecommendations(snapshot, routeAnalysis, trafficProfile, enforcementConfig = {}) {
  const recs = [];
  const phase = detectSessionPhase(snapshot);
  const anomalies = detectAnomalies(snapshot, routeAnalysis);
  const learning = buildLearningInsights(snapshot, routeAnalysis, enforcementConfig);

  recs.push({
    source: "heuristic",
    title: `Session phase: ${phase.phase.replace(/-/g, " ")}`,
    detail: phase.detail,
    priority: "info",
  });

  if (learning.adaptiveThresholds?.source === "learned") {
    recs.push({
      source: "learning",
      title: "Adaptive route thresholds active",
      detail: `Path delta ${learning.adaptiveThresholds.slowPathDeltaMs} ms, region delta ${learning.adaptiveThresholds.slowRegionDeltaMs} ms (from ${learning.adaptiveThresholds.samples.regionSpread} probes)`,
      priority: "info",
    });
  }

  if (learning.lobbyPrediction?.risk === "high") {
    recs.push({
      source: "learning",
      title: "Bad lobby placement likely",
      detail: learning.lobbyPrediction.detail,
      priority: "high",
      action: { type: "route-enforce-on" },
    });
  } else if (learning.lobbyPrediction?.risk === "medium") {
    recs.push({
      source: "learning",
      title: "Lobby path warning",
      detail: learning.lobbyPrediction.detail,
      priority: "medium",
    });
  }

  for (const spike of learning.bandwidthSpikes || []) {
    recs.push({
      source: "learning",
      title: spike.message,
      detail: spike.detail,
      priority: spike.severity,
    });
  }

  for (const rule of (learning.roleRuleSuggestions || []).slice(0, 3)) {
    recs.push({
      source: "learning",
      title: `Suggest rule: ${rule.hostname}`,
      detail: `${rule.role} (${rule.tier}) — ${rule.detail}`,
      priority: "low",
      action: { type: "apply-rule", value: rule },
    });
  }

  if (phase.phase === "in-match" && trafficProfile === "balanced") {
    recs.push({
      source: "heuristic",
      title: "Enable Competitive profile",
      detail: "In-match traffic detected — Competitive boosts matchmaking and deprioritizes telemetry",
      priority: "high",
      action: { type: "traffic-profile", value: "competitive" },
    });
  }

  if (phase.phase === "patch-download" && trafficProfile !== "download") {
    recs.push({
      source: "heuristic",
      title: "Enable Download profile",
      detail: "CDN-heavy traffic — Download profile prioritizes game assets",
      priority: "medium",
      action: { type: "traffic-profile", value: "download" },
    });
  }

  if (!routeAnalysis?.regionRanking?.length) {
    recs.push({
      source: "heuristic",
      title: "Run route probe",
      detail: "No datacenter ranking yet — probe to pick best internet paths",
      priority: "medium",
      action: { type: "route-probe" },
    });
  }

  for (const a of anomalies) {
    recs.push({
      source: "heuristic",
      title: a.message,
      detail: a.action,
      priority: a.severity,
    });
  }

  const nh = snapshot?.networkHealth;
  if (nh?.nat?.wan?.doubleNat) {
    recs.push({
      source: "network-health",
      title: "Double NAT on Firewalla WAN",
      detail: `Upstream gateway ${nh.nat.wan.wanGateway || "?"} — Xbox NAT likely Moderate/Strict. Put Firewalla in bridge/DMZ or disable upstream router NAT.`,
      priority: "high",
    });
  }
  if (nh?.nat?.natType === "strict") {
    recs.push({
      source: "network-health",
      title: "Strict NAT estimated",
      detail: nh.nat.detail || "Enable UPnP or forward Xbox Live ports (3074 UDP/TCP)",
      priority: "high",
    });
  } else if (nh?.nat?.natType === "moderate") {
    recs.push({
      source: "network-health",
      title: "Moderate NAT estimated",
      detail: nh.nat.detail || "Consider port forwarding for Xbox Live if matchmaking is slow",
      priority: "medium",
    });
  }
  if (nh?.nat?.degraded) {
    recs.push({
      source: "network-health",
      title: `NAT degraded (${nh.nat.changedFrom} → ${nh.nat.natType})`,
      detail: "Check upstream router reboots, UPnP, or ISP changes",
      priority: "high",
    });
  }
  const mtuRisk = nh?.mtu?.summary?.fragmentationRiskCount || 0;
  if (mtuRisk > 0) {
    recs.push({
      source: "network-health",
      title: `${mtuRisk} path(s) with low MTU`,
      detail: nh.mtu.recommendation || "Fragmentation can add latency — check PPPoE/VPN overhead",
      priority: "medium",
      action: { type: "network-health-probe" },
    });
  }

  return { phase, anomalies, recommendations: recs, learning };
}

export function advisorStatus() {
  return { mode: "local", engine: "heuristics+learning" };
}

export function generateHeuristicInsights(snapshot, routeAnalysis = null, trafficProfile = "balanced", enforcementConfig = {}) {
  return heuristicRecommendations(snapshot, routeAnalysis, trafficProfile, enforcementConfig);
}

function classifyUnknownHosts(hosts) {
  return hosts
    .map((h) => {
      const guess = classifyHostnamePattern(h.hostname);
      if (!guess) return null;
      return { ...h, ...guess, source: "pattern" };
    })
    .filter(Boolean);
}

export function generateInsights(snapshot, routeAnalysis = null, trafficProfile = "balanced", enforcementConfig = {}) {
  const heuristics = heuristicRecommendations(snapshot, routeAnalysis, trafficProfile, enforcementConfig);
  const patternClassifications = classifyUnknownHosts(unknownHosts(snapshot));

  return {
    timestamp: new Date().toISOString(),
    advisor: advisorStatus(),
    sessionPhase: heuristics.phase,
    anomalies: heuristics.anomalies,
    learning: heuristics.learning,
    recommendations: heuristics.recommendations,
    patternClassifications,
    roleRuleSuggestions: suggestRoleRules(),
    summary: buildSummary(heuristics.recommendations),
  };
}

export function applyPatternClassifications(snapshot, classifications) {
  if (!classifications?.length) return snapshot;
  const byHost = new Map(classifications.map((c) => [c.hostname.toLowerCase(), c]));
  const merge = (item) => {
    const host = (item.hostname || item.label || "").toLowerCase();
    const guess = byHost.get(host);
    if (!guess || item.roleId !== "unknown") return item;
    return {
      ...item,
      roleId: guess.roleId,
      role: guess.role,
      tier: guess.tier,
      tierLabel: guess.tier,
      detail: `${guess.detail} (pattern)`,
      patternClassified: true,
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

// Back-compat aliases
export const aiStatus = advisorStatus;
export const applyAiClassifications = applyPatternClassifications;
